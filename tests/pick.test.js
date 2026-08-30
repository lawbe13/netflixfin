/* Runs the quiz's opinion - exactly the scoring that ships - against a made-up
 * library, and checks the promises it makes to whoever answered: that the family
 * evening never turns up a horror, that half an hour means an episode that fits
 * in half an hour, that "mai visto" does not hand back something already
 * watched, that no two runs ask the same questions, and that the three titles it
 * puts up for the duels are three different sorts of evening. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'Jellyfin.Plugin.NetflixFin', 'Web', 'netflixfin.js');
const text = fs.readFileSync(SRC, 'utf8');

/* The scoring needs the seeded random the schedule uses, so both slices are
 * taken: the generator, then the quiz itself. */
const randFrom = text.indexOf('    function tvHash(text) {');
const shuffleTo = text.indexOf('    function tvDayOf(time) {');
const pickFrom = text.indexOf('    var PICK_G = {');
const pickTo = text.indexOf('    /* --------------------------------------------------------------- the page */');
if (randFrom < 0 || shuffleTo < 0 || pickFrom < 0 || pickTo < 0) throw new Error('slice not found');

const harness = new Function('log', 'api', 'tvAsk', 'tvLibraryLoad',
    text.slice(randFrom, shuffleTo) +
    text.slice(pickFrom, pickTo) + `
    return {
        pickRank, pickCandidates, pickAskSet, pickFinalists, pickWording,
        PICK_TIME, PICK_G, PICK_BANK,
        setSeen: function (map) { pickSeen = map; }
    };
`);
const pick = harness(() => {}, () => null, () => Promise.resolve([]), () => Promise.resolve(null));

const MIN = 60000;

/* A library with a known shape, so every expectation below is checkable by hand:
 * films spread over seven flavours and three lengths, plus a dozen series of
 * episodes both short and long. */
const GENRES = [
    ['Commedia'], ['Azione', 'Avventura'], ['Horror'], ['Dramma'],
    ['Fantascienza'], ['Mistero', 'Crime'], ['Animazione', 'Famiglia']
];

const films = [];
for (let i = 0; i < 84; i++) {
    const genres = GENRES[i % GENRES.length];
    const lengths = [82, 96, 128];
    // Real libraries do not sort into one genre apiece.
    const mixed = i % 3 === 0 ? genres.concat(GENRES[(i + 3) % GENRES.length]) : genres;
    films.push({
        id: 'm' + i,
        name: 'Film ' + i,
        type: 'Movie',
        ms: lengths[i % 3] * MIN,
        genres: mixed,
        year: 1970 + (i % 50),
        rating: 5 + ((i * 3) % 45) / 10
    });
}

const shows = [];
for (let s = 0; s < 12; s++) {
    shows.push({
        id: 's' + s,
        name: 'Serie ' + s,
        genres: GENRES[s % GENRES.length],
        episodes: Array.from({ length: 12 }, (_, e) => ({
            id: 's' + s + 'e' + e,
            name: 'Episodio ' + e,
            type: 'Episode',
            seriesId: 's' + s,
            ms: (s % 2 ? 44 : 24) * MIN
        }))
    });
}

const library = { films: films, shows: shows, sets: [] };

// Half the library has been watched, which is what "mai visto" has to see.
const seen = {};
films.forEach((film, i) => { if (i % 2 === 0) seen[film.id] = true; });
pick.setSeen(seen);

const failures = [];
function check(name, ok, detail) {
    if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
}

/* Effects are what an answer leaves behind, so the tests are written in them
 * rather than in the labels above them. */
const mood = (id) =>
    pick.PICK_BANK.filter((q) => q.key === 'mood')[0].options
        .filter((o) => o.id === id)[0].effect;

const E = {
    family: { want: pick.PICK_G.kids, banned: pick.PICK_G.grown, why: 'Va bene per tutti' },
    short: { time: 'short' },
    film: { time: 'film' },
    any: { time: 'any' },
    /* Taken from the bank rather than written out again: an effect copied by
     * hand is a test of the copy, not of what ships - which is how the clash
     * lists went untested the first time round. */
    laugh: mood('laugh'),
    fear: mood('fear'),
    cry: mood('cry'),
    old: { years: [0, 1989], why: 'Un classico' },
    fresh: { seen: 'new', why: 'Non l’hai mai visto' },
    safe: { seen: 'safe', why: 'Lo conosci già' }
};

