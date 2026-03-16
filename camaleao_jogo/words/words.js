'use strict';
// ══════════════════════════════════════════════════════════════
//  CAMALEÃO – Language Loader
//  Loads the correct word bank based on the room's language setting.
//  ALL_CATS uses PT category IDs (IDs are language-agnostic).
// ══════════════════════════════════════════════════════════════

function loadWords(lang) {
    switch (lang) {
        case 'en': return require('./words_en');
        case 'es': return require('./words_es');
        default: return require('./words_pt');
    }
}

const ALL_CATS = require('./words_pt').CATEGORIES.map(c => c.id);

module.exports = { loadWords, ALL_CATS };
