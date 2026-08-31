/* What came back into this plugin when the other one was removed, run exactly
 * as it is written with a paper DOM underneath: the wordmark, the icons, the
 * dice and the number on a half-watched card. None of it can be tried on the
 * running server without signing in, so it is tried here instead. */
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

const NF_BRAND = /var NF_BRAND = '([^']+)';/.exec(text)[1];

/* Enough of a document to be lied to: nodes that remember their class, their
 * children and the two or three attributes these functions set. */
function node(tag, cls) {
    const self = {
        tagName: tag, className: cls || '', style: {}, children: [],
        attrs: {}, isConnected: true, rel: '', type: '',
        appendChild(kid) { self.children.push(kid); kid.parent = self; return kid; },
        insertBefore(kid, before) {
            const at = before ? self.children.indexOf(before) : -1;
            if (at < 0) self.children.push(kid); else self.children.splice(at, 0, kid);
            kid.parent = self;
            return kid;
        },
        remove() {
            if (!self.parent) return;
            self.parent.children.splice(self.parent.children.indexOf(self), 1);
            self.isConnected = false;
        },
        setAttribute(k, v) { self.attrs[k] = String(v); },
        getAttribute(k) { return k in self.attrs ? self.attrs[k] : null; },
        addEventListener(kind, fn) { (self.on = self.on || {})[kind] = fn; },
        all() {
            return self.children.reduce((acc, kid) => acc.concat([kid], kid.all()), []);
        },
        /* Only the shapes these functions actually ask for: a tag, a class,
         * an id, an attribute, any of those run together, a descendant pair,
         * and a comma-separated list of the lot. */
        one(sel) {
            const bits = sel.match(/^[a-z]+|\.[\w-]+|#[\w-]+|\[[^\]]+\]/gi) || [];
            return bits.every((bit) => {
                if (bit[0] === '.') return (' ' + self.className + ' ').includes(' ' + bit.slice(1) + ' ');
                if (bit[0] === '#') return self.attrs.id === bit.slice(1);
                if (bit[0] === '[') {
                    const pair = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(bit);
                    if (!pair) return false;
                    const held = pair[1] === 'rel' ? self.rel : self.attrs[pair[1]];
                    return pair[2] === undefined ? held !== undefined && held !== '' : held === pair[2];
                }
                return self.tagName === bit;
            });
        },
        matches(sel) {
            return sel.split(',').map((s) => s.trim()).some((one) => {
                const steps = one.split(/\s+/);
                if (!self.one(steps[steps.length - 1])) return false;
                for (let i = steps.length - 2; i >= 0; i--) {
                    let up = self.parent;
                    while (up && !up.one(steps[i])) up = up.parent;
                    if (!up) return false;
                }
                return true;
            });
        },
        closest(sel) {
            for (let up = self; up; up = up.parent) if (up.matches(sel)) return up;
            return null;
        },
        querySelector(sel) { return self.all().find((k) => k.matches(sel)) || null; },
        querySelectorAll(sel) { return self.all().filter((k) => k.matches(sel)); }
    };
    Object.defineProperty(self, 'firstChild', {
        get() { return self.children[0] || null; },
        configurable: true
    });
    Object.defineProperty(self, 'href', {
        get() { return self.attrs.href; },
        set(v) { self.attrs.href = v; },
        configurable: true
    });
    return self;
}

function page() {
    const head = node('head');
    const body = node('body');
    const root = node('html');
    root.appendChild(head);
    root.appendChild(body);
    return {
        head,
        body,
        createElement: (tag) => node(tag),
        querySelector: (sel) => root.querySelector(sel),
        querySelectorAll: (sel) => root.querySelectorAll(sel)
    };
}

function scoped(fns, extra) {
    const scope = Object.assign({
        NF_BRAND,
        el: (tag, cls, words) => { const n = node(tag, cls); if (words) n.textContent = words; return n; },
        svgIcon: (name) => { const n = node('svg'); n.attrs.icon = name; return n; },
        log: () => {}
    }, extra);
    const names = Object.keys(scope);
    const body = fns.map(slice).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(...names, body + '\nreturn {' + fns.join(',') + '};')(
        ...names.map((n) => scope[n]));
}

const cases = [];
const check = (what, fn) => cases.push({ what, fn });

check('the wordmark is the plugin own one when nothing is configured', () => {
    const doc = page();
    const title = node('h3', 'pageTitleWithDefaultLogo');
    doc.body.appendChild(title);
    scoped(['applyLogo', 'applyIcons'], { document: doc, cfg: {} }).applyLogo();
    return title.style.backgroundImage === 'url("' + NF_BRAND + 'banner")';
});

check('a configured logo still wins', () => {
    const doc = page();
    const title = node('h3', 'pageTitleWithLogo');
    doc.body.appendChild(title);
    scoped(['applyLogo', 'applyIcons'], { document: doc, cfg: { logoUrl: '/mine.png' } }).applyLogo();
    return title.style.backgroundImage === 'url("/mine.png")';
});

check('the icons replace the ones jellyfin ships, once', () => {
    const doc = page();
    const theirs = node('link');
    theirs.rel = 'icon';
    theirs.href = '/web/favicon.ico';
    doc.head.appendChild(theirs);

    const brand = scoped(['applyLogo', 'applyIcons'], { document: doc, cfg: {} });
    brand.applyIcons();
    brand.applyIcons();
    brand.applyIcons();

    const icons = doc.head.querySelectorAll('link[rel="icon"]');
    const touch = doc.head.querySelectorAll('link[rel="apple-touch-icon"]');
    return icons.length === 1 && touch.length === 1 &&
        icons[0].href === NF_BRAND + 'favicon' &&
        touch[0].href === NF_BRAND + 'touch-icon' &&
        !theirs.isConnected;
});

check('a configured logo leaves the icons alone', () => {
    const doc = page();
    scoped(['applyLogo', 'applyIcons'], { document: doc, cfg: { logoUrl: '/mine.png' } }).applyIcons();
    return doc.head.children.length === 0;
});

check('the dice is added once, and to the left of everything else', () => {
    const doc = page();
    const right = node('div', 'headerRight');
    right.appendChild(node('button', 'headerSearchButton'));
    doc.body.appendChild(right);

    const dice = scoped(['nfDice'], { document: doc, api: () => null }).nfDice;
    dice();
    dice();
    dice();

    return right.children.length === 2 &&
        right.children[0].className.includes('nf-dice') &&
        right.querySelectorAll('.nf-dice').length === 1;
});

check('no header, no dice, no complaint', () => {
    const doc = page();
    scoped(['nfDice'], { document: doc, api: () => null }).nfDice();
    return doc.body.children.length === 0;
});

check('a press asks for one title at random and opens it', () => {
    const doc = page();
    const right = node('div', 'headerRight');
    doc.body.appendChild(right);

    let asked = null;
    const client = {
        getCurrentUserId: () => 'u1',
        serverId: () => 's1',
        getItems: (user, query) => {
            asked = { user, query };
            return Promise.resolve({ Items: [{ Id: 'film-7' }] });
        }
    };
    const win = { location: { hash: '#/home.html' } };
    scoped(['nfDice'], { document: doc, api: () => client, window: win }).nfDice();
    right.querySelector('.nf-dice').on.click();

    return Promise.resolve().then(() => Promise.resolve()).then(() =>
        asked.user === 'u1' &&
        asked.query.SortBy === 'Random' &&
        asked.query.Limit === 1 &&
        asked.query.Recursive === true &&
        asked.query.IncludeItemTypes === 'Movie,Series' &&
        win.location.hash === '#/details?id=film-7&serverId=s1');
});

check('an empty library does not move the page', () => {
    const doc = page();
    const right = node('div', 'headerRight');
    doc.body.appendChild(right);
    const win = { location: { hash: '#/home.html' } };
    const client = {
        getCurrentUserId: () => 'u1',
        serverId: () => 's1',
        getItems: () => Promise.resolve({ Items: [] })
    };
    scoped(['nfDice'], { document: doc, api: () => client, window: win }).nfDice();
    right.querySelector('.nf-dice').on.click();
    return Promise.resolve().then(() => win.location.hash === '#/home.html');
});

check('a request that fails is written down, not thrown', () => {
    const doc = page();
    const right = node('div', 'headerRight');
    doc.body.appendChild(right);
    const said = [];
    const client = {
        getCurrentUserId: () => 'u1',
        serverId: () => 's1',
        getItems: () => Promise.reject(new Error('offline'))
    };
    scoped(['nfDice'], {
        document: doc, api: () => client, window: { location: {} },
        log: (m) => said.push(m)
    }).nfDice();
    right.querySelector('.nf-dice').on.click();
    return Promise.resolve().then(() => Promise.resolve()).then(() => said.length === 1);
});

/* --- how far in you are ------------------------------------------------- */

function card(width) {
    const one = node('div', 'card');
    one.attrs['data-id'] = 'x';
    const box = node('div', 'cardBox');
    const over = node('div', 'cardImageContainer');
    const bar = node('div', 'itemProgressBar');
    if (width !== null) {
        const fill = node('div', 'itemProgressBarForeground');
        fill.style.width = width;
        bar.appendChild(fill);
    }
    box.appendChild(over);
    box.appendChild(bar);
    one.appendChild(box);
    return { one, box, over, bar };
}

function labelled(doc) {
    return doc.querySelectorAll('.nf-left').map((n) => n.textContent);
}

check('a half-watched card says how far in it is', () => {
    const doc = page();
    const built = card('63.4%');
    doc.body.appendChild(built.one);
    scoped(['nfProgressLabels'], { document: doc }).nfProgressLabels();
    return labelled(doc).join() === '63%' &&
        built.over.children.length === 1;
});

check('the number is not written twice, and follows the bar', () => {
    const doc = page();
    const built = card('20%');
    doc.body.appendChild(built.one);
    const paint = scoped(['nfProgressLabels'], { document: doc }).nfProgressLabels;
    paint();
    paint();
    built.bar.children[0].style.width = '55%';
    paint();
    return labelled(doc).join() === '55%';
});

check('a finished card loses the number', () => {
    const doc = page();
    const built = card('40%');
    doc.body.appendChild(built.one);
    const paint = scoped(['nfProgressLabels'], { document: doc }).nfProgressLabels;
    paint();
    built.bar.children[0].style.width = '100%';
    paint();
    return labelled(doc).length === 0;
});

check('an untouched card is left alone', () => {
    const doc = page();
    doc.body.appendChild(card(null).one);
    scoped(['nfProgressLabels'], { document: doc }).nfProgressLabels();
    return labelled(doc).length === 0;
});

(async () => {
    let bad = 0;
    for (const one of cases) {
        const ok = await one.fn();
        if (!ok) bad++;
        console.log((ok ? '  ok   ' : '  FAIL ') + one.what);
    }
    console.log(cases.length - bad + '/' + cases.length);
    process.exit(bad ? 1 : 0);
})();