/* ---- the family evening ------------------------------------------------- */
const forbidden = pick.PICK_G.grown;
const family = pick.pickRank(library, [E.family, E.any], 0, 1);
check('family gets something at all', family.length > 0);
check('family never gets a horror',
    family.every((c) => !c.genres.some((g) => forbidden.indexOf(g) > -1)),
    'a forbidden genre survived the filter');

/* ---- half an hour means an episode -------------------------------------- */
const short = pick.pickRank(library, [E.short, E.laugh], 0, 2);
check('half an hour gets episodes', short.length > 0 && short.every((c) => c.kind === 'episode'));
check('every episode fits in half an hour',
    short.every((c) => c.entry.ms <= pick.PICK_TIME.short.max));
check('one episode per series, not four hundred',
    new Set(short.map((c) => c.show)).size === short.length);

/* ---- a film is a film ---------------------------------------------------- */
const evening = pick.pickRank(library, [E.film, E.laugh], 0, 3);
check('a normal film is between seventy minutes and two hours',
    evening.every((c) => c.entry.ms >= pick.PICK_TIME.film.min && c.entry.ms <= pick.PICK_TIME.film.max));

/* ---- the mood is the strongest thing it knows ---------------------------- */
[['laugh', E.laugh], ['fear', E.fear], ['cry', E.cry]].forEach(([name, effect]) => {
    const ranked = pick.pickRank(library, [E.any, effect], 0, 4);
    const top = ranked.slice(0, 5);
    const hits = top.filter((c) => c.genres.some((g) => effect.love.indexOf(g) > -1)).length;
    check('mood ' + name + ' leads the shortlist', hits >= 4, hits + ' of the top five matched');
});

/* ---- a mood is a gate, not a preference ---------------------------------- */

/* "Porco Rosso fa paura" and "Truman Show ti fa ridere" were the same fault:
 * missing the mood cost less than a good rating was worth. */
['laugh', 'fear', 'cry'].forEach((name) => {
    const effect = E[name];
    const ranked = pick.pickRank(library, [E.any, effect], 0, 41);
    const strays = ranked.filter((c) => !c.genres.some((g) => effect.love.indexOf(g) > -1));
    check('nothing that misses the mood ' + name + ' survives at all', strays.length === 0,
        strays.length + ' of ' + ranked.length + ' answered none of it');
});

/* And when the library cannot answer it, it is allowed to say what it has
 * rather than nothing at all. */
const thin = {
    films: [
        { id: 'x1', name: 'Solo un documentario', type: 'Movie', ms: 95 * MIN,
          genres: ['Documentario'], year: 2001, rating: 7 },
        { id: 'x2', name: 'E un altro', type: 'Movie', ms: 92 * MIN,
          genres: ['Documentario'], year: 2004, rating: 6.5 }
    ],
    shows: [], sets: []
};
check('a library with nothing that fits still answers',
    pick.pickRank(thin, [E.any, E.laugh], 0, 42).length === 2);

/* ---- a war film is not an action film by itself --------------------------- */
const wartime = {
    films: [
        { id: 'sniper', name: 'Guerra e azione', type: 'Movie', ms: 120 * MIN,
          genres: ['Azione', 'Guerra', 'Dramma'], year: 2014, rating: 7.3 },
        { id: 'ashes', name: 'Solo guerra', type: 'Movie', ms: 89 * MIN,
          genres: ['Animazione', 'Dramma', 'Guerra'], year: 1988, rating: 8.5 },
        { id: 'chase', name: 'Solo azione', type: 'Movie', ms: 104 * MIN,
          genres: ['Azione', 'Avventura'], year: 2015, rating: 7 }
    ].concat(
        /* Enough of them that the gate is allowed to close: with three films in
         * the library it stays open on purpose, because a shortlist of nothing
         * helps nobody. */
        Array.from({ length: 9 }, (_, i) => ({
            id: 'act' + i, name: 'Azione ' + i, type: 'Movie', ms: (95 + i) * MIN,
            genres: ['Azione'], year: 2000 + i, rating: 6 + i / 10
        }))),
    shows: [], sets: []
};
const rush = mood('rush');
const adrenaline = pick.pickRank(wartime, [E.any, rush], 0, 44).map((c) => c.entry.id);
check('a war drama does not answer "adrenalina"', adrenaline.indexOf('ashes') < 0,
    adrenaline.join(','));
check('a war film that is also an action film still does',
    adrenaline.indexOf('sniper') > -1, adrenaline.join(','));

