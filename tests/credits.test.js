/* A channel ends a film where its credits start.
 *
 * The decision of WHICH films is the server's - it has the segments, the TMDb
 * keywords and the chapter marks, and it refuses unless every one of them says
 * the cut is safe. What is checked here is the other half: that a title the
 * server named is laid out short, that a title it said nothing about is laid
 * out exactly as it always was, and that a nonsense answer is refused rather
 * than believed. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'Jellyfin.Plugin.NetflixFin', 'Web', 'netflixfin.js');
const text = fs.readFileSync(SRC, 'utf8');

function slice(name) {
    const head = text.indexOf('function ' + name + '(');
    if (head < 0) throw new Error('no ' + name);
    let depth = 0;
    for (let i = text.indexOf('{', head); i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return text.slice(head, i + 1);
    }
    throw new Error('unbalanced ' + name);
}

const TV_MIN_MS = eval(/var TV_MIN_MS = ([^;]+);/.exec(text)[1]);

function bench(credits) {
    const scope = { tvCredits: credits, TV_MIN_MS, Math, String };
    const names = Object.keys(scope);
    const body = [
        slice('tvKey'),
        slice('tvRuntime'),
        slice('tvEntry'),
        'return { tvEntry: tvEntry, tvKey: tvKey };'
    ].join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(...names, body)(...names.map((n) => scope[n]));
}

const MIN = 60000;
const film = (over) => Object.assign({
    Id: 'abcdef0123456789abcdef0123456789',
    Name: 'Un film',
    Type: 'Movie',
    RunTimeTicks: 100 * MIN * 10000
}, over);

const cases = [];
const check = (what, fn) => cases.push({ what, fn });

check('a film the server named ends at its credits', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 94 * MIN });
    const entry = kit.tvEntry(film());
    return entry.ms === 94 * MIN && entry.cut === true;
});

check('a film it said nothing about keeps the length of its file', () => {
    const kit = bench({});
    const entry = kit.tvEntry(film());
    return entry.ms === 100 * MIN && entry.cut === undefined;
});

/* The map is keyed without dashes and the API has emitted both forms over the
 * years, so the two are made to meet in the middle rather than hoped about. */
check('an id with dashes finds its way into the map', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 94 * MIN });
    const entry = kit.tvEntry(film({ Id: 'ABCDEF01-2345-6789-ABCD-EF0123456789' }));
    return entry.ms === 94 * MIN && entry.cut === true;
});

check('a credits time longer than the film is refused', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 140 * MIN });
    const entry = kit.tvEntry(film());
    return entry.ms === 100 * MIN && !entry.cut;
});

check('and one that would leave no programme at all is refused', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 30000 });
    const entry = kit.tvEntry(film());
    return entry.ms === 100 * MIN && !entry.cut;
});

check('a zero is nothing to say, not a film of no length', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 0 });
    return kit.tvEntry(film()).ms === 100 * MIN;
});

check('an episode is cut the same way, when the server says so', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 21 * MIN });
    const entry = kit.tvEntry(film({
        Type: 'Episode',
        RunTimeTicks: 22 * MIN * 10000,
        SeriesName: 'Una serie',
        SeriesId: 's1',
        ParentIndexNumber: 2,
        IndexNumber: 4
    }));
    return entry.ms === 21 * MIN && entry.cut === true &&
        entry.series === 'Una serie' && entry.season === 2 && entry.episode === 4;
});

check('everything else about the entry is untouched', () => {
    const kit = bench({ abcdef0123456789abcdef0123456789: 94 * MIN });
    const entry = kit.tvEntry(film());
    return entry.id === 'abcdef0123456789abcdef0123456789' && entry.name === 'Un film' &&
        entry.type === 'Movie' && entry.series === null && entry.seriesId === null;
});

let bad = 0;
cases.forEach((one) => {
    let ok = false;
    try {
        ok = one.fn();
    } catch (err) {
        console.log('       ' + err.message);
    }
    if (!ok) bad++;
    console.log((ok ? '  ok   ' : '  FAIL ') + one.what);
});
console.log(cases.length - bad + '/' + cases.length);
process.exit(bad ? 1 : 0);
