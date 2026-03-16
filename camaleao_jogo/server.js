'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpSv = http.createServer(app);
const io = new Server(httpSv);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/camaleao_jogo/public', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

// ── Word bank ─────────────────────────────────────────────────
const { loadWords, ALL_CATS } = require('./words/words');

const DEFAULT_CONFIG = {
  hintTime: 30,
  voteContinueTime: 60,
  voteEliminateTime: 120,
  maxPlayers: 10,
  categories: [...ALL_CATS],
  gameEndMode: 'rounds',
  maxRounds: 3,
  targetScore: 5,
  language: 'pt',
};

// ── Helpers ──────────────────────────────────────────────────
const randCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[b[i], b[j]] = [b[j], b[i]]; } return b; };

// ── Room store ───────────────────────────────────────────────
const rooms = {};  // code → room

function mkRoom(code, host) {
  return {
    code, hostId: host.id,
    status: 'lobby',
    players: [host],
    turnOrder: [],
    round: 0, currentTurn: 0,
    hints: [],
    voteCont: {}, voteCham: {},
    timerEnd: null,
    pair: null, camId: null,
    result: null,
    config: { ...DEFAULT_CONFIG },
    gamesPlayed: 0,
    matchOver: false,
    nextRoundIn: null,
    _t: null,
  };
}

function mkPlayer(id, name, emoji) {
  return { id, name, emoji, score: 0, word: '' };
}

// ── Broadcast (each player gets private word) ────────────────
function push(room) {
  const base = publicRoom(room);
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('state', { ...base, myId: p.id, myWord: p.word });
  }
}

function publicRoom(r) {
  return {
    code: r.code, hostId: r.hostId, status: r.status,
    round: r.round, currentTurn: r.currentTurn, turnOrder: r.turnOrder,
    hints: r.hints, timerEnd: r.timerEnd, result: r.result,
    config: r.config, gamesPlayed: r.gamesPlayed, matchOver: r.matchOver,
    nextRoundIn: r.nextRoundIn || null,
    pair: r.status === 'results' ? r.pair : null,
    camId: r.status === 'results' ? r.camId : null,
    players: r.players.map(p => ({
      id: p.id, name: p.name, emoji: p.emoji, score: p.score,
      votedCont: r.voteCont[p.id] !== undefined,
      votedCham: r.voteCham[p.id] !== undefined,
    })),
  };
}

// ── Timer helpers ────────────────────────────────────────────
function clearT(r) { if (r._t) { clearTimeout(r._t); r._t = null; } }
function startT(r, ms, fn) { clearT(r); r.timerEnd = Date.now() + ms; r._t = setTimeout(fn, ms); push(r); }

// ── Game logic ───────────────────────────────────────────────
function doStart(room) {
  const { WORD_PAIRS } = loadWords(room.config.language || 'pt');
  const pool = WORD_PAIRS.filter(p => room.config.categories.includes(p.cat));
  const source = pool.length ? pool : WORD_PAIRS;
  const pair = source[Math.floor(Math.random() * source.length)];
  room.pair = pair;
  room.hints = [];
  room.result = null;
  room.turnOrder = shuffle(room.players.map(p => p.id));
  room.camId = room.turnOrder[Math.floor(Math.random() * room.turnOrder.length)];
  for (const p of room.players) p.word = p.id === room.camId ? pair.cam : pair.normal;
  room.round = 0;
  room.status = 'word_reveal';
  startT(room, 12_000, () => beginHintRound(room));
}

function beginHintRound(room) {
  room.round++;
  room.currentTurn = 0;
  room.status = 'hint_round';
  room.voteCont = {};
  room.voteCham = {};
  doHintTurn(room);
}

function doHintTurn(room) {
  startT(room, room.config.hintTime * 1000, () => advanceTurn(room));
}

function advanceTurn(room) {
  room.currentTurn++;
  if (room.currentTurn >= room.turnOrder.length) {
    // Round complete
    if (room.round >= 2) { doVoteContinue(room); }
    else { beginHintRound(room); }
  } else {
    doHintTurn(room);
  }
}

function doVoteContinue(room) {
  room.status = 'vote_continue';
  room.voteCont = {};
  startT(room, room.config.voteContinueTime * 1000, () => resolveVoteContinue(room));
}