/* ---- what a tag says depends on where it sits and what it sits with ------- */
const shades = {
    films: [
        { id: 'pure', name: 'Commedia e basta', type: 'Movie', ms: 95 * MIN,
          genres: ['Commedia'], year: 2004, rating: 7 },
        { id: 'late', name: 'Commedia in fondo', type: 'Movie', ms: 95 * MIN,
          genres: ['Azione', 'Avventura', 'Commedia'], year: 2004, rating: 7 },
        { id: 'grim', name: 'Commedia di guerra', type: 'Movie', ms: 95 * MIN,
          genres: ['Commedia', 'Guerra', 'Dramma'], year: 2004, rating: 7 }
    ],
    shows: [], sets: []
};
let pureFirst = 0;
let grimLast = 0;
for (let roll = 0; roll < 12; roll++) {
    const order = pick.pickRank(shades, [E.any, E.laugh], roll, 43).map((c) => c.entry.id);
    if (order[0] === 'pure') pureFirst++;
    if (order[order.length - 1] === 'grim') grimLast++;
}
check('a comedy that is a comedy first usually wins', pureFirst >= 8, pureFirst + '/12');
check('a comedy that is also a war drama usually loses', grimLast >= 8, grimLast + '/12');

/* ---- the year is a real answer ------------------------------------------- */
const oldies = pick.pickRank(library, [E.any, E.old], 0, 5).slice(0, 6);
check('roba vecchia is old', oldies.every((c) => c.year <= 1989),
    oldies.map((c) => c.year).join(','));

/* ---- never seen means never seen ----------------------------------------- */
for (let roll = 0; roll < 6; roll++) {
    const fresh = pick.pickRank(library, [E.any, E.laugh, E.fresh], roll, 6);
    check('roll ' + roll + ' of "mai visto" is unseen', fresh.length && !fresh[0].seen);
}
const kept = pick.pickRank(library, [E.any, E.laugh, E.safe], 0, 7);
check('a porto sicuro is something already watched', kept.length && kept[0].seen);

/* ---- the duels get three different sorts of evening ---------------------- */
for (let seed = 1; seed <= 6; seed++) {
    const ranked = pick.pickRank(library, [E.any, E.laugh], 0, seed);
    const three = pick.pickFinalists(ranked, 5).slice(0, 3);
    check('seed ' + seed + ' puts up five to choose from',
        pick.pickFinalists(ranked, 5).length === 5, pick.pickFinalists(ranked, 5).length + ' of them');
    check('seed ' + seed + ' does not put up the same film twice',
        new Set(three.map((c) => c.entry.id)).size === three.length);
    check('seed ' + seed + ' contenders are all real answers',
        three.every((c) => ranked.indexOf(c) > -1));
    // Two of the same evening is not a choice.
    const shared = (a, b) => a.genres.filter((g) => b.genres.indexOf(g) > -1).length;
    check('seed ' + seed + ' contenders are three different sorts of evening',
        shared(three[0], three[1]) < 2 && shared(three[0], three[2]) < 2 &&
            shared(three[1], three[2]) < 2,
        three.map((c) => c.genres.join('+')).join(' | '));
}

/* ---- another two really are another two ---------------------------------- */
const seenSets = [];
for (let roll = 0; roll < 8; roll++) {
    const ranked = pick.pickRank(library, [E.any, E.laugh], roll, 8);
    seenSets.push(pick.pickFinalists(ranked, 5).map((c) => c.entry.id).join('|'));
}
check('eight rolls do not all put up the same three', new Set(seenSets).size >= 5,
    'only ' + new Set(seenSets).size + ' different line-ups in eight');

/* ---- no two evenings ask the same thing ---------------------------------- */
const sets = [];
for (let seed = 1; seed <= 40; seed++) {
    const asked = pick.pickAskSet(seed * 7919).map((q) => q.key);
    sets.push(asked.join(','));
    check('seed ' + seed + ' always asks who is watching', asked.indexOf('who') > -1, asked.join(','));
    check('seed ' + seed + ' always settles the length of the evening',
        asked.indexOf('time') > -1 || asked.indexOf('late') > -1, asked.join(','));
    check('seed ' + seed + ' asks five questions or fewer', asked.length <= 5, String(asked.length));
    check('seed ' + seed + ' never asks the same question twice',
        new Set(asked).size === asked.length, asked.join(','));
}
check('forty runs are not forty copies of one quiz', new Set(sets).size >= 8,
    'only ' + new Set(sets).size + ' different sets in forty');

