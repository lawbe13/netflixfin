/* The rule this file guards: nothing watched on a channel may end up in
 * Continua a guardare or in Prossimo.
 *
 * It runs tvBorrow, tvBorrowRun, tvPutBack, tvGiveBackLater and tvReturn
 * exactly as they are written, against a server that remembers what it was
 * told, and checks that every title a channel touches ends the evening holding
 * precisely what it held before - position, count and date.
 *
 * The date is here because it is what was missed: position and count were being
 * put back and titles were still appearing, in Prossimo, which Jellyfin builds
 * from LastPlayedDate. */
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

const GIVE_BACK_MS = eval(/var TV_GIVE_BACK_MS = ([^;]+);/.exec(text)[1]);

/* A server that holds user data and lets a test wind time forward. */
function bench(library) {
    const wrote = [];
    const timers = [];

    const client = {
        getCurrentUserId: () => 'u1',
        getUrl: (tail) => '/' + tail,
        getItem: (user, id) => Promise.resolve({ Id: id, UserData: library[id] || {} }),
        ajax: (req) => {
            const unplayed = /UserPlayedItems\/([^/?]+)/.exec(req.url);
            if (unplayed) {
                wrote.push({ id: unplayed[1], how: 'unplayed' });
                return Promise.resolve();
            }
            wrote.push({
                id: /UserItems\/([^/]+)\//.exec(req.url)[1],
                how: 'post',
                body: JSON.parse(req.data)
            });
            return Promise.resolve();
        }
    };

    const scope = {
        api: () => client,
        log: () => {},
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: (h) => { if (timers[h - 1]) timers[h - 1].fn = null; },
        Promise,
        Object,
        JSON
    };

    const names = Object.keys(scope);
    const body = [
        'var tvBorrowed = {};',
        'var tvReturnTimer = null;',
        'var tvGiveBackTimers = {};',
        'var TV_GIVE_BACK_MS = ' + GIVE_BACK_MS + ';',
        slice('tvBorrow'),
        slice('tvBorrowRun'),
        slice('tvGiveBackLater'),
        slice('tvUntouched'),
        slice('tvBody'),
        slice('tvPutBack'),
        slice('tvReturn'),
        'return { tvBorrow: tvBorrow, tvBorrowRun: tvBorrowRun,',
        '  tvGiveBackLater: tvGiveBackLater, tvReturn: tvReturn,',
        '  held: function () { return tvBorrowed; } };'
    ].join('\n');

    // eslint-disable-next-line no-new-func
    const made = new Function(...names, body)(...names.map((n) => scope[n]));
    made.wrote = wrote;
    made.fire = () => timers.forEach((t) => t.fn && t.fn());
    return made;
}

const settle = () => new Promise((done) => setImmediate(done));

const cases = [];
const check = (what, fn) => cases.push({ what, fn });

const WATCHED = {
    a: { Played: false, PlaybackPositionTicks: 3000000000, PlayCount: 2, LastPlayedDate: '2026-07-01T20:00:00Z' },
    b: { Played: true, PlaybackPositionTicks: 0, PlayCount: 1, LastPlayedDate: '2026-06-02T21:00:00Z' },
    c: {}
};

check('the date is noted along with the position and the count', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrow('a');
    const was = kit.held().a;
    return was.PlaybackPositionTicks === 3000000000 && was.PlayCount === 2 &&
        was.LastPlayedDate === '2026-07-01T20:00:00Z' && was.Played === false;
});

check('a title nobody had touched is noted as untouched', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrow('c');
    const was = kit.held().c;
    return was.PlayCount === 0 && was.PlaybackPositionTicks === 0 &&
        was.LastPlayedDate === null && was.Played === false;
});

check('the whole line-up is noted in one go', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrowRun([{ item: { id: 'a' } }, { item: { id: 'b' } }, { item: { id: 'c' } }]);
    return Object.keys(kit.held()).sort().join() === 'a,b,c';
});