function resolveVoteContinue(room) {
  const votes = Object.values(room.voteCont);
  const voteCount = votes.filter(v => v === 'vote').length;
  const contCount = votes.filter(v => v === 'continue').length;
  if (voteCount > contCount) doVoteChameleon(room);
  else beginHintRound(room);
}

function checkAllVotedCont(room) {
  if (Object.keys(room.voteCont).length === room.players.length) {
    clearT(room); resolveVoteContinue(room);
  }
}

function doVoteChameleon(room) {
  room.status = 'vote_chameleon';
  room.voteCham = {};
  startT(room, room.config.voteEliminateTime * 1000, () => resolveVoteCham(room));
}

function resolveVoteCham(room) {
  const counts = {};
  for (const tid of Object.values(room.voteCham))
    counts[tid] = (counts[tid] || 0) + 1;

  let max = 0, winners = [];
  for (const [id, n] of Object.entries(counts)) {
    if (n > max) { max = n; winners = [id]; }
    else if (n === max) { winners.push(id); }
  }

  if (winners.length === 1) {
    const elim = winners[0];
    if (elim === room.camId) {
      // Caught! Correct voters get +1
      for (const p of room.players)
        if (room.voteCham[p.id] === room.camId) p.score++;
      room.result = { type: 'caught', eliminatedId: elim };
    } else {
      // Escaped – chameleon +1
      const cam = room.players.find(p => p.id === room.camId);
      if (cam) cam.score++;
      room.result = { type: 'escaped', eliminatedId: elim };
    }
  } else {
    // Tie – escaped
    const cam = room.players.find(p => p.id === room.camId);
    if (cam) cam.score++;
    room.result = { type: 'tie', eliminatedId: null };
  }
  room.status = 'results';
  room.gamesPlayed++;
  clearT(room);
  checkMatchEnd(room);

  if (!room.matchOver) {
    // Auto-advance to next round after NEXT_ROUND_DELAY seconds
    const NEXT_ROUND_DELAY = 8;
    room.nextRoundIn = Date.now() + NEXT_ROUND_DELAY * 1000;
    push(room);
    room._t = setTimeout(() => {
      room.nextRoundIn = null;
      doStart(room);
    }, NEXT_ROUND_DELAY * 1000);
  } else {
    room.nextRoundIn = null;
    push(room);
  }
}

function checkMatchEnd(room) {
  const cfg = room.config;
  if (cfg.gameEndMode === 'rounds') {
    room.matchOver = room.gamesPlayed >= cfg.maxRounds;
  } else {
    room.matchOver = room.players.some(p => p.score >= cfg.targetScore);
  }
}

function checkAllVotedCham(room) {
  if (Object.keys(room.voteCham).length === room.players.length) {
    clearT(room); resolveVoteCham(room);
  }
}

