/* Runs tvTick exactly as it is written, with everything it talks to replaced by
 * a note-taker, and checks which way it jumps in the situations that put the
 * viewer back on the TV page mid-evening. */
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

const TAIL = Number(/var TV_TAIL_MS = ([^;]+);/.exec(text)[1].replace('*', '*'));
const TV_TAIL_MS = eval(/var TV_TAIL_MS = ([^;]+);/.exec(text)[1]);

const MIN = 60000;
let now = 1000000000000;
const Clock = { now: () => now };

function run(scene) {
    const calls = [];
    const state = Object.assign({
        channel: 'uno', shift: 0, timer: 1, pending: null, tunedAt: now,
        started: true, retried: false, route: '#/details?id=a', slotId: 'a',
        ambient: false, ended: false, lostAt: 0
    }, scene.state);

    const scope = {
        tvState: state,
        TV_TAIL_MS,
        Date: { now: Clock.now },
        log: (m) => calls.push('log:' + m),
        tvChannel: () => ({ id: 'uno', name: 'Uno' }),
        tvPools: { uno: {} },
        tvClock: () => now - state.shift,
        tvNow: () => scene.on,
        tvOnAir: () => scene.onAir !== false,
        tvLiveVideo: () => scene.video || null,
        // Asked for and loading, which is not the same as playing.
        tvPlayerBusy: () => !!scene.busy,
        // The dialog jellyfin-web puts up when a file will not play at all.
        tvFatalDialog: () => (scene.fatal ? { querySelector: () => ({ click: () => calls.push('dismiss') }) } : null),
        tvCover: () => calls.push('cover'),
        tvAmbient: () => calls.push('ambient'),
        tvPaintIdent: () => calls.push('ident'),
        tvPaintOsd: () => calls.push('osd'),
        tvHandOver: () => calls.push('handover'),
        tvPressPlay: () => calls.push('press'),
        tvStop: () => calls.push('stop'),
        seekTo: (v, s) => calls.push('seek:' + Math.round(s))
    };

    const names = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    new Function(...names, slice('tvTick') + '\ntvTick();')(...names.map((n) => scope[n]));
    return { calls, state };
}

const slot = (id, endInMs) => ({
    slot: { item: { id: id, name: id }, start: now - 3600000, end: now + endInMs, identEnd: now + endInMs + 20000 },
    next: { item: { id: 'b', name: 'b' } },
    offset: 3600000,
    inIdent: endInMs <= 0
});

const cases = [
    {
        what: 'programme ends two minutes before the line-up says so',
        scene: { on: slot('a', 2 * MIN), video: null },
        want: (r) => r.calls.includes('ident') && !r.calls.includes('stop') && r.state.ended === true
    },
    {
        what: 'player disappears in the middle of a programme',
        scene: { on: slot('a', 40 * MIN), video: null },
        want: (r) => r.calls.includes('stop')
    },
    {
        what: 'the ident is on',
        scene: { on: Object.assign(slot('a', -5000), { inIdent: true }), video: null },
        want: (r) => !r.calls.includes('stop') && !r.calls.includes('handover')
    },
    {
        what: 'the line-up has moved on',
        scene: { on: slot('b', 40 * MIN), video: null },
        want: (r) => r.calls.includes('handover') && !r.calls.includes('stop')
    },
    {
        what: 'no line-up at all',
        scene: { on: null, video: null },
        want: (r) => !r.calls.includes('stop')
    },
    {
        what: 'viewer left the channel',
        scene: { on: slot('a', 40 * MIN), video: null, onAir: false },
        want: (r) => r.calls.includes('stop')
    },
    {
        what: 'nothing started after seven seconds',
        scene: { on: slot('a', 40 * MIN), video: null, state: { started: false, tunedAt: now - 7000, pending: { slot: {} } } },
        want: (r) => r.calls.includes('press') && !r.calls.includes('stop')
    },
    {
        what: 'nothing started after fifty seconds',
        scene: { on: slot('a', 40 * MIN), video: null, state: { started: false, retried: 2, tunedAt: now - 50000, pending: { slot: {} } } },
        want: (r) => r.calls.includes('press') && !r.calls.includes('stop')
    },
    {
        what: 'nothing started after seventy seconds',
        scene: { on: slot('a', 40 * MIN), video: null, state: { started: false, retried: 3, tunedAt: now - 70000, pending: { slot: {} } } },
        want: (r) => !r.calls.includes('stop')
    },
    {
        what: 'the stream restarts itself in the middle of a programme',
        scene: { on: slot('a', 40 * MIN), video: null, busy: true },
        want: (r) => !r.calls.includes('stop') && r.state.lostAt > 0
    },
    {
        what: 'the stream never came back, ninety seconds on',
        scene: { on: slot('a', 40 * MIN), video: null, busy: true, state: { lostAt: now - 95000 } },
        want: (r) => r.calls.includes('stop')
    },
    {
        what: 'the server says it cannot play this one',
        scene: { on: slot('a', 40 * MIN), video: null, fatal: true },
        want: (r) => r.calls.includes('dismiss') && r.calls.includes('stop')
    },
    {
        what: 'the transcode is still warming up at eighty seconds',
        scene: { on: slot('a', 40 * MIN), video: null, busy: true, state: { started: false, retried: 1, tunedAt: now - 80000, pending: { slot: {} } } },
        want: (r) => !r.calls.includes('press') && !r.calls.includes('stop')
    },
    {
        what: 'the transcode never delivered, five minutes on',
        scene: { on: slot('a', 40 * MIN), video: null, busy: true, state: { started: false, retried: 1, tunedAt: now - 300000, pending: { slot: {} } } },
        want: (r) => r.calls.includes('stop')
    },
    {
        what: 'nothing started after two minutes',
        scene: { on: slot('a', 40 * MIN), video: null, state: { started: false, retried: 3, tunedAt: now - 120000, pending: { slot: {} } } },
        want: (r) => r.calls.includes('stop')
    },
    {
        what: 'a programme running, seek still short of the mark',
        scene: {
            on: slot('a', 40 * MIN),
            video: { readyState: 4, currentTime: 10, paused: false },
            state: { pending: { slot: { item: { id: 'a' } }, offset: 3600000 } }
        },
        want: (r) => r.calls.some((c) => c.indexOf('seek:') === 0)
    },
    {
        what: 'a programme running where the channel is',
        scene: {
            on: slot('a', 40 * MIN),
            video: { readyState: 4, currentTime: 3600, paused: false },
            state: { pending: { slot: { item: { id: 'a' } }, offset: 3600000 } }
        },
        want: (r) => !r.calls.some((c) => c.indexOf('seek:') === 0) && r.state.pending === null
    }
];

let failed = 0;
for (const c of cases) {
    const r = run(c.scene);
    const ok = c.want(r);
    if (!ok) failed++;
    console.log((ok ? 'ok   ' : 'FAIL ') + c.what + '  ->  ' + (r.calls.join(', ') || 'nothing'));
}
console.log(JSON.stringify({ failed, of: cases.length, tailMinutes: TV_TAIL_MS / MIN }));