/* ---- and a run is not five of the same shape ----------------------------- */
let sameShapeRuns = 0;
const shapes = new Set();
for (let seed = 1; seed <= 40; seed++) {
    const asked = pick.pickAskSet(seed * 7919);
    asked.forEach((q) => shapes.add(q.format));
    let run = 1;
    for (let i = 1; i < asked.length; i++) {
        if (asked[i].format === asked[i - 1].format) run++;
        else run = 1;
        if (run >= 3) sameShapeRuns++;
    }
}
check('never three questions of the same shape in a row', sameShapeRuns === 0,
    sameShapeRuns + ' runs of three');
check('forty runs use more than one shape of question', shapes.size >= 3,
    [...shapes].join(','));

/* ---- twenty evenings in a row --------------------------------------------
   The complaint this answers: "se facessi il quiz 20 volte vorrei che fosse
   sempre diverso". Random alone does not do that - it circles the heavier
   weights - so the last runs' questions step aside while they can. */
const tally = {};
const wordings = new Set();
const asked20 = [];
for (let run = 0; run < 20; run++) {
    // Each run gets its own seed, the way a real evening does.
    const set = pick.pickAskSet(1000000 + run * 977);
    asked20.push(set.map((q) => q.key).join(','));
    set.forEach((q) => {
        tally[q.key] = (tally[q.key] || 0) + 1;
        wordings.add(pick.pickWording(q, 1000000 + run * 977));
    });
}
const drawable = pick.PICK_BANK.filter((q) => !q.fixed && (!q.when || q.when()));
const missed = drawable.filter((q) => !tally[q.key]);
check('twenty runs reach every question in the bank', missed.length === 0,
    'never asked: ' + missed.map((q) => q.key).join(','));
const hog = Object.keys(tally).filter((k) => k !== 'who' && k !== 'time' && tally[k] > 6);
check('and none of them is asked more than six times in twenty',
    hog.length === 0, hog.map((k) => k + '×' + tally[k]).join(', '));
check('twenty runs are twenty different sets', new Set(asked20).size >= 18,
    new Set(asked20).size + ' distinct');
check('and they are not asked in the same words each time', wordings.size >= 30,
    wordings.size + ' distinct wordings');

/* ---- every option can be said more than one way -------------------------- */
let variants = 0;
pick.PICK_BANK.forEach((question) => {
    question.options.forEach((option) => {
        if (Array.isArray(option.label) && option.label.length > 1) variants++;
    });
});
check('most answers have more than one wording too', variants >= 40, variants + ' of them');

/* ---- and they are not worded the same way either ------------------------- */
const words = new Set();
for (let seed = 1; seed <= 40; seed++) {
    const who = pick.PICK_BANK.filter((q) => q.key === 'who')[0];
    words.add(pick.pickWording(who, seed * 104729));
}
check('the same question is not always asked in the same words', words.size >= 2,
    words.size + ' phrasings seen');

/* ---- every option in the bank is wired to something ---------------------- */
pick.PICK_BANK.forEach((question) => {
    check('question ' + question.key + ' has at least two ways of being asked',
        question.asks.length >= 2);
    check('question ' + question.key + ' says what shape it is',
        ['cards', 'duo', 'quote', 'swatch', 'scene'].indexOf(question.format) > -1,
        String(question.format));
    if (question.format === 'scene') {
        question.options.forEach((option) => {
            check('scene ' + option.id + ' knows what to look for',
                Array.isArray(option.find) && option.find.length > 0);
        });
    }
    if (question.format === 'swatch') {
        question.options.forEach((option) => {
            check('swatch ' + option.id + ' has a colour', /^#[0-9a-f]{6}$/i.test(option.tint || ''));
        });
    }
    if (question.format === 'duo') {
        check('a duo is exactly two panels', question.options.length === 2,
            question.options.length + ' of them');
    }
    question.options.forEach((option) => {
        check('option ' + question.key + '/' + option.id + ' carries an effect',
            !!option.effect && typeof option.effect === 'object');
        if (option.effect.time) {
            check('option ' + question.key + '/' + option.id + ' names a real length',
                !!pick.PICK_TIME[option.effect.time]);
        }
    });
});

/* ---- nothing at all ------------------------------------------------------ */
const empty = pick.pickRank({ films: [], shows: [], sets: [] }, [E.any], 0, 9);
check('an empty library answers with nothing rather than throwing', empty.length === 0);
check('and putting nothing up for a duel is allowed',
    pick.pickFinalists(empty, 5).length === 0);

console.log(JSON.stringify({
    failed: failures.length,
    failures: failures.slice(0, 12),
    questionSets: new Set(sets).size,
    films: films.length
}, null, failures.length ? 1 : 0));

if (failures.length) process.exit(1);