// ── Socket.io events ─────────────────────────────────────────
io.on('connection', socket => {

  socket.on('create-room', ({ name, emoji }) => {
    if (!name || !emoji) return;
    let code; do { code = randCode(); } while (rooms[code]);
    const player = mkPlayer(socket.id, name, emoji);
    rooms[code] = mkRoom(code, player);
    socket.join(code);
    socket.roomCode = code;
    push(rooms[code]);
  });

  socket.on('join-room', ({ code, name, emoji }) => {
    const r = rooms[code];
    if (!r) return socket.emit('err', 'Sala não encontrada.');
    if (r.status !== 'lobby') return socket.emit('err', 'O jogo já começou.');
    if (r.players.length >= r.config.maxPlayers) return socket.emit('err', `Sala cheia (máx ${r.config.maxPlayers}).`);
    if (r.players.find(p => p.id === socket.id)) return;
    r.players.push(mkPlayer(socket.id, name, emoji));
    socket.join(code);
    socket.roomCode = code;
    push(r);
  });

  socket.on('start-game', () => {
    const r = rooms[socket.roomCode];
    if (!r || r.hostId !== socket.id) return;
    if (r.players.length < 3) return socket.emit('err', 'Mínimo 3 jogadores.');
    if (r.status !== 'lobby') return;
    doStart(r);
  });

  // Host updates room config (lobby only)
  socket.on('set-config', (cfg) => {
    const r = rooms[socket.roomCode];
    if (!r || r.hostId !== socket.id || r.status !== 'lobby') return;
    const c = r.config;
    if (typeof cfg.hintTime === 'number') c.hintTime = Math.min(120, Math.max(10, cfg.hintTime));
    if (typeof cfg.voteContinueTime === 'number') c.voteContinueTime = Math.min(180, Math.max(20, cfg.voteContinueTime));
    if (typeof cfg.voteEliminateTime === 'number') c.voteEliminateTime = Math.min(300, Math.max(30, cfg.voteEliminateTime));
    if (typeof cfg.maxPlayers === 'number') c.maxPlayers = Math.min(10, Math.max(3, cfg.maxPlayers));
    if (Array.isArray(cfg.categories) && cfg.categories.length > 0) c.categories = cfg.categories.filter(x => ALL_CATS.includes(x));
    if (cfg.gameEndMode === 'rounds' || cfg.gameEndMode === 'points') c.gameEndMode = cfg.gameEndMode;
    if (typeof cfg.maxRounds === 'number') c.maxRounds = Math.min(20, Math.max(1, cfg.maxRounds));
    if (typeof cfg.targetScore === 'number') c.targetScore = Math.min(20, Math.max(1, cfg.targetScore));
    if (cfg.language === 'pt' || cfg.language === 'en' || cfg.language === 'es') c.language = cfg.language;
    push(r);
  });

  // Return to lobby keeping scores - only host can abort mid-match
  socket.on('return-to-lobby', () => {
    const r = rooms[socket.roomCode];
    if (!r || r.hostId !== socket.id) return;
    clearT(r);
    r.nextRoundIn = null;
    r.status = 'lobby';
    push(r);
  });

  // New match: reset everything (host only, from final podium)
  socket.on('new-match', () => {
    const r = rooms[socket.roomCode];
    if (!r || r.hostId !== socket.id) return;
    clearT(r);
    r.players.forEach(p => p.score = 0);
    r.gamesPlayed = 0;
    r.matchOver = false;
    r.nextRoundIn = null;
    r.status = 'lobby';
    push(r);
  });

  socket.on('submit-hint', ({ hint }) => {
    const r = rooms[socket.roomCode];
    if (!r || r.status !== 'hint_round') return;
    if (r.turnOrder[r.currentTurn] !== socket.id) return;
    const clean = hint.trim();
    if (!clean || /\s/.test(clean)) return socket.emit('err', 'Apenas uma palavra, sem espaços.');
    const p = r.players.find(p => p.id === socket.id);
    r.hints.push({ playerId: socket.id, name: p.name, emoji: p.emoji, hint: clean, round: r.round });
    clearT(r);
    advanceTurn(r);
  });

  socket.on('vote-continue', ({ vote }) => {
    const r = rooms[socket.roomCode];
    if (!r || r.status !== 'vote_continue') return;
    if (r.voteCont[socket.id] !== undefined) return;
    if (vote !== 'continue' && vote !== 'vote') return;
    r.voteCont[socket.id] = vote;
    push(r);
    checkAllVotedCont(r);
  });

  socket.on('vote-chameleon', ({ targetId }) => {
    const r = rooms[socket.roomCode];
    if (!r || r.status !== 'vote_chameleon') return;
    if (r.voteCham[socket.id] !== undefined) return;
    if (targetId === socket.id) return socket.emit('err', 'Você não pode votar em si mesmo.');
    if (!r.players.find(p => p.id === targetId)) return;
    r.voteCham[socket.id] = targetId;
    push(r);
    checkAllVotedCham(r);
  });

  socket.on('disconnect', () => {
    const r = rooms[socket.roomCode];
    if (!r) return;
    r.players = r.players.filter(p => p.id !== socket.id);
    if (r.players.length === 0) { clearT(r); delete rooms[socket.roomCode]; return; }
    if (r.hostId === socket.id) r.hostId = r.players[0].id;

    // Remove from turn order if mid-game
    if (r.status === 'hint_round') {
      const idx = r.turnOrder.indexOf(socket.id);
      if (idx !== -1) {
        r.turnOrder.splice(idx, 1);
        if (r.currentTurn >= r.turnOrder.length) r.currentTurn = r.turnOrder.length - 1;
        if (r.players.length < 3) { clearT(r); r.status = 'lobby'; }
      }
    }
    // Remove pending votes
    delete r.voteCont[socket.id];
    delete r.voteCham[socket.id];

    push(r);
  });
});

const PORT = process.env.PORT || 3000;
httpSv.listen(PORT, () => console.log(`🦎 Camaleão rodando em http://localhost:${PORT}`));
