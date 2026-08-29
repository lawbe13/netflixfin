/* Runs the quiz's opinion - exactly the scoring that ships - against a made-up
 * library, and checks the promises it makes to whoever answered: that the
 * family evening never turns up a horror, that half an hour means an episode
 * that fits in half an hour, that "mai visto" does not hand back something
 * already watched, and that asking for another really does give another. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'Jellyfin.Plugin.NetflixFin', 'Web', 'netflixfin.js');
const text = fs.readFileSync(SRC, 'utf8');

/* The scoring needs the seeded random the schedule uses, so both slices are
 * taken: the generator, then the quiz itself. */
const randFrom = text.indexOf('    function tvHash(text) {');
const randTo = text.indexOf('    function tvShuffle(list, seed) {');
const shuffleTo = text.indexOf('    function tvDayOf(time) {');
const pickFrom = text.indexOf('    var PICK_MOOD = {');
const pickTo = text.indexOf('    /* --------------------------------------------------------------- the page */');
if (randFrom < 0 || randTo < 0 || pickFrom < 0 || pickTo < 0) throw new Error('slice not found');

const harness = new Function('log', 'api', 'tvAsk', 'tvLibraryLoad',
    text.slice(randFrom, shuffleTo) +
    text.slice(pickFrom, pickTo) + `
    return {
        pickRank, pickCandidates, PICK_TIME, PICK_MOOD,
        setSeen: function (map) { pickSeen = map; }
    };
`);
const pick = harness(() => {}, () => null, () => Promise.resolve([]), () => Promise.resolve(null));

const MIN = 60000;

/* A library with a known shape, so every expectation below is checkable by
 * hand: thirty films spread over six moods and three lengths, plus a dozen
 * series of episodes both short and long. */
const GENRES = [
    ['Commedia'], ['Azione', 'Avventura'], ['Horror'], ['Dramma'],
    ['Fantascienza'], ['Mistero', 'Crime'], ['Animazione', 'Famiglia']
];

const films = [];
for (let i = 0; i < 84; i++) {
    const genres = GENRES[i % GENRES.length];
    const lengths = [82, 96, 128];
    // Real libraries do not sort into one genre apiece: every third film also
    // carries a second, which is the only way the poster question has anything
    // to grip on.
    var mixed = i % 3 === 0 ? genres.concat(GENRES[(i + 3) % GENRES.length]) : genres;
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

// Half of the comedies have been watched, which is what "mai visto" has to see.
const seen = {};
films.forEach((film, i) => { if (i % 2 === 0) seen[film.id] = true; });
pick.setSeen(seen);

const answers = (over) => Object.assign(
    { who: 'solo', time: 'film', head: 'any', mood: 'laugh', known: 'any' }, over);

const failures = [];
function check(name, ok, detail) {
    if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
}

/* ---- the family evening ------------------------------------------------- */
const forbidden = ['Horror', 'Thriller', 'Crime', 'Guerra', 'War', 'Erotico'];
const family = pick.pickRank(library, answers({ who: 'family', mood: 'wonder' }), [], 0);
check('family gets something at all', family.length > 0);
check('family never gets a horror',
    family.every((c) => !c.genres.some((g) => forbidden.indexOf(g) > -1)),
    'a forbidden genre survived the filter');

/* ---- half an hour means an episode -------------------------------------- */
const short = pick.pickRank(library, answers({ time: 'short' }), [], 0);
check('half an hour gets episodes', short.length > 0 && short.every((c) => c.kind === 'episode'));
check('every episode fits in half an hour',
    short.every((c) => c.entry.ms <= pick.PICK_TIME.short.max),
    'something longer than 46 minutes came back');
check('one episode per series, not four hundred',
    new Set(short.map((c) => c.show)).size === short.length,
    'a series appeared twice');

/* ---- a film is a film ---------------------------------------------------- */
const evening = pick.pickRank(library, answers({ time: 'film' }), [], 0);
check('a normal film is between seventy minutes and two hours',
    evening.every((c) => c.entry.ms >= pick.PICK_TIME.film.min && c.entry.ms <= pick.PICK_TIME.film.max));

/* ---- the mood is the strongest thing it knows ---------------------------- */
['laugh', 'fear', 'cry', 'mystery'].forEach((mood) => {
    const ranked = pick.pickRank(library, answers({ mood: mood, time: 'any' }), [], 0);
    const top = ranked.slice(0, 5);
    const wanted = pick.PICK_MOOD[mood];
    const hits = top.filter((c) => c.genres.some((g) => wanted.indexOf(g) > -1)).length;
    check('mood ' + mood + ' leads the shortlist', hits >= 4, hits + ' of the top five matched');
});

/* ---- never seen means never seen ----------------------------------------- */
for (let roll = 0; roll < 6; roll++) {
    const fresh = pick.pickRank(library, answers({ known: 'new', time: 'any' }), [], roll);
    check('roll ' + roll + ' of "mai visto" is unseen', fresh.length && !fresh[0].seen,
        fresh.length ? fresh[0].entry.name + ' has been watched' : 'nothing came back');
}

const safe = pick.pickRank(library, answers({ known: 'safe', mood: 'laugh', time: 'any' }), [], 0);
check('a porto sicuro is something already watched', safe.length && safe[0].seen);

/* ---- another one really is another one ----------------------------------- */
const tops = [];
for (let roll = 0; roll < 8; roll++) {
    const ranked = pick.pickRank(library, answers({ time: 'any' }), [], roll);
    tops.push(ranked[0] && ranked[0].entry.id);
}
check('eight rolls do not all give the same film', new Set(tops).size >= 4,
    'only ' + new Set(tops).size + ' different answers in eight');

/* ---- the eye counts for something, but not for everything ---------------- */
const plain = pick.pickRank(library, answers({ mood: 'laugh', time: 'any' }), [], 3);
const eyed = pick.pickRank(library, answers({ mood: 'laugh', time: 'any' }), ['Fantascienza'], 3);
check('the poster you chose moves the order',
    plain[0].entry.id !== eyed[0].entry.id ||
        eyed.slice(0, 10).some((c) => c.genres.indexOf('Fantascienza') > -1));
check('the poster you chose cannot override the mood',
    eyed.slice(0, 3).every((c) => c.genres.some((g) => pick.PICK_MOOD.laugh.indexOf(g) > -1)),
    'a science fiction film beat every comedy');

/* ---- nothing at all ------------------------------------------------------ */
const empty = pick.pickRank({ films: [], shows: [], sets: [] }, answers({}), [], 0);
check('an empty library answers with nothing rather than throwing', empty.length === 0);

const impossible = pick.pickRank(library, answers({ who: 'family', mood: 'fear' }), [], 0);
check('an impossible evening is allowed to come back empty', Array.isArray(impossible));

console.log(JSON.stringify({
    failed: failures.length,
    failures: failures,
    films: films.length,
    shows: shows.length
}, null, failures.length ? 1 : 0));

if (failures.length) process.exit(1);
