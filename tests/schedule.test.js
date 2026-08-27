/* Runs the schedule exactly as it is written in the plugin, on a made-up
 * library, and checks what a viewer would notice: that every minute of a month
 * has something on, that the ident between programmes stays twenty seconds, and
 * that the line-up never runs backwards. */
const fs = require('fs');

const path = require('path');
const SRC = path.join(__dirname, '..', 'Jellyfin.Plugin.NetflixFin', 'Web', 'netflixfin.js');
const text = fs.readFileSync(SRC, 'utf8');

const from = text.indexOf('    var TV_EPOCH');
const to = text.indexOf('    /* A handle for checking the line-up');
if (from < 0 || to < 0) throw new Error('slice not found');

const harness = new Function('log', 'api', text.slice(from, to) + `
    return { TV_CHANNELS, TV_IDENT_MS, TV_DAY_MS, tvDaySchedule, tvNow, tvGuide, tvDayStart, tvIsSitcom };
`);
const tv = harness(() => {}, () => null);

const MIN = 60000;
const pools = {
    movie: {
        kind: 'movie',
        items: Array.from({ length: 60 }, (_, i) => ({
            id: 'm' + String(i).padStart(3, '0'),
            name: 'Film ' + i,
            ms: (80 + ((i * 7) % 60)) * MIN,
            type: 'Movie'
        }))
    },
    episode: {
        kind: 'episode',
        shows: Array.from({ length: 8 }, (_, s) => ({
            id: 's' + s,
            name: 'Serie ' + s,
            genres: [],
            episodes: Array.from({ length: 10 + s }, (_, e) => ({
                id: 's' + s + 'e' + e,
                name: 'S' + s + 'E' + e,
                ms: (s % 2 ? 45 : 22) * MIN,
                type: 'Episode'
            }))
        }))
    },
    boxset: {
        kind: 'boxset',
        shows: Array.from({ length: 6 }, (_, s) => ({
            id: 'b' + s,
            name: 'Saga ' + s,
            genres: [],
            episodes: Array.from({ length: 3 + (s % 3) }, (_, e) => ({
                id: 'b' + s + 'f' + e,
                name: 'Saga ' + s + ' film ' + e,
                ms: (100 + s * 10) * MIN,
                type: 'Movie'
            }))
        }))
    }
};

const DAYS = 30;
const STEP = 3 * MIN;
const report = {};
let failures = 0;

for (const channel of tv.TV_CHANNELS) {
    const pool = pools[channel.kind];
    const trouble = { deadAir: 0, gaps: 0, backwards: 0, longestIdentSec: 0, overrunMin: 0 };

    let previousStart = -Infinity;
    let seen = 0;

    for (let t = tv.tvDayStart(0); t < tv.tvDayStart(DAYS); t += STEP) {
        const on = tv.tvNow(channel, pool, t);
        if (!on) { trouble.gaps++; continue; }
        seen++;

        if (t < on.slot.start || t >= on.slot.identEnd) trouble.gaps++;
        if (on.slot.start < previousStart) trouble.backwards++;
        previousStart = on.slot.start;

        const ident = on.slot.identEnd - on.slot.end;
        trouble.longestIdentSec = Math.max(trouble.longestIdentSec, Math.round(ident / 1000));
        if (ident > tv.TV_IDENT_MS) trouble.deadAir++;

        // A programme that ran past midnight, and by how far.
        const overrun = on.slot.identEnd - (Math.floor(on.slot.start / tv.TV_DAY_MS) + 1) * tv.TV_DAY_MS;
        if (overrun > 0) trouble.overrunMin = Math.max(trouble.overrunMin, Math.round(overrun / MIN));

        // Whatever is announced has to be a real programme.
        if (on.inIdent && !on.next) trouble.gaps++;
    }

    // The guide: in order, starting with what is on, no repeats.
    const guide = tv.tvGuide(channel, pool, tv.tvDayStart(3) + 13 * 3600000 + 7 * MIN);
    const now = tv.tvNow(channel, pool, tv.tvDayStart(3) + 13 * 3600000 + 7 * MIN);
    const ordered = guide.every((s, i) => !i || s.start >= guide[i - 1].start);
    const startsOnAir = guide.length && guide[0].start === now.slot.start;
    const unique = new Set(guide.map((s) => s.start)).size === guide.length;

    report[channel.id] = {
        probes: seen,
        ...trouble,
        guide: guide.length,
        guideOk: !!(ordered && startsOnAir && unique)
    };
    if (trouble.deadAir || trouble.gaps || trouble.backwards || !ordered || !startsOnAir || !unique) failures++;
}

console.log(JSON.stringify(report, null, 1));

const sitcomCases = [
    [['Commedia'], 22, true],
    [['Commedia', 'Dramma'], 43, false],
    [['Dramma'], 22, false],
    [['Commedia', 'Animazione'], 11, true],
    [['Comedy'], 35, true],
    [['Comedy'], 36, false]
];
let sitcomWrong = 0;
for (const [genres, mins, want] of sitcomCases) {
    const eps = [1, 2, 3].map(() => ({ ms: mins * MIN }));
    if (tv.tvIsSitcom(genres, eps) !== want) {
        sitcomWrong++;
        console.log('sitcom wrong:', genres.join('/'), mins + 'm');
    }
}

console.log(JSON.stringify({ channelsFailing: failures, sitcomWrong }));