check('what goes back is exactly what was there, date included', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrowRun([{ item: { id: 'a' } }, { item: { id: 'b' } }]);
    kit.tvReturn();
    await settle();
    await settle();

    const byId = {};
    kit.wrote.forEach((one) => { byId[one.id] = one; });
    return kit.wrote.length === 2 &&
        byId.a.how === 'post' &&
        byId.a.body.PlaybackPositionTicks === 3000000000 &&
        byId.a.body.PlayCount === 2 &&
        byId.a.body.LastPlayedDate === '2026-07-01T20:00:00Z' &&
        byId.b.body.Played === true &&
        byId.b.body.LastPlayedDate === '2026-06-02T21:00:00Z';
});

/* The one the server would not do on being asked politely: a null in the body is
 * skipped, so a title that arrived with no date has to be marked unplayed. */
check('a title never watched before is marked unplayed, not posted a null', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrow('c');
    kit.tvReturn();
    await settle();
    await settle();

    const first = kit.wrote[0];
    const then = kit.wrote[1];
    return kit.wrote.length === 2 &&
        first.how === 'unplayed' && first.id === 'c' &&
        then.how === 'post' &&
        !Object.prototype.hasOwnProperty.call(then.body, 'LastPlayedDate') &&
        then.body.PlayCount === 0 && then.body.PlaybackPositionTicks === 0 &&
        then.body.Played === false;
});

check('a date that was there is never posted as a null', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrow('a');
    kit.tvReturn();
    await settle();
    await settle();
    return kit.wrote.length === 1 && kit.wrote[0].how === 'post' &&
        kit.wrote[0].body.LastPlayedDate === '2026-07-01T20:00:00Z';
});

check('one the viewer asked to keep is left where it is', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrowRun([{ item: { id: 'a' } }, { item: { id: 'b' } }]);
    kit.tvReturn('a');
    await settle();
    await settle();
    return kit.wrote.every((one) => one.id === 'b');
});

check('noted but never answered for: nothing is the safe thing to put back', async () => {
    const kit = bench(WATCHED);
    kit.tvBorrow('a');
    kit.tvReturn();
    await settle();
    await settle();
    return kit.wrote[0].how === 'unplayed' &&
        kit.wrote[1].body.PlayCount === 0 &&
        kit.wrote[1].body.PlaybackPositionTicks === 0 &&
        kit.wrote[1].body.Played === false;
});

check('the queue passing a programme hands it back on its own', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrow('a');
    kit.tvGiveBackLater('a');
    if (kit.wrote.length) return false;

    kit.fire();
    await settle();
    await settle();
    return kit.wrote.length === 1 && kit.wrote[0].id === 'a' &&
        kit.wrote[0].body.LastPlayedDate === '2026-07-01T20:00:00Z' &&
        !Object.prototype.hasOwnProperty.call(kit.held(), 'a');
});

check('and it is not then handed back a second time on the way out', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrowRun([{ item: { id: 'a' } }, { item: { id: 'b' } }]);
    kit.tvGiveBackLater('a');
    kit.fire();
    await settle();
    kit.tvReturn();
    await settle();
    await settle();
    const ids = kit.wrote.map((one) => one.id);
    return ids.filter((id) => id === 'a').length === 1 && ids.indexOf('b') > -1;
});

check('leaving cancels a hand-back that had not happened yet', async () => {
    const kit = bench(WATCHED);
    await kit.tvBorrow('a');
    kit.tvGiveBackLater('a');
    kit.tvReturn();
    await settle();
    await settle();
    kit.fire();
    await settle();
    return kit.wrote.length === 1 && kit.wrote[0].how === 'post';
});

check('the wait is long enough to outlast the player last report', () => {
    return GIVE_BACK_MS >= 20000;
});

(async () => {
    let bad = 0;
    for (const one of cases) {
        let ok = false;
        try {
            ok = await one.fn();
        } catch (err) {
            ok = false;
            console.log('       ' + err.message);
        }
        if (!ok) bad++;
        console.log((ok ? '  ok   ' : '  FAIL ') + one.what);
    }
    console.log(cases.length - bad + '/' + cases.length);
    process.exit(bad ? 1 : 0);
})();
