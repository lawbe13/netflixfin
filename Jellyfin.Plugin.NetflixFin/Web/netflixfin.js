/* NetflixFin - behaviour layer.
 *
 * The stylesheet carries the look. This file adds the four things CSS cannot
 * express: the billboard, the hover preview card, the 16:9 artwork swap and the
 * Top 10 numerals. Everything is progressive - if a selector disappears in a
 * future jellyfin-web release the page still works, it just looks less Netflix.
 *
 * window.NetflixFinConfig is written by the plugin immediately above this file.
 */
(function () {
    'use strict';

    var cfg = Object.assign(
        {
            enableHoverPreview: true,
            hideCardText: true,
            useWideThumbnails: true,
            enableHeroBanner: true,
            heroAutoRotate: true,
            heroRotateSeconds: 12,
            enableTop10: true,
            logoUrl: ''
        },
        window.NetflixFinConfig || {}
    );

    /* Netflix's row is "I 10 titoli più visti oggi", not literally "Top 10", so
       both spellings count. */
    var TOP10_RE = /top\s*-?\s*10|\b10\s+(titoli|piu|più)\b/i;
    var heroTimer = null;
    var heroTeardown = null;

    /* ---------------------------------------------------------------- utils */

    function log() {
        if (window.NetflixFinDebug) {
            console.log.apply(console, ['[NetflixFin]'].concat([].slice.call(arguments)));
        }
    }

    function api() {
        return window.ApiClient && window.ApiClient.getCurrentUserId ? window.ApiClient : null;
    }

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function icon(name) {
        var span = el('span', 'material-icons', name);
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    function minutes(ticks) {
        return ticks ? Math.round(ticks / 600000000) : null;
    }

    function runtimeLabel(item) {
        if (item.Type === 'Series') {
            var n = item.ChildCount || item.SeasonCount;
            if (!n) return null;
            return n + (n === 1 ? ' stagione' : ' stagioni');
        }
        var mins = minutes(item.RunTimeTicks);
        if (!mins) return null;
        return mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
    }

    function waitFor(selector, timeout, cb) {
        var deadline = Date.now() + (timeout || 5000);
        (function poll() {
            var found = document.querySelector(selector);
            if (found) return cb(found);
            if (Date.now() > deadline) return cb(null);
            setTimeout(poll, 100);
        })();
    }

    /* Start playback without leaving the page.
     *
     * Navigating to #/details and pressing its play button worked, but the
     * details page is itself styled as a card - so pressing play in a modal
     * flashed up what looked like a second modal before the video began.
     *
     * jellyfin-web has no playbackManager on window here, but it does delegate
     * clicks on elements carrying data-action="play"/"resume", reading the item
     * from the nearest data-id. A real card is used when one is on screen;
     * otherwise a hidden stand-in carrying the same attributes is clicked and
     * removed. Navigation stays as the last resort. */
    function playNow(id, serverId, type, action) {
        if (!id) return;

        /* TV asks for "play" rather than "resume": a channel starts its
         * programme at zero and seeks, so that nothing has to be written into
         * the item's user data and nothing has to be put back afterwards. */
        var want = action || 'resume';

        var card = action ? null : document.querySelector('.card[data-id="' + id + '"]');
        var trigger =
            card &&
            card.querySelector('[data-action="resume"], [data-action="play"], .cardOverlayFab-primary');

        if (trigger) {
            trigger.click();
        } else {
            var proxy = el('div', 'card cardOverlayButton');
            proxy.style.display = 'none';
            proxy.setAttribute('data-id', id);
            if (serverId) proxy.setAttribute('data-serverid', serverId);
            if (type) proxy.setAttribute('data-type', type);
            proxy.setAttribute('data-isfolder', 'false');

            var button = el('button', 'cardOverlayButton');
            button.type = 'button';
            button.setAttribute('data-action', want);
            proxy.appendChild(button);

            (document.querySelector('.itemsContainer') || document.body).appendChild(proxy);
            button.click();
            setTimeout(function () {
                proxy.remove();
            }, 0);
        }

        // If nothing started, fall back to the route that always worked - except
        // for a channel, where being dropped on a details page is worse than
        // waiting, and tvTick gives up on its own.
        if (action) return;

        setTimeout(function () {
            if (!document.querySelector('.videoPlayerContainer video, video.htmlvideoplayer')) {
                log('playNow did not start playback, routing to details');
                goToDetails(id, serverId, true);
            }
        }, 2500);
    }

    function goToDetails(id, serverId, autoplay) {
        window.location.hash = '/details?id=' + id + '&serverId=' + serverId;
        if (!autoplay) return;
        // The details view builds asynchronously; press its own play button.
        waitFor('.mainDetailButtons .btnResume, .mainDetailButtons .btnPlay', 6000, function (btn) {
            if (btn) btn.click();
        });
    }

    /* ------------------------------------------------------------ body flags */

    /* Tiles per row, decided here rather than in a media query.
     *
     * The laptop kept showing seven where five were wanted while its console
     * reported a 430px viewport - a width at which the stylesheet's rule says
     * five. Setting the variable inline on :root removes both suspects at once:
     * it beats a stale cached stylesheet, and it beats any rule that was
     * winning on specificity. It is also the value the debug line below reads
     * back, so what is measured is what is applied. */
    function applyTileCount() {
        var width = window.innerWidth;
        var tiles;
        if (IS_TOUCH && width <= 1279) {
            /* An iPad runs six 2:3 posters at a ~217pt pitch, which Netflix has held
             * across two design generations; a phone runs three and a bit, the peek
             * being the scroll affordance. This is set here rather than in the
             * stylesheet because this function writes --nf-tiles inline, and inline
             * beats any rule. */
            tiles = width >= 821 ? 6 : 3;
        } else {
            // Two measured anchors: 1512 wants five, 1920 and 2133 want seven. The
            // boundary therefore sits between them, not at 1400 - which is what put
            // seven on the laptop.
            tiles = width >= 1800 ? 7 : width >= 1200 ? 5 : width >= 700 ? 4 : 3;
        }
        var root = document.documentElement;
        if (root.style.getPropertyValue('--nf-tiles') !== String(tiles)) {
            root.style.setProperty('--nf-tiles', String(tiles));
            log('tiles', tiles, 'at', width);
        }
    }

    /* Whether this is a touch device, decided once.
     *
     * `pointer: coarse` alone is not enough: an iPad with a Magic Keyboard or any
     * trackpad reports `pointer: fine`, and would have been served the desktop
     * layout - on the very device this was written for. maxTouchPoints does not
     * lie about that. */
    var IS_TOUCH =
        window.matchMedia('(pointer: coarse)').matches ||
        (navigator.maxTouchPoints || 0) > 1;

    function applyBodyFlags() {
        document.body.classList.toggle('nf-touch', IS_TOUCH);
        document.body.classList.toggle('nf-hover-preview', !!cfg.enableHoverPreview && !IS_TOUCH);
        document.body.classList.toggle('nf-hide-card-text', !!cfg.hideCardText);
        // nf-playing is managePlayer's alone - see the note there.
    }

    /* The header is fixed and, on a phone, two rows tall - the wordmark and the
     * controls, then the chip row. Nothing reserved that height, so every page
     * started at y=0 underneath it: scrolling ran the billboard, its buttons and
     * its title straight through the chips. The height is measured rather than
     * guessed because a long page title, a second line of chips or a large text
     * setting all change it. */
    function publishHeaderHeight() {
        var header = document.querySelector('.skinHeader');
        if (!header) return;
        var height = Math.round(header.getBoundingClientRect().height);
        if (!height) return;
        if (publishHeaderHeight.last === height) return;
        publishHeaderHeight.last = height;
        document.documentElement.style.setProperty('--nf-header-h', height + 'px');
    }

    function bindScrollState() {
        var lastY = 0;

        var update = function () {
            var scroller = document.querySelector('.mainAnimatedPages') || document.documentElement;
            var y = window.scrollY || scroller.scrollTop || 0;
            document.body.classList.toggle('nf-scrolled', y > 60);

            /* On a phone the bar is two rows - wordmark and controls, then the
             * chips - and the page now starts below it rather than behind it, so
             * a bar that never moves is a third of the first card gone for good.
             * The app's leaves on the way down and comes back on the way up. */
            var dy = y - lastY;
            if (Math.abs(dy) > 8) {
                if (isPhone()) {
                    document.body.classList.toggle('nf-header-away', dy > 0 && y > 140);
                }
                lastY = y;
            }
            if (y <= 140) document.body.classList.remove('nf-header-away');
        };
        // Window's capture listener already sees every scroll in the document, so
        // one binding is enough; the second only ran the same callback twice.
        window.addEventListener('scroll', update, { passive: true, capture: true });
        update();
    }

    /* The header's search and notification glyphs come from the Material set,
     * which reads as a different product beside everything else here. Swapped
     * for the drawn shapes; anything without a Netflix counterpart is left as
     * Jellyfin drew it. */
    var HEADER_GLYPHS = { search: 'search', notifications: 'bell', notifications_none: 'bell' };

    function netflixHeaderIcons() {
        document.querySelectorAll('.headerRight .material-icons').forEach(function (glyph) {
            // Jellyfin names the glyph in the class list, not as ligature text,
            // so reading textContent found nothing to swap.
            var key = (glyph.textContent || '').trim();
            if (!HEADER_GLYPHS[key]) {
                key = Object.keys(HEADER_GLYPHS).filter(function (candidate) {
                    return glyph.classList.contains(candidate);
                })[0];
            }
            var name = HEADER_GLYPHS[key];
            if (!name || glyph.dataset.nfSwapped) return;
            glyph.dataset.nfSwapped = '1';
            glyph.textContent = '';
            glyph.classList.add('nf-header-icon');
            glyph.appendChild(svgIcon(name));
        });
    }

    function applyLogo() {
        if (!cfg.logoUrl) return;
        document.querySelectorAll('.pageTitleWithDefaultLogo, .pageTitleWithLogo').forEach(function (node) {
            node.style.backgroundImage = 'url("' + cfg.logoUrl + '")';
        });

    }

    var brandLogo = null;

    /* The single letter in the phone header, on a channel's badge and in the
     * watermark is the wordmark's own first glyph, shown by cropping the image
     * rather than by setting an F in some other typeface - a drawn letter is a
     * different letter.
     *
     * Where that image comes from is not ours to assume: on this server the
     * plugin's own logoUrl is empty and the wordmark is Jellyfin's branding,
     * painted straight onto the page title. So it is read off the element that
     * is actually showing it, whoever put it there, and kept once found - the
     * title carries text rather than a logo on most pages. */
    function publishBrandLogo() {
        if (brandLogo) return;

        var title = document.querySelector('.pageTitleWithLogo, .pageTitleWithDefaultLogo');
        if (!title) return;

        var image = getComputedStyle(title).backgroundImage;
        if (!image || image === 'none' || image.indexOf('url(') !== 0) return;

        brandLogo = image;
        document.documentElement.style.setProperty('--nf-logo', image);
        document.documentElement.classList.add('nf-has-logo');
    }

    /* ---------------------------------------------------------------- nav */

    /* Netflix's nav is one row: wordmark, then links, hard left. Jellyfin centres
     * a two-tab bar on a row of its own and offers libraries only through the
     * drawer, so the bar is replaced with a link list built from the user's
     * actual libraries. Its own tab buttons are kept alive behind it - clicking
     * a proxy clicks the real one, so Jellyfin's routing is untouched. */
    var navViews = null;
    var navRetries = 0;

    function firstView(type) {
        return (navViews || []).filter(function (view) {
            return view.CollectionType === type;
        })[0];
    }

    /* Netflix's nav is four items and never grows. A server split into twenty
     * genre libraries would otherwise push a twenty-link bar into the account
     * controls, so only the first film and series library are linked - the rest
     * stay one click away in Jellyfin's own drawer. */
    function navTargets() {
        // A fixed set of links, never the current page's tabs. Proxying those
        // filled the bar with whatever Jellyfin showed for that route -
        // Suggestions, Collections, Genres - as links that went nowhere.
        var targets = [{ label: 'Home', hash: '#/home' }];

        var series = firstView('tvshows');
        if (series) {
            targets.push({
                label: 'Serie TV',
                hash: '#/tv?topParentId=' + series.Id,
                collectionType: 'tvshows'
            });
        }

        var movies = firstView('movies');
        if (movies) {
            targets.push({
                label: 'Film',
                hash: '#/movies?topParentId=' + movies.Id,
                collectionType: 'movies'
            });
        }

        /* Favourites are Jellyfin's stand-in for My List, and they are not a route
         * of their own: they are tab 1 of the home page, normally reached from the
         * tab strip that this skin hides. Hiding it made them unreachable, so the
         * link is put back here. */
        targets.push({ label: 'La mia lista', hash: '#/home?tab=1' });
        targets.push({ label: 'TV', hash: '#/home?nftv=1' });
        targets.push({ label: 'Categorie', genres: true });

        return targets;
    }

    var genreList = null;
    var genreRequest = null;

    /* Netflix's chip row ends in Categories. Jellyfin's equivalent is the genre
     * list, and the route behind it is its own - #/list?genreId=&serverId=, with
     * parentId optional. Verified live before it was written down: with no parent
     * it answers across every library, which is what a global Categories menu
     * wants. */
    function loadGenres() {
        if (genreList) return Promise.resolve(genreList);
        if (genreRequest) return genreRequest;

        var client = api();
        if (!client) return Promise.resolve(null);

        genreRequest = client
            .getGenres(client.getCurrentUserId(), { SortBy: 'SortName', Limit: 200 })
            .then(function (result) {
                var items = (result && result.Items) || [];
                // Only a real answer is kept: an empty one has to be askable again.
                if (items.length) genreList = items;
                genreRequest = null;
                return genreList;
            })
            .catch(function (err) {
                genreRequest = null;
                log('could not read the genres', err);
                return null;
            });

        return genreRequest;
    }

    function buildGenreChip(nav) {
        var client = api();
        if (!client) return;

        var wrapper = el('div', 'nf-nav-item nf-nav-genres');
        var button = el('button', null);
        button.type = 'button';
        button.appendChild(el('span', null, 'Categorie'));
        button.appendChild(el('span', 'nf-nav-caret'));
        wrapper.appendChild(button);

        // On <body>, not in the header: nested there it lands in the header's
        // stacking context and page content paints straight over it.
        var menu = el('div', 'nf-nav-menu nf-nav-menu-genres');
        document.body.appendChild(menu);

        var fill = function (items) {
            if (!items || menu.children.length) return;
            items.forEach(function (genre) {
                var link = el('a', null, genre.Name);
                link.href = '#/list?genreId=' + genre.Id + '&serverId=' + client.serverId();
                link.addEventListener('click', function () {
                    menu.classList.remove('is-open');
                });
                menu.appendChild(link);
            });
        };

        var place = function () {
            var rect = button.getBoundingClientRect();
            // Kept on screen: this is the last chip in the row, so on a phone it
            // sits against the right edge.
            var width = Math.min(260, window.innerWidth - 24);
            var left = Math.min(Math.round(rect.left), window.innerWidth - width - 12);
            menu.style.left = Math.max(12, left) + 'px';
            menu.style.top = Math.round(rect.bottom + 6) + 'px';
        };

        var open = function () {
            loadGenres().then(function (items) {
                fill(items);
                place();
                menu.classList.add('is-open');
            });
        };

        var close = function () {
            setTimeout(function () {
                if (!wrapper.matches(':hover') && !menu.matches(':hover')) {
                    menu.classList.remove('is-open');
                }
            }, 120);
        };

        // A phone has no hover, so the chip is a toggle there and a tap anywhere
        // else closes it.
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            if (menu.classList.contains('is-open')) {
                menu.classList.remove('is-open');
            } else {
                open();
            }
        });

        document.addEventListener('click', function (event) {
            if (!menu.contains(event.target) && !wrapper.contains(event.target)) {
                menu.classList.remove('is-open');
            }
        });

        if (!IS_TOUCH) {
            wrapper.addEventListener('mouseenter', open);
            wrapper.addEventListener('mouseleave', close);
            menu.addEventListener('mouseenter', function () {
                menu.classList.add('is-open');
            });
            menu.addEventListener('mouseleave', close);
        }

        nav.appendChild(wrapper);
    }

    /* The wordmark is the whole brand on a wide screen; on a phone the app runs a
     * single letter with the name of the page beside it. Jellyfin leaves the home
     * page's title empty because it draws its logo there instead, so that one is
     * supplied here. */
    function applyPhoneMark() {
        var title = document.querySelector('.skinHeader .pageTitle');
        var left = document.querySelector('.headerLeft');
        if (!title || !left) return;

        var mark = left.querySelector('.nf-mark');
        if (!mark) {
            mark = el('div', 'nf-mark', 'F');
            mark.setAttribute('aria-hidden', 'true');
        }
        if (mark.nextElementSibling !== title || mark.parentElement !== left) {
            left.insertBefore(mark, title);
        }

        /* Only the home page needs one supplied, and only on a phone: the wide
         * layout still draws the wordmark there, and a title written into the
         * same element paints straight over it. Ours is flagged so a real title
         * from Jellyfin is never the one being cleared. */
        if (window.location.hash.indexOf('#/home') !== 0) return;

        if (isPhone()) {
            if (!title.textContent.trim()) {
                title.textContent = /tab=1/.test(window.location.hash) ? 'La mia lista' : 'Home';
                title.dataset.nfTitle = '1';
            }
        } else if (title.dataset.nfTitle) {
            title.textContent = '';
            delete title.dataset.nfTitle;
        }
    }

    function markActive(nav) {
        var hash = window.location.hash;

        /* Every entry that is a prefix of the current route matches, and #/home
         * is a prefix of #/home?nftv=1 and #/home?tab=1 - so Home stayed lit
         * while TV was open. The longest match is the one that means something. */
        var nodes = nav.querySelectorAll('[data-nf-hash]');
        var best = null;
        var bestLength = -1;
        nodes.forEach(function (node) {
            var target = node.getAttribute('data-nf-hash');
            if (hash.indexOf(target.replace('#', '')) === 1 && target.length > bestLength) {
                best = node;
                bestLength = target.length;
            }
        });
        nodes.forEach(function (node) {
            node.classList.toggle('is-active', node === best);
        });
        nav.querySelectorAll('[data-nf-tab]').forEach(function (node) {
            var index = Number(node.getAttribute('data-nf-tab'));
            var tabs = document.querySelectorAll('.headerTabs .emby-tab-button');
            var tab = tabs[index];
            node.classList.toggle(
                'is-active',
                !!tab && tab.classList.contains('emby-tab-button-active') && !/#\/(tv|movies)\b/.test(hash)
            );
        });
    }

    /* The phone and iPad builds put navigation in a floating capsule at the
     * bottom. The capsule is not Netflix's - Netflix draws a flat #222 bar with a
     * #2d2d2d pill behind the active tab - it is the bottom bar from the owner's
     * Madeira app, carried across on request: liquid glass, a drop that travels
     * under the labels, a shrink on scroll and a drag. The look lives in the
     * stylesheet; what is here is the part CSS cannot do, which is a moving
     * target (see tabAnimate).
     *
     * Icons are Lucide (ISC licence), the set Madeira draws with: outline, 20px,
     * 1.9 stroke. Geometry copied verbatim from lucide-react v1.27.0 rather than
     * traced by eye. */
    var NAV_GLYPHS = {
        house: [
            ['path', 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8'],
            ['path', 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']
        ],
        search: [
            ['path', 'm21 21-4.34-4.34'],
            ['circle', 11, 11, 8]
        ],
        user: [
            ['circle', 12, 8, 5],
            ['path', 'M20 21a8 8 0 0 0-16 0']
        ],
        tv: [
            ['path', 'M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z'],
            ['path', 'M17 2l-5 5-5-5']
        ]
    };

    function navIcon(name) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.9');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'nf-tab-icon');

        (NAV_GLYPHS[name] || []).forEach(function (part) {
            var node = document.createElementNS(ns, part[0]);
            if (part[0] === 'circle') {
                node.setAttribute('cx', String(part[1]));
                node.setAttribute('cy', String(part[2]));
                node.setAttribute('r', String(part[3]));
            } else {
                node.setAttribute('d', part[1]);
            }
            svg.appendChild(node);
        });
        return svg;
    }

    var TABS = [
        // #/home matches #/home?tab=1 as well, so the list is read from the end:
        // the more specific entry is the later one.
        { glyph: 'house', label: 'Home', route: '#/home', match: /#\/home|^#?\/?$/ },
        { glyph: 'tv', label: 'TV', route: '#/home?nftv=1', match: /nftv=1/ },
        { glyph: 'search', label: 'Cerca', route: '#/search', match: /#\/search/ },
        { glyph: 'user', label: 'Il mio filmettino', route: '#/home?tab=1', match: /tab=1/ }
    ];

    /** Damping time constant of the drop, in milliseconds. At 190 it covers two
     *  thirds of the distance in the first 190ms and settles in a little over half
     *  a second: soft, without keeping you waiting. */
    var TAB_TAU = 190;
    /** How long the loop keeps re-measuring its target after being started. It has
     *  to outlast --nf-nav-dur: when the capsule changes size the first frame finds
     *  it still still, and without this the loop would close immediately, leaving
     *  the drop at the wrong width. */
    var TAB_TRACK_MS = 1200;
    /** Past this much movement the gesture is a drag, not a tap. */
    var TAB_DRAG_THRESHOLD = 6;
    /** Minimum scroll before the bar shrinks or expands again. */
    var TAB_SCROLL_STEP = 10;

    var tabBar = {
        shell: null,
        capsule: null,
        pill: null,
        items: [],
        /** Current position of the drop, in pixels inside the capsule. */
        pos: { x: 0, w: 0, ready: false },
        target: 0,
        raf: null,
        lastTs: 0,
        aliveUntil: 0,
        /* When the capsule changes size the active entry stays the same: the drop
         * should be stuck to it, not chasing it. With damping on it fell behind and
         * then caught up, and that lag reads as a wobble. */
        stick: false,
        compact: false,
        drag: { active: false, startX: 0, startLeft: 0, moved: false, target: 0 }
    };

    /** Where the drop should be right now, measured live. */
    function tabMeasure(index) {
        var item = tabBar.items[index];
        if (!tabBar.capsule || !item) return null;
        var cr = tabBar.capsule.getBoundingClientRect();
        // The bar is display:none on anything that is not a touch device, and a
        // zero-width capsule would settle the drop at nothing.
        if (!cr.width) return null;
        var ir = item.getBoundingClientRect();
        return { x: ir.left - cr.left, w: ir.width };
    }

    function tabPaint() {
        if (!tabBar.pill) return;
        tabBar.pill.style.translate = tabBar.pos.x + 'px 0';
        tabBar.pill.style.width = tabBar.pos.w + 'px';
    }

    function tabMarkOn(index) {
        tabBar.items.forEach(function (item, i) {
            item.dataset.on = i === index ? 'true' : 'false';
            if (i === index) {
                item.setAttribute('aria-current', 'page');
            } else {
                item.removeAttribute('aria-current');
            }
        });
        if (tabBar.capsule) tabBar.capsule.classList.toggle('is-idle', index < 0);
    }

    /* A single loop governs every movement of the drop.
     *
     * Not a CSS transition, because the target moves: when the capsule shrinks or
     * grows the entries change position while the drop is still travelling. A
     * transition would aim at the position measured when it started and land off
     * target; here the target is re-measured every frame and the drop closes on it
     * with exponential damping, which settles without bouncing. */
    function tabAnimate() {
        tabBar.aliveUntil = performance.now() + TAB_TRACK_MS;
        if (tabBar.raf !== null) return;
        tabBar.lastTs = performance.now();

        var step = function (ts) {
            var dt = Math.min(64, ts - tabBar.lastTs);
            tabBar.lastTs = ts;

            var target = tabMeasure(tabBar.target);
            if (!target) {
                tabBar.raf = null;
                return;
            }

            // stuck: no inertia, the drop simply is the target
            var alpha = tabBar.stick ? 1 : 1 - Math.exp(-dt / TAB_TAU);
            var dx = target.x - tabBar.pos.x;
            var dw = target.w - tabBar.pos.w;
            tabBar.pos.x += dx * alpha;
            tabBar.pos.w += dw * alpha;
            tabPaint();

            if (Math.abs(dx) < 0.2 && Math.abs(dw) < 0.2) {
                tabBar.pos.x = target.x;
                tabBar.pos.w = target.w;
                tabPaint();
                // closes only once the capsule has stopped moving too
                if (ts > tabBar.aliveUntil) {
                    tabBar.raf = null;
                    return;
                }
            }
            tabBar.raf = requestAnimationFrame(step);
        };

        tabBar.raf = requestAnimationFrame(step);
    }

    function tabGoTo(index, animated) {
        tabBar.target = index;
        tabMarkOn(index);

        var here = tabMeasure(index);
        if (!here) return;

        if (!tabBar.pos.ready || !animated) {
            tabBar.pos = { x: here.x, w: here.w, ready: true };
            tabPaint();
            return;
        }

        tabBar.stick = false;
        tabAnimate();
    }

    function tabBounce() {
        if (!tabBar.capsule) return;
        tabBar.capsule.classList.remove('nf-tab-bounce');
        void tabBar.capsule.offsetWidth;
        tabBar.capsule.classList.add('nf-tab-bounce');
    }

    function tabSetCompact(on) {
        if (!tabBar.shell || tabBar.compact === on) return;
        tabBar.compact = on;
        tabBar.shell.classList.toggle('is-compact', on);
        tabBar.stick = true;
        tabAnimate();
    }

    function activeTabIndex() {
        var hash = window.location.hash || '';
        for (var i = TABS.length - 1; i >= 0; i--) {
            if (TABS[i].match.test(hash)) return i;
        }
        return -1;
    }

    function goToTab(index) {
        var tab = TABS[index];
        if (!tab) return;
        window.location.hash = tab.route;
        if (tab.route.indexOf('#/home') === 0) {
            // Jellyfin switches home tabs from its tab strip, which this skin
            // hides; changing the hash alone leaves the old tab on screen. Its
            // buttons are still in the DOM, so press the real one.
            switchHomeTab(tab.route.indexOf('tab=1') > -1 ? 1 : 0);
        }
        markActiveTab();
    }

    function switchHomeTab(index) {
        // Coming from another page the home view is not mounted yet when the hash
        // changes, so the strip is looked for over the next second or so rather
        // than once.
        var tries = 0;
        var attempt = function () {
            var buttons = document.querySelectorAll('.headerTabs .emby-tab-button');
            var button = buttons[index];
            if (button) {
                if (!button.classList.contains('emby-tab-button-active')) button.click();
                return;
            }
            if (++tries < 20) setTimeout(attempt, 60);
        };
        attempt();
    }

    /* The drop sits under the entries and would never see a pointer event, so the
     * handlers live on the capsule. */
    function bindTabDrag(capsule) {
        capsule.addEventListener('pointerdown', function (event) {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            if (!tabBar.pill) return;

            var pr = tabBar.pill.getBoundingClientRect();
            if (event.clientX < pr.left || event.clientX > pr.right) return;

            tabBar.drag = {
                active: true,
                startX: event.clientX,
                startLeft: pr.left - capsule.getBoundingClientRect().left,
                moved: false,
                target: tabBar.target
            };
            capsule.setPointerCapture(event.pointerId);
        });

        capsule.addEventListener('pointermove', function (event) {
            if (!tabBar.drag.active) return;
            var dx = event.clientX - tabBar.drag.startX;
            if (!tabBar.drag.moved && Math.abs(dx) < TAB_DRAG_THRESHOLD) return;

            if (!tabBar.drag.moved) {
                tabBar.drag.moved = true;
                // the finger is in charge: stop the damping
                if (tabBar.raf !== null) {
                    cancelAnimationFrame(tabBar.raf);
                    tabBar.raf = null;
                }
                tabBar.pill.classList.add('is-dragging');
            }

            var cr = capsule.getBoundingClientRect();
            var pad = 6;
            var left = Math.min(
                Math.max(tabBar.drag.startLeft + dx, pad),
                cr.width - tabBar.pos.w - pad
            );
            tabBar.pos.x = left;
            tabPaint();

            var centre = cr.left + left + tabBar.pos.w / 2;
            var nearest = 0;
            var best = Infinity;
            tabBar.items.forEach(function (item, i) {
                var r = item.getBoundingClientRect();
                var d = Math.abs(r.left + r.width / 2 - centre);
                if (d < best) {
                    best = d;
                    nearest = i;
                }
            });
            tabMarkOn(nearest);
            tabBar.drag.target = nearest;
        });

        var endDrag = function () {
            if (!tabBar.drag.active) return;
            var moved = tabBar.drag.moved;
            var target = tabBar.drag.target;
            tabBar.drag.active = false;
            if (tabBar.pill) tabBar.pill.classList.remove('is-dragging');
            if (!moved) return;

            tabSetCompact(false);
            tabBar.stick = false;
            tabGoTo(target, true);
            goToTab(target);
        };

        capsule.addEventListener('pointerup', endDrag);
        capsule.addEventListener('pointercancel', endDrag);
    }

    function bindTabScroll() {
        // Same reading as bindScrollState: the page scrolls in .mainAnimatedPages
        // on some layouts and on the window in others.
        var read = function () {
            var scroller = document.querySelector('.mainAnimatedPages');
            return window.scrollY || (scroller ? scroller.scrollTop : 0) || 0;
        };

        var last = read();
        var ticking = false;

        window.addEventListener('scroll', function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () {
                var y = read();
                var dy = y - last;
                if (Math.abs(dy) > TAB_SCROLL_STEP) {
                    if (dy > 0 && y > 60) tabSetCompact(true);
                    else if (dy < 0) tabSetCompact(false);
                    last = y;
                }
                if (y <= 60) tabSetCompact(false);
                ticking = false;
            });
        }, { passive: true, capture: true });

        var realign = function () {
            tabBar.stick = true;
            tabAnimate();
        };
        window.addEventListener('resize', realign);
        window.addEventListener('orientationchange', realign);
    }

    /* The two events bound in bindTabScroll cover a rotation and a window resize,
     * and neither fires for the two things that actually move these entries: the
     * bar being measured before it is on screen, and the web font swapping in and
     * changing every label's width. Watch the box itself instead. */
    function bindTabResize(capsule) {
        if (!window.ResizeObserver) return;
        new ResizeObserver(function () {
            if (tabBar.drag.active) return;
            if (!tabBar.pos.ready) {
                markActiveTab();
                return;
            }
            // A travel already re-measures every frame, and the compact toggle
            // starts its own stuck pass; stepping in would only fight them.
            if (tabBar.raf !== null) return;
            tabBar.stick = true;
            tabAnimate();
        }).observe(capsule);
    }

    function buildTabBar() {
        if (tabBar.shell && tabBar.shell.isConnected) {
            markActiveTab();
            return;
        }

        var shell = el('nav', 'nf-tabbar');
        var capsule = el('div', 'nf-tabbar-capsule');
        var pill = el('span', 'nf-tabbar-pill');
        pill.setAttribute('aria-hidden', 'true');
        capsule.appendChild(pill);

        var items = TABS.map(function (tab, index) {
            var item = el('button', 'nf-tab');
            item.type = 'button';
            item.dataset.on = 'false';
            item.appendChild(navIcon(tab.glyph));
            item.appendChild(el('span', 'nf-tab-label', tab.label));
            item.addEventListener('click', function () {
                // a drag ends over an entry and would otherwise fire its click too
                if (tabBar.drag.moved) {
                    tabBar.drag.moved = false;
                    return;
                }
                tabSetCompact(false);
                tabGoTo(index, true);
                tabBounce();
                goToTab(index);
            });
            capsule.appendChild(item);
            return item;
        });

        bindTabDrag(capsule);
        shell.appendChild(capsule);
        document.body.appendChild(shell);

        tabBar.shell = shell;
        tabBar.capsule = capsule;
        tabBar.pill = pill;
        tabBar.items = items;
        tabBar.pos = { x: 0, w: 0, ready: false };

        bindTabScroll();
        bindTabResize(capsule);
        markActiveTab();
        // First paint: the capsule has just been appended and the browser has not
        // laid it out yet, so the measurement above may have come back empty.
        requestAnimationFrame(markActiveTab);
    }

    function markActiveTab() {
        if (!tabBar.capsule) return;
        var index = activeTabIndex();

        if (index < 0) {
            tabMarkOn(-1);
            return;
        }

        if (!tabBar.pos.ready) {
            tabGoTo(index, false);
            return;
        }

        if (index === tabBar.target) {
            tabMarkOn(index);
            return;
        }

        tabGoTo(index, true);
        tabBounce();
    }

    function buildNav() {
        var left = document.querySelector('.headerLeft');
        if (!left) return;

        var client = api();
        if (!client) return;

        if (navViews === null) {
            navViews = [];
            client
                .getUserViews({}, client.getCurrentUserId())
                .then(function (result) {
                    navViews = result.Items || [];
                    // Jellyfin may have re-rendered the header while the request
                    // was in flight, so the captured element can be detached by
                    // now; clear by document, not by the stale reference.
                    document.querySelectorAll('.nf-nav').forEach(function (node) {
                        node.remove();
                    });
                    buildNav();
                })
                .catch(function (err) {
                    // The first pass runs at DOMContentLoaded, which can be before
                    // ApiClient holds a token - that 401 must not settle the nav
                    // as "no libraries" for the rest of the session.
                    log('library lookup failed', err);
                    navViews = null;
                    if (navRetries++ < 10) setTimeout(buildNav, 1000);
                });
        }

        var targets = navTargets();
        if (!targets.length) return;

        // Keyed by the labels themselves, not a count: the nav is first built
        // before the library list has arrived, and every later pass has to notice
        // that the contents changed and rebuild, whatever order things resolved
        // in.
        var signature = targets
            .map(function (target) {
                return target.label;
            })
            .join('|');

        var existing = left.querySelector('.nf-nav');
        if (existing && existing.dataset.nfSignature === signature && existing.isConnected) {
            markActive(existing);
            return;
        }
        document.querySelectorAll('.nf-nav').forEach(function (node) {
            node.remove();
        });
        clearGenreMenus();

        var nav = el('nav', 'nf-nav');
        nav.dataset.nfSignature = signature;

        targets.forEach(function (target, i) {
            var node;
            if (target.genres) {
                buildGenreChip(nav);
                return;
            }
            if (target.hash) {
                node = el('a', null, target.label);
                node.href = target.hash;
                node.setAttribute('data-nf-hash', target.hash);

                // Home and its favourites tab share one route, so the hash alone
                // does not move between them - the tab strip does, and this skin
                // hides it. Press the real button behind the link.
                if (target.hash.indexOf('#/home') === 0) {
                    var wanted = target.hash.indexOf('tab=1') > -1 ? 1 : 0;
                    node.addEventListener('click', function () {
                        setTimeout(function () { switchHomeTab(wanted); }, 60);
                    });
                }

                /* The hash may already be this one - it is left alone while a
                 * channel plays - and setting it to itself fires nothing, so the
                 * entry would do nothing at all. Open the page directly. */
                if (target.hash.indexOf('nftv=1') > -1) {
                    node.addEventListener('click', function () {
                        if (tvState.channel) tvStop();
                        setTimeout(tvOpen, 30);
                    });
                }

                // A server split by genre has many libraries of one type. They
                // hang off the matching nav item as a dropdown instead of being
                // dropped, so every catalogue page is one hover away.
                var siblings = (navViews || []).filter(function (view) {
                    return view.CollectionType === target.collectionType;
                });

                if (siblings.length > 1) {
                    var wrapper = el('div', 'nf-nav-item');
                    wrapper.appendChild(node);

                    // The menu lives on <body>, not inside the header. Nesting it
                    // there put it in the header's stacking context, and page
                    // content painted straight over it however high its z-index
                    // went - hit-testing under an open menu returned a card.
                    var menu = el('div', 'nf-nav-menu');
                    siblings.forEach(function (view) {
                        var link = el('a', null, view.Name);
                        link.href =
                            (view.CollectionType === 'tvshows' ? '#/tv?topParentId=' : '#/movies?topParentId=') +
                            view.Id;
                        link.addEventListener('click', function () {
                            menu.classList.remove('is-open');
                        });
                        menu.appendChild(link);
                    });
                    document.body.appendChild(menu);

                    var open = function () {
                        var rect = node.getBoundingClientRect();
                        menu.style.left = Math.round(rect.left) + 'px';
                        menu.style.top = Math.round(rect.bottom + 4) + 'px';
                        menu.classList.add('is-open');
                    };
                    var close = function () {
                        setTimeout(function () {
                            if (!wrapper.matches(':hover') && !menu.matches(':hover')) {
                                menu.classList.remove('is-open');
                            }
                        }, 120);
                    };

                    wrapper.addEventListener('mouseenter', open);
                    wrapper.addEventListener('mouseleave', close);
                    menu.addEventListener('mouseenter', function () {
                        menu.classList.add('is-open');
                    });
                    menu.addEventListener('mouseleave', close);

                    nav.appendChild(wrapper);
                    return;
                }
            } else {
                node = el('button', null, target.label);
                node.type = 'button';
                node.setAttribute('data-nf-tab', String(target.index));
                node.addEventListener('click', function () {
                    target.tab.click();
                    setTimeout(function () {
                        markActive(nav);
                    }, 120);
                });
            }
            nav.appendChild(node);
        });

        left.appendChild(nav);
        markActive(nav);
    }

    /* Rebuilt with the nav, so a previous build's menu does not stay on <body>
       collecting listeners. */
    function clearGenreMenus() {
        document.querySelectorAll('.nf-nav-menu-genres').forEach(function (node) {
            node.remove();
        });
    }

    /* ------------------------------------------------------- detail page */

    /* Netflix's title card carries its own key art. Jellyfin paints the backdrop
     * on a fixed, full-viewport layer instead, so the art is rebuilt inside the
     * card - and the logo, which Jellyfin parks outside the container, is moved
     * in so it can be positioned against it. */
    function mountDetailArt() {
        var container = document.querySelector('.detailPagePrimaryContainer');
        if (!container) return;

        var id = currentDetailId();
        if (!id) return;

        var client = api();
        if (!client) return;

        // The logo is worth painting at any width; the card is not.
        paintDetailLogo(id, client);

        /* Netflix's title card - 16:9 art with the logo and the actions laid on
         * it - is a wide-screen shape, and the app gives the phone a different
         * page entirely. Building the card there anyway left a 107pt black band
         * above Jellyfin's own layout with the action row overlapping it. Until
         * that page is drawn properly the phone keeps Jellyfin's, which at least
         * holds together. */
        if (isPhone()) {
            var stale = container.querySelector('.nf-detail-art');
            if (stale) {
                var oldRibbon = stale.querySelector('.detailRibbon');
                if (oldRibbon) container.appendChild(oldRibbon);
                var oldLogo = stale.querySelector('.detailLogo');
                if (oldLogo) container.appendChild(oldLogo);
                stale.remove();
            }

            /* In Jellyfin's mobile layout .itemBackdrop is an empty div - the art
             * goes into the fixed .backdropContainer behind the page, which this
             * skin covers - so the top of the page was a black band. Paint it, and
             * put the logo on it, which is the shape the app uses. */
            /* The app's title page carries no logo on the art - the name is set
             * in text underneath it, left aligned with everything else. Leaving
             * the logo where Jellyfin put it keeps that simple. */
            var backdrop = document.querySelector('.itemBackdrop');
            var mark = document.querySelector('.detailLogo');
            if (backdrop && mark && mark.parentElement === backdrop) {
                container.appendChild(mark);
            }
            return;
        }

        var art = container.querySelector('.nf-detail-art');
        if (!art || art.dataset.nfId !== id) {
            if (art) art.remove();
            art = el('div', 'nf-detail-art');
            art.dataset.nfId = id;
            art.style.backgroundImage =
                'url("' + client.getImageUrl(id, { type: 'Backdrop', maxWidth: 1280 }) + '")';
            container.insertBefore(art, container.firstChild);
        }

        // Logo and action row live on the art, so they have to be inside it -
        // absolute offsets resolve against the nearest positioned ancestor, and
        // the container wraps the whole card, copy included.
        var logo = document.querySelector('.detailLogo');
        if (logo && logo.parentElement !== art) {
            art.appendChild(logo);
        }

        var ribbon = document.querySelector('.detailRibbon');
        if (ribbon && ribbon.parentElement !== art) {
            art.appendChild(ribbon);
        }
    }

    var detailItems = {};

    /* Jellyfin leaves .detailLogo empty on this layout - it paints the logo only
     * when it is drawing its own page backdrop, which this skin replaces - so the
     * element was there, blank, and the title text stayed on top of artwork that
     * often carries the logo already. Waiting for a background-image that is never
     * coming was eight polls of nothing; ask the server instead. */
    function paintDetailLogo(id, client) {
        var apply = function (item) {
            if (currentDetailId() !== id) return;

            if (isPhone()) {
                var backdrop = document.querySelector('.itemBackdrop');
                var wide = item && item.BackdropImageTags && item.BackdropImageTags[0];
                if (backdrop && wide) {
                    var art = client.getImageUrl(id, { type: 'Backdrop', maxWidth: 900, tag: wide });
                    if (backdrop.dataset.nfArt !== art) {
                        backdrop.dataset.nfArt = art;
                        backdrop.style.backgroundImage = 'url("' + art + '")';
                    }
                }
            }

            var logo = document.querySelector('.detailLogo');
            var tag = item && item.ImageTags && item.ImageTags.Logo;
            if (logo && tag) {
                var url = client.getImageUrl(id, { type: 'Logo', maxWidth: 640, tag: tag });
                if (logo.dataset.nfLogo !== url) {
                    logo.dataset.nfLogo = url;
                    logo.style.backgroundImage = 'url("' + url + '")';
                }
            }
            document.body.classList.toggle('nf-detail-logo', !!(logo && tag));
        };

        if (detailItems[id]) {
            apply(detailItems[id]);
            return;
        }

        client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                // Only a real answer is kept - a rejected one has to be askable again.
                if (item) detailItems[id] = item;
                apply(item);
            })
            .catch(function (err) {
                log('could not read the title for its logo', err);
            });
    }

    function currentDetailId() {
        var match = window.location.hash.match(/[?&]id=([^&]+)/);
        return match ? match[1] : null;
    }

    function decorateDetail() {
        var onDetail = /#\/details/.test(window.location.hash);
        document.body.classList.toggle('nf-detail', onDetail);
        if (!onDetail) {
            document.body.classList.remove('nf-detail-logo');
            return;
        }

        // mountDetailArt paints the logo and sets nf-detail-logo with it.
        mountDetailArt();

        document.querySelectorAll('.mainDetailButtons .btnPlay, .mainDetailButtons .btnResume')
            .forEach(function (button) {
                var content = button.querySelector('.detailButton-content');
                var label = button.getAttribute('title');
                if (content && label && content.getAttribute('data-nf-label') !== label) {
                    content.setAttribute('data-nf-label', label);
                }
            });
    }

    /* ------------------------------------------------------- row controls */

    /* Netflix gives every row two affordances Jellyfin has no equivalent for: an
     * edge arrow on hover that pages the row by exactly one screenful, and a set
     * of dashes on the heading line showing which page you are on. */
    function decorateRows(root) {
        (root || document)
            .querySelectorAll('.itemsContainer.scrollSlider')
            .forEach(function (slider) {
                var section = slider.closest('.verticalSection') || slider.parentElement;
                if (!section) return;

                // A library page uses the same container class as a carousel but
                // wraps onto several lines. Treating it as a row applies
                // row-width rules and leaves the posters touching, so it is
                // marked and styled as the grid it is.
                var cards = slider.querySelectorAll('.card');
                if (cards.length > 1) {
                    var firstTop = cards[0].getBoundingClientRect().top;
                    var wrapped = Array.prototype.some.call(cards, function (card) {
                        return Math.abs(card.getBoundingClientRect().top - firstTop) > 4;
                    });
                    slider.classList.toggle('nf-grid', wrapped);
                    if (wrapped) return;
                }

                section.classList.add('nf-row');
                if (getComputedStyle(section).position === 'static') {
                    section.style.position = 'relative';
                }

                var prev = section.querySelector('.nf-row-arrow-prev');
                var next = section.querySelector('.nf-row-arrow-next');

                if (!prev) {
                    prev = el('button', 'nf-row-arrow nf-row-arrow-prev');
                    prev.type = 'button';
                    prev.setAttribute('aria-label', 'Indietro');
                    prev.appendChild(icon('chevron_left'));
                    prev.addEventListener('click', function (event) {
                        event.stopPropagation();
                        slider.scrollBy({ left: -slider.clientWidth, behavior: 'smooth' });
                    });
                    section.appendChild(prev);
                }

                if (!next) {
                    next = el('button', 'nf-row-arrow nf-row-arrow-next');
                    next.type = 'button';
                    next.setAttribute('aria-label', 'Avanti');
                    next.appendChild(icon('chevron_right'));
                    next.addEventListener('click', function (event) {
                        event.stopPropagation();
                        slider.scrollBy({ left: slider.clientWidth, behavior: 'smooth' });
                    });
                    section.appendChild(next);
                }

                var bar = section.querySelector('.sectionTitleContainer');
                var dots = section.querySelector('.nf-row-dots');
                if (bar && !dots) {
                    dots = el('div', 'nf-row-dots');
                    bar.appendChild(dots);
                }

                function update() {
                    var card = slider.querySelector('.card');
                    if (card) {
                        // The arrows cover the tiles, not the row's padding.
                        var cardRect = card.getBoundingClientRect();
                        var sectionRect = section.getBoundingClientRect();
                        var top = Math.round(cardRect.top - sectionRect.top);
                        var height = Math.round(cardRect.height);
                        [prev, next].forEach(function (arrow) {
                            arrow.style.top = top + 'px';
                            arrow.style.height = height + 'px';
                        });
                    }

                    var pages = Math.max(1, Math.ceil(slider.scrollWidth / slider.clientWidth));
                    var page = Math.round(slider.scrollLeft / slider.clientWidth);

                    prev.classList.toggle('is-disabled', slider.scrollLeft < 8);
                    next.classList.toggle(
                        'is-disabled',
                        slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 8
                    );

                    if (!dots) return;
                    if (dots.children.length !== pages) {
                        dots.textContent = '';
                        for (var i = 0; i < pages; i++) dots.appendChild(el('span'));
                    }
                    Array.prototype.forEach.call(dots.children, function (dot, i) {
                        dot.classList.toggle('is-active', i === page);
                    });
                }

                if (!slider.dataset.nfRowBound) {
                    slider.dataset.nfRowBound = '1';
                    // Scroll only. A resize listener here would be per-row and could
                    // never be removed - jellyfin-web swaps whole pages, so each visit
                    // minted another one, and every retained closure pinned its own
                    // detached row subtree in memory for the life of the tab. One
                    // listener in start() calls decorateRows instead.
                    slider.addEventListener('scroll', update, { passive: true });
                }

                update();
            });
    }

    /* ------------------------------------------------------------- Top 10 */

    function decorateTop10() {
        if (!cfg.enableTop10) return;
        document.querySelectorAll('.verticalSection').forEach(function (section) {
            var title = section.querySelector('.sectionTitle');
            var isTop10 = title && TOP10_RE.test(title.textContent || '');
            section.classList.toggle('nf-top10', !!isTop10);
            if (!isTop10) return;

            Array.prototype.forEach.call(
                section.querySelectorAll('.itemsContainer > .card'),
                function (card, i) {
                    if (i >= 10) {
                        card.style.display = 'none';
                        return;
                    }
                    // On the card itself: the box clips its own overflow for the
                    // rounded corners, which swallowed the numeral.
                    card.setAttribute('data-nf-rank', String(i + 1));
                }
            );
        });
    }

    /* ------------------------------------------------- 16:9 row artwork */

    var PORTRAIT_CARD = /(\b|-)(overflowPortrait|portrait|overflowSquare|square)Card\b/;

    /* Netflix rows show wide, purpose-made key art. Jellyfin's equivalent is the
     * Thumb image - NOT the backdrop, which is a frame from the film and looks
     * wrong as a tile. A row is converted only when every item in it has a Thumb,
     * because a row of mixed shapes is twice as tall as it needs to be; rows
     * without one keep the posters Jellyfin picked. One request answers a row. */
    /* Which of a row's items have 16:9 key art. One entry per item id, shared by
     * every row - the home screen repeats titles across "continue watching",
     * "recently added" and the genre rows, so the same id was being asked about
     * several times over. */
    var thumbTags = {};
    var thumbQueue = [];
    var thumbFlush = null;

    function widenCards(root) {
        if (!cfg.useWideThumbnails) return;

        var client = api();
        if (!client) return;

        (root || document)
            .querySelectorAll('.homeSectionsContainer .itemsContainer.scrollSlider')
            .forEach(function (row) {
                if (row.dataset.nfThumb) return;

                // A Top 10 row keeps its upright posters: the rank numeral sits
                // beside the artwork and a 16:9 thumb leaves it nowhere to go.
                if (row.closest('.nf-top10')) {
                    row.dataset.nfThumb = 'top10';
                    return;
                }

                // The row exists before its cards are rendered into it; deciding
                // now would settle the question against an empty row forever.
                var all = row.querySelectorAll('.card[data-id]');
                if (!all.length) return;

                var cards = Array.prototype.filter.call(all, function (card) {
                    return PORTRAIT_CARD.test(card.className);
                });

                if (!cards.length) {
                    row.dataset.nfThumb = 'skip';
                    return;
                }

                row.dataset.nfThumb = 'pending';
                thumbQueue.push({ row: row, cards: cards, client: client });

                // Rows arrive one after another as jellyfin-web renders them, and
                // asking per row meant eight separate round trips for one home
                // screen. Waiting a moment collects them into one.
                if (!thumbFlush) thumbFlush = setTimeout(flushThumbs, 80);
            });
    }

    function flushThumbs() {
        thumbFlush = null;
        var batch = thumbQueue;
        thumbQueue = [];
        if (!batch.length) return;

        var client = batch[0].client;
        var wanted = {};
        batch.forEach(function (job) {
            job.cards.forEach(function (card) {
                var id = card.dataset.id;
                if (!(id in thumbTags)) wanted[id] = true;
            });
        });

        var ids = Object.keys(wanted);
        var lookup = ids.length
            ? client
                .getItems(client.getCurrentUserId(), {
                    Ids: ids.join(','),
                    EnableImageTypes: 'Thumb',
                    EnableUserData: false,
                    EnableTotalRecordCount: false
                })
                .then(function (result) {
                    // Absent means asked and not there, so it is never asked again.
                    ids.forEach(function (id) { thumbTags[id] = null; });
                    (result.Items || []).forEach(function (item) {
                        thumbTags[item.Id] =
                            (item.ImageTags && item.ImageTags.Thumb) || null;
                    });
                })
            : Promise.resolve();

        lookup
            .then(function () {
                batch.forEach(function (job) { applyThumbs(job); });
            })
            .catch(function (err) {
                batch.forEach(function (job) { job.row.dataset.nfThumb = 'error'; });
                log('thumb lookup failed', err);
            });
    }

    /* Row-atomic on purpose: a row where only some items have key art would come
     * out half 16:9 and half portrait, at two different heights. */
    function applyThumbs(job) {
        var complete = job.cards.every(function (card) {
            return thumbTags[card.dataset.id];
        });

        if (!complete) {
            job.row.dataset.nfThumb = 'no-thumbs';
            return;
        }

        job.cards.forEach(function (card) {
            var container = card.querySelector('.cardImageContainer');
            if (!container) return;

            var url = job.client.getImageUrl(card.dataset.id, {
                type: 'Thumb',
                maxWidth: 640,
                tag: thumbTags[card.dataset.id]
            });

            // Jellyfin drops its blurhash when its own image loads. Ours is a
            // different URL, so that never fires.
            var preload = new Image();
            preload.onload = function () {
                container.classList.remove('blurhashed');
            };
            preload.src = url;

            container.dataset.nfThumbUrl = url;
            container.style.backgroundImage = 'url("' + url + '")';
            card.classList.add('nf-thumb');
        });

        job.row.dataset.nfThumb = 'yes';
        log('thumbed row of', job.cards.length);
    }

    /* Jellyfin re-loads a row's posters when it scrolls into view, writing the
     * Primary URL straight back over ours. Rather than fight for the write, the
     * swap is re-applied whenever it is found undone. */
    function reapplyThumbs() {
        document.querySelectorAll('.card.nf-thumb .cardImageContainer').forEach(function (container) {
            var url = container.dataset.nfThumbUrl;
            if (!url) return;
            if ((container.style.backgroundImage || '').indexOf(url) === -1) {
                container.style.backgroundImage = 'url("' + url + '")';
            }
            // Only when it is actually there. classList.remove on a class the element
            // does not carry still writes the class attribute, and this runs over every
            // swapped tile on the page - 640 of them on this library - on every pass.
            if (container.classList.contains('blurhashed')) {
                container.classList.remove('blurhashed');
            }
        });
    }

    /* ------------------------------------------------------------- modal */

    /* Netflix never leaves the page to show a title: details open in a modal over
     * whatever you were browsing. Jellyfin routes to a details page instead, so
     * clicks on a playable card are intercepted and answered with this. */
    var modalScrim = null;

    function closeModal() {
        if (!modalScrim) return;
        var node = modalScrim;
        modalScrim = null;
        node.classList.remove('is-open');
        document.body.style.overflow = '';
        setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, 220);
    }

    function modalCircle(glyph, title, onClick) {
        var button = el('button', 'nf-circle');
        button.type = 'button';
        button.title = title;
        button.appendChild(icon(glyph));
        button.addEventListener('click', onClick);
        return button;
    }

    function factRow(label, value) {
        if (!value) return null;
        var row = el('div');
        row.appendChild(el('dt', null, label + ':'));
        row.appendChild(el('dd', null, value));
        return row;
    }

    function buildEpisodes(item, client, mount, focusSeasonId) {
        client
            .getJSON(client.getUrl('Shows/' + item.Id + '/Seasons', {
                userId: client.getCurrentUserId()
            }))
            .then(function (result) {
                var seasons = result.Items || [];
                if (!seasons.length) return;

                var head = el('div', 'nf-modal-episodes-head');
                head.appendChild(el('h3', null, 'Episodi'));

                var select = el('select', 'nf-modal-season');
                seasons.forEach(function (season) {
                    var option = el('option', null, season.Name);
                    option.value = season.Id;
                    select.appendChild(option);
                });
                head.appendChild(select);
                mount.appendChild(head);

                var list = el('div');
                mount.appendChild(list);

                function loadSeason(seasonId) {
                    list.textContent = '';
                    client
                        .getJSON(client.getUrl('Shows/' + item.Id + '/Episodes', {
                            userId: client.getCurrentUserId(),
                            seasonId: seasonId,
                            fields: 'Overview'
                        }))
                        .then(function (episodes) {
                            var all = episodes.Items || [];

                            // Netflix shows ten and hides the rest behind a
                            // chevron at the foot of the list.
                            if (all.length > 10) {
                                var more = el('button', 'nf-episodes-more');
                                more.type = 'button';
                                more.setAttribute('aria-label', 'Mostra altri episodi');
                                more.appendChild(icon('expand_more'));
                                more.addEventListener('click', function () {
                                    list.classList.remove('is-collapsed');
                                    more.remove();
                                });
                                list.classList.add('is-collapsed');
                                setTimeout(function () {
                                    list.parentNode.insertBefore(more, list.nextSibling);
                                }, 0);
                            }

                            all.forEach(function (episode, i) {
                                var row = el('div', 'nf-episode');
                                row.appendChild(el('div', 'nf-episode-index', String(episode.IndexNumber || i + 1)));

                                var thumb = el('div', 'nf-episode-thumb');
                                thumb.style.backgroundImage =
                                    'url("' +
                                    client.getImageUrl(episode.Id, { type: 'Primary', maxWidth: 320 }) +
                                    '")';
                                row.appendChild(thumb);

                                var text = el('div');
                                text.appendChild(el('h4', 'nf-episode-title', episode.Name));
                                text.appendChild(el('p', 'nf-episode-overview', episode.Overview || ''));
                                row.appendChild(text);

                                var mins = minutes(episode.RunTimeTicks);
                                row.appendChild(el('div', 'nf-episode-duration', mins ? mins + 'm' : ''));

                                row.addEventListener('click', function () {
                                    closeModal();
                                    playNow(episode.Id, episode.ServerId, episode.Type);
                                });

                                list.appendChild(row);
                            });
                        });
                }

                select.addEventListener('change', function () {
                    loadSeason(select.value);
                });

                // Opened from an episode, the list starts on that episode's
                // season rather than the first.
                var start = focusSeasonId && seasons.some(function (season) {
                    return season.Id === focusSeasonId;
                })
                    ? focusSeasonId
                    : seasons[0].Id;
                select.value = start;
                loadSeason(start);
            })
            .catch(function (err) {
                log('episodes failed', err);
            });
    }

    /* "Altri titoli simili" - the suggestions grid both Netflix modals carry. */
    function buildSimilar(item, client, mount) {
        client
            // Jellyfin's query parameters are PascalCase; a lowercase "limit" is
            // ignored and the server returns its own default count.
            .getJSON(client.getUrl('Items/' + item.Id + '/Similar', {
                UserId: client.getCurrentUserId(),
                Limit: 9,
                Fields: 'Overview,Genres,ProductionYear,OfficialRating'
            }))
            .then(function (result) {
                // The endpoint returns its own count whatever Limit is passed, so
                // the nine Netflix shows are taken here.
                var items = (result.Items || []).slice(0, 9);
                if (!items.length) return;

                mount.appendChild(el('h3', null, 'Altri titoli simili'));
                var grid = el('div', 'nf-similar');

                items.forEach(function (similar) {
                    var card = el('div', 'nf-similar-card');

                    var art = el('div', 'nf-similar-art');
                    var type = similar.ImageTags && similar.ImageTags.Thumb ? 'Thumb' : 'Primary';
                    art.style.backgroundImage =
                        'url("' + client.getImageUrl(similar.Id, { type: type, maxWidth: 400 }) + '")';
                    card.appendChild(art);

                    var body = el('div', 'nf-similar-body');
                    var meta = el('div', 'nf-similar-meta');
                    if (similar.CommunityRating) {
                        meta.appendChild(
                            el('span', 'nf-match', Math.round(similar.CommunityRating * 10) + '%')
                        );
                    }
                    if (similar.ProductionYear) {
                        meta.appendChild(el('span', null, String(similar.ProductionYear)));
                    }
                    var runtime = runtimeLabel(similar);
                    if (runtime) meta.appendChild(el('span', null, runtime));
                    body.appendChild(meta);

                    body.appendChild(el('h4', 'nf-similar-name', similar.Name));
                    body.appendChild(el('p', 'nf-similar-overview', similar.Overview || ''));
                    card.appendChild(body);

                    card.addEventListener('click', function () {
                        openModal(similar.Id);
                    });

                    grid.appendChild(card);
                });

                mount.appendChild(grid);
            })
            .catch(function (err) {
                log('similar failed', err);
            });
    }

    /* "Informazioni su <titolo>" - the long-form credits Netflix puts last. */
    function buildAbout(item) {
        var section = el('div', 'nf-modal-section nf-modal-about');
        section.appendChild(el('h3', null, 'Informazioni su ' + item.Name));

        var people = item.People || [];
        var byType = function (type) {
            return people
                .filter(function (person) {
                    return person.Type === type;
                })
                .map(function (person) {
                    return person.Name;
                })
                .join(', ');
        };

        [
            ['Regia', byType('Director')],
            ['Cast', byType('Actor')],
            ['Sceneggiatura', byType('Writer')],
            ['Generi', (item.Genres || []).join(', ')],
            ['Questo titolo è', (item.Tags || []).slice(0, 6).join(', ')],
            ['Classificazione', item.OfficialRating]
        ].forEach(function (pair) {
            if (!pair[1]) return;
            var row = el('div');
            row.appendChild(el('span', 'nf-label', pair[0] + ': '));
            row.appendChild(el('span', null, pair[1]));
            section.appendChild(row);
        });

        return section;
    }

    function buildModal(item, client, episode) {
        var scrim = el('div', 'nf-modal-scrim');
        scrim.addEventListener('click', function (event) {
            if (event.target === scrim) closeModal();
        });

        var modal = el('div', 'nf-modal');

        // An episode has no backdrop of its own - its artwork is the still, which
        // Jellyfin files as Primary. Anything else without a backdrop falls back
        // the same way rather than showing an empty header.
        // Headed by the episode's own still when there is one.
        var art = el('div', 'nf-modal-art');
        var hasBackdrop = !!(item.BackdropImageTags && item.BackdropImageTags.length);
        var artSource = episode || item;
        var artType = episode || !hasBackdrop ? 'Primary' : 'Backdrop';
        art.style.backgroundImage =
            'url("' + client.getImageUrl(artSource.Id, { type: artType, maxWidth: 1280 }) + '")';

        var close = el('button', 'nf-modal-close');
        close.type = 'button';
        close.title = 'Chiudi';
        close.appendChild(icon('close'));
        close.addEventListener('click', closeModal);
        art.appendChild(close);

        var hero = el('div', 'nf-modal-hero');
        if (item.ImageTags && item.ImageTags.Logo) {
            var logo = el('img', 'nf-modal-logo');
            logo.src = client.getImageUrl(item.Id, { type: 'Logo', maxWidth: 480 });
            logo.alt = item.Name;
            hero.appendChild(logo);
        } else {
            hero.appendChild(el('h2', 'nf-modal-title', item.Name));
        }

        // The resume bar Netflix draws over the art: "17 di 44min".
        var resumeOf = episode || item;
        var position = resumeOf.UserData && resumeOf.UserData.PlaybackPositionTicks;
        if (position && resumeOf.RunTimeTicks) {
            var bar = el('div', 'nf-modal-resume');
            var fill = el('span');
            fill.style.width = Math.min(100, (position / resumeOf.RunTimeTicks) * 100) + '%';
            bar.appendChild(fill);
            var done = minutes(position);
            var total = minutes(resumeOf.RunTimeTicks);
            bar.appendChild(el('em', null, done + ' di ' + total + 'min'));
            hero.appendChild(bar);
        }

        var actions = el('div', 'nf-modal-actions');
        var play = el('button', 'nf-btn nf-btn-primary');
        play.type = 'button';
        play.appendChild(icon('play_arrow'));
        play.appendChild(el('span', null, position ? 'Riprendi' : 'Riproduci'));
        play.addEventListener('click', function () {
            closeModal();
            playNow(resumeOf.Id, resumeOf.ServerId, resumeOf.Type);
        });
        actions.appendChild(play);

        var isFav = !!(item.UserData && item.UserData.IsFavorite);
        var fav = modalCircle(isFav ? 'favorite' : 'add', 'Preferiti', function () {
            client.updateFavoriteStatus(client.getCurrentUserId(), item.Id, !isFav).then(function () {
                isFav = !isFav;
                fav.replaceChildren(icon(isFav ? 'favorite' : 'add'));
            });
        });
        actions.appendChild(fav);

        actions.appendChild(
            modalCircle('check', 'Segna come visto', function () {
                client.markPlayed(client.getCurrentUserId(), item.Id, new Date());
            })
        );

        hero.appendChild(actions);
        art.appendChild(hero);
        modal.appendChild(art);

        var body = el('div', 'nf-modal-body');
        var left = el('div');

        var meta = el('div', 'nf-modal-meta');
        if (item.CommunityRating) {
            meta.appendChild(el('span', 'nf-match', Math.round(item.CommunityRating * 10) + '% consigliato'));
        }
        if (item.ProductionYear) meta.appendChild(el('span', null, String(item.ProductionYear)));
        var runtime = runtimeLabel(item);
        if (runtime) meta.appendChild(el('span', null, runtime));
        meta.appendChild(el('span', 'nf-badge', 'HD'));
        if (item.OfficialRating) meta.appendChild(el('span', 'nf-badge', item.OfficialRating));
        left.appendChild(meta);

        // With an episode in focus its title and synopsis lead, as Netflix shows
        // S4:E8 "Episodio 8" above the episode's own description.
        if (episode) {
            var heading =
                'S' + (episode.ParentIndexNumber || 1) + ':E' + (episode.IndexNumber || 1) +
                ' "' + episode.Name + '"';
            left.appendChild(el('h3', 'nf-modal-episode-heading', heading));
        }

        left.appendChild(el('p', 'nf-modal-overview', (episode || item).Overview || ''));
        body.appendChild(left);

        var facts = el('dl', 'nf-modal-facts');
        var people = item.People || [];
        var cast = people
            .filter(function (person) {
                return person.Type === 'Actor';
            })
            .slice(0, 4)
            .map(function (person) {
                return person.Name;
            })
            .join(', ');
        var directors = people
            .filter(function (person) {
                return person.Type === 'Director';
            })
            .map(function (person) {
                return person.Name;
            })
            .join(', ');

        [
            factRow('Cast', cast),
            factRow('Regia', directors),
            factRow('Generi', (item.Genres || []).join(', ')),
            factRow('Tag', (item.Tags || []).slice(0, 5).join(', '))
        ].forEach(function (row) {
            if (row) facts.appendChild(row);
        });
        body.appendChild(facts);
        modal.appendChild(body);

        // Only a series gets the episode block; a film goes straight to the
        // suggestions, which is the difference between Netflix's two modals.
        if (item.Type === 'Series') {
            var episodes = el('div', 'nf-modal-section nf-modal-episodes');
            modal.appendChild(episodes);
            buildEpisodes(item, client, episodes, episode ? episode.SeasonId : null);
        }

        var similar = el('div', 'nf-modal-section');
        modal.appendChild(similar);
        buildSimilar(item, client, similar);

        modal.appendChild(buildAbout(item));

        scrim.appendChild(modal);
        document.body.appendChild(scrim);
        document.body.style.overflow = 'hidden';

        void scrim.offsetHeight;
        scrim.classList.add('is-open');
        modalScrim = scrim;
    }

    /* Netflix has no separate modal for an episode: it opens the series, headed
     * by that episode - its still, its S:E title and synopsis, its resume bar -
     * with the episode list already on the right season. */
    function openModal(id) {
        var client = api();
        if (!client || !id) return;

        destroyPreview();
        closeModal();

        client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                if (item.Type !== 'Episode' || !item.SeriesId) {
                    buildModal(item, client);
                    return;
                }
                return client
                    .getItem(client.getCurrentUserId(), item.SeriesId)
                    .then(function (series) {
                        buildModal(series, client, item);
                    });
            })
            .catch(function (err) {
                log('modal failed', err);
            });
    }

    var MODAL_TYPES = { Movie: 1, Series: 1, Season: 1, Episode: 1, Video: 1 };

    function bindModal() {
        if (document.body.dataset.nfModalBound) return;
        document.body.dataset.nfModalBound = '1';

        // Bound on window, not document: capture runs outermost-first, and
        // Jellyfin's own card handler is already on document, so a document-level
        // listener registered later still fires second and the route change goes
        // through underneath the modal. stopImmediatePropagation is what actually
        // keeps it from navigating.
        window.addEventListener(
            'click',
            function (event) {
                if (!event.target.closest) return;

                // Never swallow a click meant for one of Jellyfin's own controls.
                if (event.target.closest('.cardOverlayButton, .nf-preview, .nf-modal')) return;

                var card = event.target.closest('.card[data-id]');
                if (!card) return;
                if (!MODAL_TYPES[card.getAttribute('data-type')]) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                openModal(card.dataset.id);
            },
            true
        );

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeModal();
        });
    }

    /* --------------------------------------------------- preview card */

    var preview = null;
    var previewCard = null;
    var openTimer = null;
    var closeTimer = null;
    var pointerInside = false;

    function destroyPreview() {
        if (!preview) return;
        var node = preview;
        preview = null;
        previewCard = null;
        node.classList.remove('is-open');
        setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, 200);
    }

    function scheduleClose() {
        pointerInside = false;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(function () {
            if (!pointerInside) destroyPreview();
        }, 140);
    }

    function keepOpen() {
        pointerInside = true;
        clearTimeout(closeTimer);
    }

    /* A confirmation, because the action behind it cannot be undone accurately:
     * Jellyfin records that an episode was watched, not that this button was what
     * said so, and marking the series unwatched afterwards would also clear the
     * episodes you really had seen. */
    function confirmRemoval(title, episodes, proceed, episodeLabel) {
        var scrim = el('div', 'nf-confirm-scrim');
        var box = el('div', 'nf-confirm');

        box.appendChild(el('h3', null, 'Rimuovere ' + title + ' dalla riga?'));

        /* Spelling out that this tile is not an episode. In the "Prossimo" half the
         * row holds series, not episodes: the tile is a bookmark saying where you
         * are, so removing "just this one" moves the bookmark on and the series
         * stays. That is not obvious from looking at it, and it is the difference
         * between a harmless press and marking a whole series watched. */
        if (episodeLabel) {
            box.appendChild(
                el(
                    'p',
                    'nf-confirm-note',
                    'Questo riquadro non è un episodio in elenco: è il segnalibro ' +
                        'della serie, fermo su ' + episodeLabel + '. Toglierlo da solo lo ' +
                        'farebbe semplicemente avanzare all’episodio successivo.'
                )
            );
        }

        box.appendChild(
            el(
                'p',
                null,
                episodes
                    ? "Per togliere la serie dalla riga Jellyfin ha un solo modo: segnarla " +
                      "come vista. " + episodes +
                      (episodes === 1
                          ? ' episodio non visto verrà segnato come visto.'
                          : ' episodi non visti verranno segnati come visti.') +
                      ' Non si torna indietro con precisione.'
                    : "Per togliere la serie dalla riga Jellyfin ha un solo modo: segnare " +
                      "come visti i suoi episodi. Non si torna indietro con precisione."
            )
        );

        var actions = el('div', 'nf-confirm-actions');
        var cancel = el('button', 'nf-btn nf-btn-secondary');
        cancel.type = 'button';
        cancel.appendChild(el('span', null, 'Annulla'));
        var ok = el('button', 'nf-btn nf-btn-primary');
        ok.type = 'button';
        ok.appendChild(el('span', null, 'Segna come vista'));
        actions.appendChild(cancel);
        actions.appendChild(ok);
        box.appendChild(actions);

        var close = function () {
            scrim.remove();
            document.removeEventListener('keydown', onKey);
        };
        var onKey = function (event) {
            if (event.key === 'Escape') close();
        };

        cancel.addEventListener('click', close);
        scrim.addEventListener('click', function (event) {
            if (event.target === scrim) close();
        });
        document.addEventListener('keydown', onKey);
        ok.addEventListener('click', function () {
            close();
            proceed();
        });

        scrim.appendChild(box);
        document.body.appendChild(scrim);
        ok.focus();
    }

    function buildPreview(card, item, client) {
        var rect = card.getBoundingClientRect();
        var width = Math.round(rect.width * 1.38);
        var artHeight = Math.round((width * 9) / 16);

        var panel = el('div', 'nf-preview');
        panel.style.width = width + 'px';

        var art = el('div', 'nf-preview-art');
        var imageType = item.ImageTags && item.ImageTags.Thumb ? 'Thumb' : 'Primary';
        art.style.backgroundImage =
            'url("' +
            client.getImageUrl(item.Id, {
                type: imageType,
                maxWidth: 640,
                tag: item.ImageTags ? item.ImageTags[imageType] : undefined
            }) +
            '")';
        art.style.height = artHeight + 'px';
        art.addEventListener('click', function () {
            destroyPreview();
            openModal(item.Id);
        });
        panel.appendChild(art);

        var body = el('div', 'nf-preview-body');

        var actions = el('div', 'nf-preview-actions');
        var play = el('button', 'nf-circle nf-circle-play');
        play.type = 'button';
        play.title = 'Play';
        play.appendChild(icon('play_arrow'));
        play.addEventListener('click', function () {
            destroyPreview();
            playNow(item.Id, item.ServerId, item.Type);
        });

        var fav = el('button', 'nf-circle');
        fav.type = 'button';
        fav.title = 'Aggiungi a La mia lista';
        var isFav = item.UserData && item.UserData.IsFavorite;
        fav.appendChild(icon(isFav ? 'favorite' : 'add'));
        fav.addEventListener('click', function () {
            var userId = client.getCurrentUserId();
            var call = isFav
                ? client.updateFavoriteStatus(userId, item.Id, false)
                : client.updateFavoriteStatus(userId, item.Id, true);
            call.then(function () {
                isFav = !isFav;
                fav.replaceChildren(icon(isFav ? 'favorite' : 'add'));
            });
        });

        /* Netflix's rating control is one button that opens three: thumb down, thumb
         * up, and a double thumb up for "love this".
         *
         * Likes is a nullable boolean and holds two of the three; the third lives
         * in a playlist (see loveLoad). Clearing needs DELETE: a POST to UserData
         * applies the fields it is given and ignores nulls, so sending a null
         * leaves the old value exactly where it was. Every change clears first
         * and then sets. */
        var liked = item.UserData ? item.UserData.Likes : null;
        var loved = false;
        var rate = el('div', 'nf-rate');
        var rateBtn = el('button', 'nf-circle nf-rate-open');
        rateBtn.type = 'button';
        // Netflix leaves the collapsed button unlabelled until a rating is held.
        rateBtn.title = '';

        var paintRate = function () {
            rateBtn.replaceChildren(
                svgIcon(loved ? 'thumblove' : liked === false ? 'thumbdown' : 'thumbup')
            );
            rateBtn.classList.toggle('is-rated', liked === true || liked === false);
            rateBtn.title = loved
                ? 'Adoro!'
                : liked === true ? 'Mi piace'
                    : liked === false ? 'Non fa per me' : '';
        };

        // The list arrives on its own schedule; repaint when it does.
        loveLoad().then(function () {
            if (loveHas(item.Id) && liked === true) {
                loved = true;
                paintRate();
            }
        });

        var setRating = function (choice) {
            var userId = client.getCurrentUserId();

            // Pressing the one you already hold clears it, which is how Netflix
            // un-rates a title.
            var held = loved ? 'love' : liked === true ? 'up' : liked === false ? 'down' : null;
            var next = held === choice ? null : choice;

            client
                .ajax({
                    type: 'DELETE',
                    url: client.getUrl('UserItems/' + item.Id + '/Rating', { userId: userId })
                })
                .then(function () {
                    if (next === null) return null;
                    return client.ajax({
                        type: 'POST',
                        url: client.getUrl('UserItems/' + item.Id + '/UserData'),
                        data: JSON.stringify({ Likes: next !== 'down' }),
                        contentType: 'application/json'
                    });
                })
                .then(function () {
                    return next === 'love' ? loveAdd(item.Id) : loveRemove(item.Id);
                })
                .then(function () {
                    liked = next === null ? null : next !== 'down';
                    loved = next === 'love';
                    item.UserData = item.UserData || {};
                    item.UserData.Likes = liked;
                    paintRate();
                })
                .catch(function (err) {
                    log('could not save the rating', err);
                });
        };

        var options = el('div', 'nf-rate-options');
        [
            { glyph: 'thumbdown', label: 'Non fa per me', value: 'down' },
            { glyph: 'thumbup', label: 'Mi piace', value: 'up' },
            { glyph: 'thumblove', label: 'Adoro!', value: 'love' }
        ].forEach(function (choice) {
            var button = el('button', 'nf-circle nf-rate-choice');
            button.type = 'button';
            button.title = choice.label;
            button.appendChild(svgIcon(choice.glyph));
            button.addEventListener('click', function (event) {
                event.stopPropagation();
                setRating(choice.value);
            });
            options.appendChild(button);
        });

        /* Netflix opens this on hover after a 300ms debounce, not instantly, and
         * Escape closes it. Both measured off the shipped bundle. */
        var openTimer = null;
        var setOpen = function (open) {
            rate.classList.toggle('is-open', open);
        };
        rate.addEventListener('mouseenter', function () {
            clearTimeout(openTimer);
            openTimer = setTimeout(function () { setOpen(true); }, 300);
        });
        rate.addEventListener('mouseleave', function () {
            clearTimeout(openTimer);
            setOpen(false);
        });
        rateBtn.addEventListener('click', function () {
            clearTimeout(openTimer);
            setOpen(true);
        });
        rate.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') setOpen(false);
        });

        paintRate();
        rate.appendChild(rateBtn);
        rate.appendChild(options);

        var watched = el('button', 'nf-circle');
        watched.type = 'button';
        watched.title = 'Visto';
        watched.appendChild(icon('check'));
        watched.addEventListener('click', function () {
            client.markPlayed(client.getCurrentUserId(), item.Id, new Date());
            watched.style.borderColor = '#fff';
        });

        /* Only on something you are part-way through: Netflix's X takes a title out
         * of "Continue watching", and membership of that row is exactly
         * PlaybackPositionTicks > 0. Setting the position to zero is the surgical
         * way to do it - marking it played or unplayed also empties the position but
         * rewrites the watch history to get there. */
        /* Netflix puts the X on every tile in Continue Watching, so it goes on the
         * whole row rather than only on the part-watched titles. Jellyfin's row
         * mixes two kinds, and they are dismissed differently: something you are
         * part-way through leaves when its position is reset, which is surgical,
         * while a "next up" episode has no position to reset and only leaves once
         * it is marked played. */
        var inResumeRow = !!(card.closest('.verticalSection') || {}).querySelector
            && /continua a guardare|prossimo|resume|next up/i.test(
                ((card.closest('.verticalSection') || {}).querySelector('.sectionTitle') || {}).textContent || ''
            );
        var started = item.UserData && item.UserData.PlaybackPositionTicks > 0;
        var remove = null;
        if (inResumeRow || started) {
            remove = el('button', 'nf-circle');
            remove.type = 'button';
            remove.title = started
                ? 'Rimuovi dalla riga'
                : 'Rimuovi dalla riga (segna la serie come vista)';
            remove.appendChild(svgIcon('close'));
            remove.addEventListener('click', function () {
                var userId = client.getCurrentUserId();

                /* Marking a series watched is not undoable in any precise way - there
                 * is no record of which episodes you had actually seen - so it is
                 * never done silently. It happened once, to a series of 250 episodes,
                 * and the only warning was a tooltip. */
                if (!started && item.SeriesId) {
                    client
                        .getItem(userId, item.SeriesId)
                        .then(function (series) {
                            var left = (series.UserData && series.UserData.UnplayedItemCount) || 0;
                            var where = item.ParentIndexNumber && item.IndexNumber
                                ? 'S' + item.ParentIndexNumber + 'E' + item.IndexNumber +
                                  (item.Name ? ' – ' + item.Name : '')
                                : item.Name;
                            confirmRemoval(series.Name, left, function () {
                                doRemoval(userId, item.SeriesId);
                            }, where);
                        })
                        .catch(function () {
                            confirmRemoval(item.SeriesName || item.Name, 0, function () {
                                doRemoval(userId, item.SeriesId);
                            });
                        });
                    return;
                }

                doRemoval(userId, null);
            });

            var doRemoval = function (userId, seriesId) {
                /* Two different removals, because the row holds two different
                 * things.
                 *
                 * A title you are part-way through is in the row purely because
                 * PlaybackPositionTicks > 0, so zeroing that takes it out and
                 * touches nothing else.
                 *
                 * A "next up" episode is not stored anywhere: Jellyfin computes that
                 * half of the row from watch history, and TVSeriesManager has no
                 * per-series dismissal to borrow - the only exclusion it honours is
                 * a library-wide one. Marking just the episode watched therefore
                 * removes nothing; the series comes back the next day offering the
                 * episode after it, which is exactly what it was doing. The series
                 * has to be marked watched for it to actually leave. */
                var call = started
                    ? client.ajax({
                        type: 'POST',
                        url: client.getUrl('UserItems/' + item.Id + '/UserData', { userId: userId }),
                        data: JSON.stringify({ PlaybackPositionTicks: 0 }),
                        contentType: 'application/json',
                        dataType: 'json'
                    })
                    : client.markPlayed(userId, seriesId || item.Id, new Date());
                call
                    .then(function () {
                        destroyPreview();
                        // The row is server-rendered, so the tile has to go by hand.
                        var tile = card.closest('.card');
                        if (tile) tile.remove();
                    })
                    .catch(function (err) {
                        log('could not remove from continue watching', err);
                    });
            };
        }

        var expand = el('button', 'nf-circle');
        expand.type = 'button';
        expand.title = 'Episodi e info';
        expand.appendChild(icon('expand_more'));
        expand.addEventListener('click', function () {
            destroyPreview();
            openModal(item.Id);
        });

        /* Netflix's order, measured on a Continue Watching tile: play, my list, the
         * X, then the thumbs - and only the chevron is pushed to the right edge,
         * with margin-left: auto. "Visto" has no counterpart there; it is kept
         * because it is a Jellyfin action worth having, and put last so the run
         * Netflix does have is in Netflix's order. */
        actions.appendChild(play);
        actions.appendChild(fav);
        if (remove) actions.appendChild(remove);
        actions.appendChild(rate);
        actions.appendChild(watched);
        actions.appendChild(el('span', 'nf-spacer'));
        actions.appendChild(expand);
        body.appendChild(actions);

        var meta = el('div', 'nf-preview-meta');
        if (item.CommunityRating) {
            meta.appendChild(
                el('span', 'nf-match', Math.round(item.CommunityRating * 10) + '% consigliato')
            );
        }
        if (item.OfficialRating) {
            meta.appendChild(el('span', 'nf-badge', item.OfficialRating));
        }
        var runtime = runtimeLabel(item);
        if (runtime) meta.appendChild(el('span', null, runtime));
        if (item.MediaStreams || item.Width >= 1280) {
            meta.appendChild(el('span', 'nf-badge', 'HD'));
        }
        body.appendChild(meta);

        if (item.Genres && item.Genres.length) {
            var genres = el('div', 'nf-preview-genres');
            item.Genres.slice(0, 3).forEach(function (genre, i) {
                if (i) genres.appendChild(el('span', 'nf-dot', '●'));
                genres.appendChild(el('span', null, genre));
            });
            body.appendChild(genres);
        }

        panel.appendChild(body);
        panel.addEventListener('mouseenter', keepOpen);
        panel.addEventListener('mouseleave', scheduleClose);
        document.body.appendChild(panel);

        // Anchor over the tile, then keep the panel inside the viewport - a tile
        // at either end of a row would otherwise open half off-screen.
        var gutter = 16;
        var left = rect.left + rect.width / 2 - width / 2;
        left = Math.max(gutter, Math.min(left, window.innerWidth - width - gutter));
        var top = rect.top - (artHeight - rect.height) / 2;
        top = Math.max(gutter, Math.min(top, window.innerHeight - panel.offsetHeight - gutter));

        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';

        // Force a reflow so the opening transition has a start value, then flip
        // the state synchronously. requestAnimationFrame would be tidier but it
        // is throttled to a standstill in a background tab, which leaves the
        // panel sitting at opacity 0 forever.
        void panel.offsetHeight;
        panel.classList.add('is-open');

        preview = panel;
        previewCard = card;
    }

    function openPreview(card) {
        var client = api();
        if (!client) return;

        var id = card.dataset.id;
        if (!id) return;

        client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                // The pointer may have left during the request.
                if (!pointerInside) return;
                destroyPreview();
                buildPreview(card, item, client);
            })
            .catch(function (err) {
                log('preview failed', err);
            });
    }

    /* Kept as the MediaQueryList, deliberately, not as its .matches boolean: the query
     * is re-evaluated on every read, so a 2-in-1 that gains a mouse after load starts
     * getting hover previews. Freezing the boolean here would kill them silently. */
    var FINE_POINTER = window.matchMedia('(hover: hover) and (pointer: fine)');

    function bindPreview() {
        if (document.body.dataset.nfPreviewBound) return;
        document.body.dataset.nfPreviewBound = '1';

        document.addEventListener(
            'mouseover',
            function (event) {
                if (!cfg.enableHoverPreview) return;
                if (!FINE_POINTER.matches) return;

                var card = event.target.closest && event.target.closest('.card[data-id]');
                if (!card || !card.closest('.itemsContainer')) return;
                if (card === previewCard) {
                    keepOpen();
                    return;
                }

                keepOpen();
                clearTimeout(openTimer);
                openTimer = setTimeout(function () {
                    openPreview(card);
                }, 400);
            },
            true
        );

        document.addEventListener(
            'mouseout',
            function (event) {
                var card = event.target.closest && event.target.closest('.card[data-id]');
                if (!card) return;

                // mouseout fires for every hop between the tile's own children.
                // Only a pointer that has actually left both the tile and the
                // panel should close anything.
                var to = event.relatedTarget;
                if (to && (card.contains(to) || (preview && preview.contains(to)))) return;

                clearTimeout(openTimer);
                scheduleClose();
            },
            true
        );

        // A panel pinned to viewport coordinates has to go when the page moves.
        window.addEventListener('scroll', destroyPreview, { passive: true, capture: true });
        window.addEventListener('resize', destroyPreview, { passive: true });
        window.addEventListener('hashchange', destroyPreview);
    }

    /* -------------------------------------------------------------- player */

    /* A player of our own, bound to the <video> element rather than to
     * Jellyfin's OSD. Moving Jellyfin's controls around was tried twice and both
     * times produced buttons that no longer responded - they carry behaviour
     * that does not survive being re-parented. This owns its own markup and
     * talks to playback directly, so nothing depends on their layout. */
    var player = null;
    var playerHideTimer = null;

    function fmt(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    }

    /* Netflix's own glyph shapes, drawn rather than borrowed from the Material
     * set - the Material equivalents read as a different product. */
    var GLYPHS = {
        play: 'M4 2.7v18.6c0 .8.9 1.3 1.5.9l14.6-9.3a1 1 0 000-1.8L5.5 1.8c-.6-.4-1.5.1-1.5.9z',
        pause: 'M6 3h4v18H6V3zm8 0h4v18h-4V3z',
        back10:
            'M12 4V1L7 5l5 4V6a6 6 0 11-6 6H4a8 8 0 108-8zm-1.9 11.5H9V11l-1.4.4v-1L10 9.6h.1v5.9zm5.6-2.2c0 .8-.2 1.4-.5 1.8-.4.3-.9.5-1.5.5s-1.1-.2-1.5-.5c-.3-.4-.5-1-.5-1.8v-1.1c0-.8.2-1.4.5-1.8.4-.3.9-.5 1.5-.5s1.1.2 1.5.5c.3.4.5 1 .5 1.8v1.1zm-1.2-1.2c0-.5 0-.8-.2-1a.6.6 0 00-.6-.4c-.3 0-.5.1-.6.3-.1.2-.2.5-.2 1v1.4c0 .5.1.8.2 1 .1.2.3.3.6.3s.5-.1.6-.3c.1-.2.2-.5.2-1v-1.3z',
        forward10:
            'M12 4V1l5 4-5 4V6a6 6 0 106 6h2a8 8 0 11-8-8zm-1.9 11.5H9V11l-1.4.4v-1L10 9.6h.1v5.9zm5.6-2.2c0 .8-.2 1.4-.5 1.8-.4.3-.9.5-1.5.5s-1.1-.2-1.5-.5c-.3-.4-.5-1-.5-1.8v-1.1c0-.8.2-1.4.5-1.8.4-.3.9-.5 1.5-.5s1.1.2 1.5.5c.3.4.5 1 .5 1.8v1.1zm-1.2-1.2c0-.5 0-.8-.2-1a.6.6 0 00-.6-.4c-.3 0-.5.1-.6.3-.1.2-.2.5-.2 1v1.4c0 .5.1.8.2 1 .1.2.3.3.6.3s.5-.1.6-.3c.1-.2.2-.5.2-1v-1.3z',
        volume:
            'M11 4.7L6.6 8.3H3a1 1 0 00-1 1v5.4a1 1 0 001 1h3.6l4.4 3.6c.6.5 1.5.1 1.5-.7V5.4c0-.8-.9-1.2-1.5-.7zm5.5 2a1 1 0 00-1.3 1.5 5 5 0 010 7.6 1 1 0 001.3 1.5 7 7 0 000-10.6zm2.8-2.6A1 1 0 0018 5.6a9 9 0 010 12.8 1 1 0 101.4 1.4 11 11 0 000-15.7z',
        mute: 'M11 4.7L6.6 8.3H3a1 1 0 00-1 1v5.4a1 1 0 001 1h3.6l4.4 3.6c.6.5 1.5.1 1.5-.7V5.4c0-.8-.9-1.2-1.5-.7zm11 5.9l-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1 2.1-2.1z',
        next: 'M4 3.8v16.4c0 .8.9 1.3 1.5.9l12-8.2a1 1 0 000-1.8l-12-8.2c-.6-.4-1.5.1-1.5.9zM19 3h2v18h-2V3z',
        episodes:
            'M4 8h13v12H4V8zm2 2v8h9v-8H6zM7 5h13v12h-2V7H7V5zm3-3h13v12h-2V4H10V2z',
        subtitles:
            'M3 3h18a2 2 0 012 2v12a2 2 0 01-2 2H7l-5 4V5a2 2 0 011-2zm3 6v2h6V9H6zm8 0v2h4V9h-4zM6 13v2h4v-2H6zm6 0v2h6v-2h-6z',
        fullscreen: 'M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z',
        back: 'M10.4 4.6L3 12l7.4 7.4 1.4-1.4-5-5H21v-2H6.8l5-5-1.4-1.4z',
        // Round the clock and back to the start - not the ten-second skip, which
        // is what this button was borrowing.
        restart: 'M12 5V2L7 6l5 4V7a5.5 5.5 0 11-5.5 5.5H4.5A7.5 7.5 0 1012 5z',
        chevronup: 'M12 8.6l-7.4 7.4 1.4 1.4L12 11.4l6 6 1.4-1.4L12 8.6z',
        chevrondown: 'M12 15.4l7.4-7.4L18 6.6l-6 6-6-6L4.6 8l7.4 7.4z',
        // A screen with a stand: the channel list.
        channels: 'M21 3H3a2 2 0 00-2 2v11a2 2 0 002 2h5l-1.6 2.4 1.6 1.1L11 18h2l2 3.5 1.6-1.1L15 18h6a2 2 0 002-2V5a2 2 0 00-2-2zm0 13H3V5h18v11z',
        close: 'M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z',
        search: 'M10 2a8 8 0 105 14.3l5.3 5.3 1.4-1.4-5.3-5.3A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z',
        /* Netflix's award call-out uses a laurel wreath, not a trophy: two branches
         * curving up and open at the top, in gold. */
        laurel:
            'M12 20.6c-2.1-1.3-3.4-3-3.4-5.3 0-1 .2-1.9.6-2.7-1.5-.6-2.7-1.7-3.4-3.2C5 7.7 4.9 5.8 5.5 3.9c1.9.2 3.5 1 4.6 2.4.9 1.1 1.4 2.4 1.5 3.8V4h.8v6.1c.1-1.4.6-2.7 1.5-3.8 1.1-1.4 2.7-2.2 4.6-2.4.6 1.9.5 3.8-.3 5.5-.7 1.5-1.9 2.6-3.4 3.2.4.8.6 1.7.6 2.7 0 2.3-1.3 4-3.4 5.3zM7 5.2c-.2 1.3 0 2.5.5 3.6.5 1.1 1.3 1.9 2.4 2.4.1-1.4-.2-2.7-.9-3.8-.5-.9-1.2-1.6-2-2.2zm10 0c-.8.6-1.5 1.3-2 2.2-.7 1.1-1 2.4-.9 3.8 1.1-.5 1.9-1.3 2.4-2.4.5-1.1.7-2.3.5-3.6zm-5 6.9c-.9.9-1.4 2-1.4 3.2 0 1.3.5 2.4 1.4 3.3.9-.9 1.4-2 1.4-3.3 0-1.2-.5-2.3-1.4-3.2z',
        /* And a megaphone for "new season" / "new episode". */
        thumbup:
            'M2 20h3V9H2v11zm19.8-9.2c.1-.2.2-.5.2-.8v-1c0-1.1-.9-2-2-2h-4.6l.7-3.4v-.3c0-.4-.2-.8-.4-1.1L14.6 1 8.3 7.3c-.4.4-.6.9-.6 1.4V18c0 1.1.9 2 2 2h8c.8 0 1.5-.5 1.8-1.2l2.3-5.4c.1-.2.1-.4.1-.6v-1c0-.4-.1-.7-.1-1z',
        /* "Adoro!" is Netflix's double thumb - the same one twice, offset. */
        thumblove: [
            { d: 'M2 20h3V9H2v11zm19.8-9.2c.1-.2.2-.5.2-.8v-1c0-1.1-.9-2-2-2h-4.6l.7-3.4v-.3c0-.4-.2-.8-.4-1.1L14.6 1 8.3 7.3c-.4.4-.6.9-.6 1.4V18c0 1.1.9 2 2 2h8c.8 0 1.5-.5 1.8-1.2l2.3-5.4c.1-.2.1-.4.1-.6v-1c0-.4-.1-.7-.1-1z',
              transform: 'translate(-1.2 6.2) scale(0.6)' },
            { d: 'M2 20h3V9H2v11zm19.8-9.2c.1-.2.2-.5.2-.8v-1c0-1.1-.9-2-2-2h-4.6l.7-3.4v-.3c0-.4-.2-.8-.4-1.1L14.6 1 8.3 7.3c-.4.4-.6.9-.6 1.4V18c0 1.1.9 2 2 2h8c.8 0 1.5-.5 1.8-1.2l2.3-5.4c.1-.2.1-.4.1-.6v-1c0-.4-.1-.7-.1-1z',
              transform: 'translate(9.4 -0.6) scale(0.6)' }
        ],
        thumbdown:
            'M22 4h-3v11h3V4zM2.2 13.2c-.1.2-.2.5-.2.8v1c0 1.1.9 2 2 2h4.6l-.7 3.4v.3c0 .4.2.8.4 1.1L9.4 23l6.3-6.3c.4-.4.6-.9.6-1.4V6c0-1.1-.9-2-2-2H6c-.8 0-1.5.5-1.8 1.2L1.9 10.6c-.1.2-.1.4-.1.6v1c0 .4.1.7.1 1z',
        megaphone:
            'M20 3.5v17a1 1 0 01-1.6.8L11 15.6v3.9a2.5 2.5 0 01-5 0v-4H5a3 3 0 01-3-3v-1a3 3 0 013-3h6l7.4-5.7a1 1 0 011.6.7zM8 15.5v4a.5.5 0 001 0v-4H8z',
        bell: 'M12 22a2.5 2.5 0 002.5-2.5h-5A2.5 2.5 0 0012 22zm7-6v-5a7 7 0 00-5.5-6.8V3a1.5 1.5 0 00-3 0v1.2A7 7 0 005 11v5l-2 2v1h18v-1l-2-2z',
        /* Netflix's own house: a pentagon roof over a short bar, not the iOS one. */
        house: 'M12 2.6L2 11.2V21h7v-6h6v6h7v-9.8L12 2.6zm0 2.7l8 6.9V19h-3v-6H7v6H4v-6.8l8-6.9z',
        plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4z',
        check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
        profile:
            'M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6z'
    };

    /* Where "Adoro!" is kept.
     *
     * Not in UserData.Rating, which was the first attempt: Jellyfin derives that
     * from Likes on its own - a plain thumb up comes back rated 10 and a thumb
     * down rated 1 - so every liked title read as loved. Not IsFavorite either,
     * which is My List and belongs to the + button.
     *
     * A playlist is per-user, needs no change to any item's metadata, and is a
     * real list the owner can open. It is only created when the first title is
     * loved, and removing every title leaves it empty rather than deleting it. */
    var LOVE_LIST = 'Adoro!';
    var loveState = null;
    var loveRequest = null;

    function loveLoad() {
        if (loveState) return Promise.resolve(loveState);
        if (loveRequest) return loveRequest;

        var client = api();
        if (!client) return Promise.resolve(null);
        var user = client.getCurrentUserId();

        loveRequest = client
            .getItems(user, { IncludeItemTypes: 'Playlist', Recursive: true, Limit: 200 })
            .then(function (result) {
                var list = (result.Items || []).filter(function (p) {
                    return p.Name === LOVE_LIST;
                })[0];

                if (!list) {
                    loveState = { id: null, ids: {} };
                    loveRequest = null;
                    return loveState;
                }

                return loveEntries(list.Id).then(function (ids) {
                    loveState = { id: list.Id, ids: ids };
                    loveRequest = null;
                    return loveState;
                });
            })
            .catch(function (err) {
                loveRequest = null;
                log('could not read the Adoro list', err);
                return null;
            });

        return loveRequest;
    }

    /* What is in the list, keyed by item and valued by the entry's own id.
     *
     * Reading the playlist as a folder - getItems with ParentId - returns the
     * items but not the entry ids, and removal needs the entry: the same title
     * can sit in a playlist more than once, so the two are not the same number.
     * The playlist's own endpoint carries both. */
    function loveEntries(listId) {
        var client = api();
        return client
            .getJSON(client.getUrl('Playlists/' + listId + '/Items', {
                userId: client.getCurrentUserId(),
                Limit: 2000
            }))
            .then(function (inside) {
                var ids = {};
                (inside.Items || []).forEach(function (entry) {
                    ids[entry.Id] = entry.PlaylistItemId || entry.Id;
                });
                return ids;
            });
    }

    function loveHas(id) {
        return !!(loveState && loveState.ids[id]);
    }

    function loveAdd(id) {
        var client = api();
        if (!client) return Promise.resolve();
        var user = client.getCurrentUserId();

        return loveLoad().then(function (state) {
            if (!state) return null;
            if (state.ids[id]) return null;

            if (!state.id) {
                return client
                    .ajax({
                        type: 'POST',
                        url: client.getUrl('Playlists'),
                        data: JSON.stringify({ Name: LOVE_LIST, Ids: [id], UserId: user, MediaType: 'Video' }),
                        contentType: 'application/json',
                        dataType: 'json'
                    })
                    .then(function (made) {
                        state.id = made && made.Id;
                        return loveEntries(state.id).then(function (ids) {
                            state.ids = ids;
                        });
                    });
            }

            return client
                .ajax({
                    type: 'POST',
                    url: client.getUrl('Playlists/' + state.id + '/Items', { ids: id, userId: user })
                })
                .then(function () {
                    // The entry id is minted by the server, so ask for it.
                    return loveEntries(state.id).then(function (ids) {
                        state.ids = ids;
                    });
                });
        });
    }

    function loveRemove(id) {
        var client = api();
        if (!client) return Promise.resolve();

        return loveLoad().then(function (state) {
            if (!state || !state.id || !state.ids[id]) return null;

            var entry = state.ids[id];
            delete state.ids[id];

            return client.ajax({
                type: 'DELETE',
                url: client.getUrl('Playlists/' + state.id + '/Items', { entryIds: entry })
            });
        });
    }

    function svgIcon(name) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');

        // A glyph is one path, or several when it is built out of a repeated one.
        var glyph = GLYPHS[name] || GLYPHS.play;
        var parts = typeof glyph === 'string' ? [{ d: glyph }] : glyph;

        parts.forEach(function (part) {
            var path = document.createElementNS(ns, 'path');
            path.setAttribute('d', part.d);
            if (part.transform) path.setAttribute('transform', part.transform);
            svg.appendChild(path);
        });

        return svg;
    }

    function playerButton(glyph, title, onClick, cls) {
        var button = el('button', 'nf-p-btn' + (cls ? ' ' + cls : ''));
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.appendChild(svgIcon(glyph));
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /* Jellyfin drives seeking through its playback manager when transcoding;
     * setting currentTime alone is only correct for direct play. Use theirs when
     * it is reachable, ours otherwise. */
    function seekTo(video, seconds) {
        var pm = window.playbackManager;
        if (pm && typeof pm.seekMs === 'function') {
            try {
                pm.seekMs(Math.max(0, seconds) * 1000);
                return;
            } catch (err) {
                log('seekMs failed, falling back', err);
            }
        }
        video.currentTime = Math.max(0, Math.min(seconds, video.duration || seconds));
    }

    /* Netflix answers "episodes" and "audio & subtitles" inside the player, not
     * by leaving it. Both are panels over the picture; only one is open at a
     * time. */
    function closePanels() {
        if (!player) return;
        player.node.querySelectorAll('.nf-p-panel').forEach(function (panel) {
            panel.remove();
        });
        // The chrome was being held up by the panel; start its clock again.
        showPlayerChrome();
    }

    /* Netflix closes these by walking away from them, so a panel that is left
     * behind when the pointer moves off closes itself. A short grace period covers
     * the gap between the button and the panel, which are not touching. */
    function closeOnLeave(panel, button) {
        var timer = null;
        var cancel = function () {
            clearTimeout(timer);
            timer = null;
        };
        var arm = function () {
            cancel();
            timer = setTimeout(function () {
                if (panel.parentNode) closePanels();
            }, 220);
        };
        panel.addEventListener('mouseenter', cancel);
        panel.addEventListener('mouseleave', arm);
        if (button) {
            button.addEventListener('mouseenter', cancel);
            button.addEventListener('mouseleave', arm);
        }
    }

    function panelShell(title, cls) {
        var panel = el('div', 'nf-p-panel ' + cls);
        var head = el('div', 'nf-p-panel-head');
        head.appendChild(el('h3', null, title));
        var close = el('button', 'nf-p-btn nf-p-panel-close');
        close.type = 'button';
        close.appendChild(svgIcon('close'));
        close.addEventListener('click', closePanels);
        head.appendChild(close);
        panel.appendChild(head);
        return panel;
    }

    /* Both panels need the item the player is showing, and that is resolved over the
     * network. A press that lands before the answer used to do nothing at all, with
     * no retry and nothing on screen to say why. It waits now, and asks again if
     * nothing has been asked yet - the resolution is lazy, so pressing the button is
     * itself a reason to go and find out. */
    function waitForItem(reopen, retried) {
        if (retried || !player) return;
        var current = player;
        ensureItem().then(function () {
            if (player === current) reopen();
        });
    }

    function openEpisodesPanel(hovered, retried) {
        if (!player) return;
        var client = api();
        if (!client) return;
        var seriesId = player.seriesId;
        if (!seriesId) {
            waitForItem(function () { openEpisodesPanel(hovered, true); }, retried);
            return;
        }

        var wasOpen = player.node.querySelector('.nf-p-panel-episodes');
        // Hover only ever opens; a click still toggles.
        if (wasOpen && hovered === true) return;
        closePanels();
        if (wasOpen) return;

        // Netflix's header is a back arrow and the season name, and the arrow
        // steps out to the list of seasons - not a dropdown.
        var panel = el('div', 'nf-p-panel nf-p-panel-episodes');
        var head = el('div', 'nf-p-panel-head');
        var back = el('button', 'nf-p-btn nf-p-panel-back');
        back.type = 'button';
        back.appendChild(svgIcon('back'));
        var heading = el('h3', null, 'Episodi');
        head.appendChild(back);
        head.appendChild(heading);
        panel.appendChild(head);

        var list = el('div', 'nf-p-panel-body');
        panel.appendChild(list);
        player.node.appendChild(panel);
        closeOnLeave(panel, player.node.querySelector('.nf-p-episodes-btn'));

        var allSeasons = [];

        var showSeasons = function () {
            heading.textContent = 'Stagioni';
            back.style.visibility = 'hidden';
            list.textContent = '';
            allSeasons.forEach(function (season) {
                var row = el('div', 'nf-p-season-row');
                row.appendChild(el('span', 'nf-p-season-name', season.Name));
                row.addEventListener('click', function () {
                    render(season.Id, season.Name);
                });
                list.appendChild(row);
            });
        };

        back.addEventListener('click', showSeasons);

        var render = function (seasonId, seasonName) {
            list.textContent = '';
            if (seasonName) heading.textContent = seasonName;
            back.style.visibility = allSeasons.length > 1 ? 'visible' : 'hidden';
            // One season, never the whole series: without a season the endpoint
            // returns every episode there is - 151 on the first run, enough to
            // lock the renderer up.
            var query = { userId: client.getCurrentUserId(), fields: 'Overview' };
            if (seasonId) query.seasonId = seasonId;
            else query.limit = 60;

            client
                .getJSON(client.getUrl('Shows/' + seriesId + '/Episodes', query))
                .then(function (result) {
                    (result.Items || []).forEach(function (episode) {
                        // Netflix keeps every row compact - number, title and a
                        // red watched line - and expands only the one playing,
                        // which grows a still and its synopsis.
                        var current = episode.Id === player.itemId;
                        var row = el('div', 'nf-p-episode' + (current ? ' is-current' : ''));

                        var head = el('div', 'nf-p-episode-head');
                        head.appendChild(el('span', 'nf-p-episode-index', String(episode.IndexNumber || '')));
                        head.appendChild(el('span', 'nf-p-episode-name', episode.Name));

                        var track = el('span', 'nf-p-episode-track');
                        var played = el('i');
                        var data = episode.UserData || {};
                        var pos = data.PlaybackPositionTicks;
                        played.style.width =
                            (data.Played
                                ? 100
                                : pos && episode.RunTimeTicks
                                  ? Math.min(100, (pos / episode.RunTimeTicks) * 100)
                                  : 0) + '%';
                        track.appendChild(played);
                        head.appendChild(track);
                        row.appendChild(head);

                        if (current) {
                            var detail = el('div', 'nf-p-episode-detail');

                            var thumb = el('div', 'nf-p-episode-thumb');
                            thumb.style.backgroundImage =
                                'url("' +
                                client.getImageUrl(episode.Id, { type: 'Primary', maxWidth: 320 }) +
                                '")';
                            thumb.appendChild(el('span', 'nf-p-episode-now', 'In riproduzione'));
                            detail.appendChild(thumb);

                            detail.appendChild(el('p', null, episode.Overview || ''));
                            row.appendChild(detail);
                        }

                        row.addEventListener('click', function () {
                            closePanels();
                            playNow(episode.Id, episode.ServerId, episode.Type);
                        });

                        list.appendChild(row);
                    });
                })
                .catch(function (err) {
                    log('episodes panel failed', err);
                });
        };

        client
            .getJSON(client.getUrl('Shows/' + seriesId + '/Seasons', {
                userId: client.getCurrentUserId()
            }))
            .then(function (result) {
                allSeasons = result.Items || [];
                if (!allSeasons.length) {
                    render(player.seasonId);
                    return;
                }
                var start = allSeasons.filter(function (season) {
                    return season.Id === player.seasonId;
                })[0] || allSeasons[0];
                render(start.Id, start.Name);
            })
            .catch(function () {
                render(player.seasonId);
            });
    }

    /* Changing channel from inside the player, which is the one thing a remote
     * control is for. Two arrows for the channel either side, and a panel with
     * all twelve and what is on each - the same shape as the episodes panel, so
     * it behaves the way the rest of the player already does. */
    function tvChannelStep(step) {
        if (!tvState.channel) return;
        var here = 0;
        TV_CHANNELS.forEach(function (channel, i) {
            if (channel.id === tvState.channel) here = i;
        });
        var next = TV_CHANNELS[(here + step + TV_CHANNELS.length) % TV_CHANNELS.length];
        tvTune(next.id, 'live');
    }

    function openChannelsPanel(hovered) {
        if (!player || !tvState.channel) return;

        var wasOpen = player.node.querySelector('.nf-p-panel-channels');
        if (wasOpen && hovered === true) return;
        closePanels();
        if (wasOpen) return;

        var panel = el('div', 'nf-p-panel nf-p-panel-channels');
        var head = el('div', 'nf-p-panel-head');
        head.appendChild(el('h3', null, 'Canali'));
        panel.appendChild(head);

        var body = el('div', 'nf-p-panel-body nf-p-channels');
        panel.appendChild(body);
        player.node.appendChild(panel);
        closeOnLeave(panel, player.node.querySelector('.nf-p-channels-btn'));

        var client = api();

        TV_CHANNELS.forEach(function (channel) {
            var row = el('button', 'nf-p-channel' + (channel.id === tvState.channel ? ' is-on' : ''));
            row.type = 'button';
            row.style.setProperty('--nf-tv-tone', channel.tone);

            var shot = el('div', 'nf-p-channel-shot');
            shot.appendChild(tvLockup(channel));
            var bar = el('div', 'nf-tv-bar');
            var fill = el('span');
            bar.appendChild(fill);
            shot.appendChild(bar);
            row.appendChild(shot);

            var copy = el('div', 'nf-p-channel-copy');
            var line = el('strong', null, channel.blurb);
            var after = el('span', null, '');
            copy.appendChild(line);
            copy.appendChild(after);
            row.appendChild(copy);

            row.addEventListener('click', function () {
                closePanels();
                if (channel.id !== tvState.channel) tvTune(channel.id, 'live');
            });
            body.appendChild(row);

            tvLoadPool(channel).then(function (pool) {
                if (!pool || !row.isConnected) return;
                var on = tvNow(channel, pool, tvClock());
                if (!on) return;

                line.textContent = on.slot.item.name;
                after.textContent = tvRemaining(on);
                fill.style.width =
                    Math.min(100, Math.round((on.offset / (on.slot.end - on.slot.start)) * 100)) + '%';
                if (client) {
                    shot.style.backgroundImage = 'url("' + tvArt(on.slot.item, client, 'wide') + '")';
                }
            });
        });
    }

    function openTracksPanel(hovered, retried) {
        if (!player) return;
        var client = api();
        if (!client) return;
        if (!player.itemId) {
            waitForItem(function () { openTracksPanel(hovered, true); }, retried);
            return;
        }

        var wasOpen = player.node.querySelector('.nf-p-panel-tracks');
        if (wasOpen && hovered === true) return;
        closePanels();
        if (wasOpen) return;

        // No title bar and no close button here: Netflix shows two bare columns,
        // "Audio" and "Sottotitoli", with a tick against the active track.
        var panel = el('div', 'nf-p-panel nf-p-panel-tracks');
        var body = el('div', 'nf-p-panel-body nf-p-tracks');
        panel.appendChild(body);
        player.node.appendChild(panel);
        closeOnLeave(panel, player.node.querySelector('.nf-p-tracks-btn'));

        client
            .getItem(client.getCurrentUserId(), player.itemId)
            .then(function (item) {
                var streams = item.MediaStreams || [];
                var pm = window.playbackManager;

                var activeOf = function (kind) {
                    try {
                        if (kind === 'Audio' && pm && pm.getAudioStreamIndex) return pm.getAudioStreamIndex();
                        if (kind === 'Subtitle' && pm && pm.getSubtitleStreamIndex) {
                            return pm.getSubtitleStreamIndex();
                        }
                    } catch (err) {
                        log('active track unavailable', err);
                    }
                    var preset = streams.filter(function (stream) {
                        return stream.Type === kind && stream.IsDefault;
                    })[0];
                    return preset ? preset.Index : kind === 'Subtitle' ? -1 : null;
                };

                var column = function (heading, kind, apply) {
                    var col = el('div', 'nf-p-track-col');
                    col.appendChild(el('h4', null, heading));

                    var options = streams.filter(function (stream) {
                        return stream.Type === kind;
                    });

                    if (kind === 'Subtitle') {
                        options = [{ Index: -1 }].concat(options);
                    }

                    var active = activeOf(kind);

                    options.forEach(function (stream, position) {
                        var button = el('button', 'nf-p-track');
                        button.type = 'button';
                        button.appendChild(el('span', 'nf-p-tick'));
                        button.appendChild(
                            el(
                                'span',
                                null,
                                trackLabel(stream, kind, kind === 'Subtitle' ? position - 1 : position)
                            )
                        );
                        if (stream.Index === active) button.classList.add('is-active');
                        button.addEventListener('click', function () {
                            apply(stream.Index, pm);
                            col.querySelectorAll('.nf-p-track').forEach(function (other) {
                                other.classList.remove('is-active');
                            });
                            button.classList.add('is-active');
                        });
                        col.appendChild(button);
                    });

                    return col;
                };

                body.appendChild(
                    column('Audio', 'Audio', function (index, pm2) {
                        if (pm2 && pm2.setAudioStreamIndex) pm2.setAudioStreamIndex(index);
                        else proxyClick('.videoOsdBottom .btnAudio');
                    })
                );
                body.appendChild(
                    column('Sottotitoli', 'Subtitle', function (index, pm2) {
                        if (pm2 && pm2.setSubtitleStreamIndex) pm2.setSubtitleStreamIndex(index);
                        else proxyClick('.videoOsdBottom .btnSubtitles');
                    })
                );
            })
            .catch(function (err) {
                log('tracks panel failed', err);
            });
    }

    /* Jellyfin's DisplayTitle is a technical string - "Italian - Italiano - AAC
     * - 5.1 - Predefinito". Netflix names the language and nothing else, so the
     * label is rebuilt from the stream's own fields. */
    var ISO3 = {
        ita: 'it', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es',
        por: 'pt', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', ara: 'ar',
        dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi',
        tur: 'tr', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', heb: 'he', hin: 'hi',
        hun: 'hu', ron: 'ro', rum: 'ro', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id'
    };

    var languageNames = null;
    function languageName(code) {
        if (!code) return null;
        var key = String(code).toLowerCase();
        var tag = key.length === 3 ? ISO3[key] || key : key;

        if (languageNames === null) {
            try {
                languageNames = new Intl.DisplayNames(['it'], { type: 'language' });
            } catch (err) {
                languageNames = false;
            }
        }

        var name = null;
        if (languageNames) {
            try {
                name = languageNames.of(tag);
            } catch (err) {
                name = null;
            }
        }
        if (!name || name === tag) return null;
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    function trackLabel(stream, kind, position) {
        if (stream.Index === -1) return 'Disattivati';

        // A file with a single untagged audio track has no language at all;
        // falling through to DisplayTitle there put "AAC - Stereo - Predefinito"
        // on screen, which is the codec string this exists to avoid.
        var name =
            languageName(stream.Language) ||
            (stream.Title &&
            !/\b(aac|ac3|eac3|dts|truehd|flac|opus|mp3|srt|subrip|pgs|ass|stereo|mono|5\.1|7\.1)\b/i.test(
                stream.Title
            )
                ? stream.Title
                : null) ||
            (kind === 'Audio' && position === 0 ? 'Originale' : 'Traccia ' + (position + 1));

        var notes = [];
        if (stream.IsForced) notes.push('forzati');
        if (stream.IsHearingImpaired) notes.push('non udenti');
        if (kind === 'Audio' && stream.ChannelLayout === '5.1') notes.push('5.1');

        return notes.length ? name + ' (' + notes.join(', ') + ')' : name;
    }

    function proxyClick(selector) {
        var target = document.querySelector(selector);
        if (target) target.click();
    }

    function destroyPlayer() {
        if (!player) return;
        if (player.wheelGuard) {
            window.removeEventListener('wheel', player.wheelGuard, { capture: true });
        }
        if (player.videoListeners && player.video) {
            player.videoListeners.forEach(function (pair) {
                player.video.removeEventListener(pair[0], pair[1]);
            });
        }
        // Hand the element back exactly as it was found.
        if (player.video) {
            try {
                delete player.video.volume;
                delete player.video.nfVolume;
            } catch (err) {
                log('could not restore the volume property', err);
            }
        }
        if (player.node.parentNode) player.node.parentNode.removeChild(player.node);
        player = null;
        document.body.classList.remove('nf-playing');
        document.body.classList.remove('nf-chrome-up');
    }

    /* The controls announce themselves, because the channel's watermark has to
     * be somewhere else while they are up. A broadcaster's bug and a control bar
     * never share the screen - the bug fades for as long as the bar is there and
     * comes back when it goes. */
    function showPlayerChrome() {
        if (!player) return;
        player.node.classList.remove('is-idle');
        document.body.classList.add('nf-chrome-up');
        clearTimeout(playerHideTimer);
        playerHideTimer = setTimeout(function () {
            if (!player || player.video.paused) return;
            // An open panel keeps the chrome up. It lives inside .nf-player, so
            // fading the chrome faded the panel with it - hover opened it and
            // three seconds later it was gone, which read as hover doing nothing.
            if (player.node.querySelector('.nf-p-panel')) return;
            player.node.classList.add('is-idle');
            document.body.classList.remove('nf-chrome-up');
        }, 3000);
    }

    /* Fullscreen renders the fullscreen element and its descendants and nothing
     * else, so a player parented to <body> simply vanishes the moment anything
     * else goes fullscreen - which is what it did. It follows the fullscreen
     * element instead, and comes home when fullscreen ends.
     *
     * A <video> taken fullscreen on its own cannot host an overlay at all; in that
     * case there is nothing to be done, so the player is left where it is rather
     * than throwing on appendChild. */
    function hostPlayer() {
        var target = document.fullscreenElement || document.webkitFullscreenElement;
        if (target && target.tagName === 'VIDEO') return;
        var host = target || document.body;

        /* Fullscreen renders only the subtree of the element that went
         * fullscreen, so anything left on <body> - the controls, and the
         * channel's watermark - simply is not there. Both move in. */
        var skin = document.querySelector('.nf-tv-skin');
        if (skin && skin.parentNode !== host) host.appendChild(skin);

        if (!player) return;
        if (player.node.parentNode !== host) host.appendChild(player.node);
    }

    function buildPlayer(video) {
        var node = el('div', 'nf-player');

        var top = el('div', 'nf-p-top');
        top.appendChild(
            playerButton('back', 'Indietro', function () {
                window.history.back();
            }, 'nf-p-back')
        );
        node.appendChild(top);

        // Netflix flashes a large glyph over the picture on every transport
        // action; without it a press gives no feedback at all.
        var flash = el('div', 'nf-p-flash');
        node.appendChild(flash);
        var flashGlyph = function (name) {
            flash.replaceChildren(svgIcon(name));
            flash.classList.remove('is-on');
            void flash.offsetWidth;
            flash.classList.add('is-on');
        };

        var bottom = el('div', 'nf-p-bottom');

        var scrubRow = el('div', 'nf-p-scrub');
        var range = el('input', 'nf-p-range');
        range.type = 'range';
        range.min = '0';
        range.max = '1000';
        range.value = '0';
        var remaining = el('span', 'nf-p-remaining', '0:00');
        scrubRow.appendChild(range);
        scrubRow.appendChild(remaining);
        bottom.appendChild(scrubRow);

        var row = el('div', 'nf-p-row');
        var left = el('div', 'nf-p-group');
        var centre = el('div', 'nf-p-title');
        var right = el('div', 'nf-p-group');

        var playBtn = playerButton('play', 'Riproduci', function () {
            if (video.paused) {
                video.play();
                flashGlyph('play');
            } else {
                video.pause();
                flashGlyph('pause');
            }
        });
        playBtn.classList.add('nf-p-play-btn');
        left.appendChild(playBtn);
        // Only while a channel is on, where it means the programme's beginning.
        left.appendChild(
            playerButton('restart', "Dall'inizio", function () {
                if (tvState.channel) tvTune(tvState.channel, 'restart');
            }, 'nf-p-restart-btn')
        );
        left.appendChild(
            playerButton('back10', 'Indietro di 10 secondi', function () {
                seekTo(video, video.currentTime - 10);
                flashGlyph('back10');
            }, 'nf-p-skip-btn')
        );
        left.appendChild(
            playerButton('forward10', 'Avanti di 10 secondi', function () {
                seekTo(video, video.currentTime + 10);
                flashGlyph('forward10');
            }, 'nf-p-skip-btn')
        );

        var volumeBtn = playerButton('volume', 'Audio', function () {
            video.muted = !video.muted;
            volumeBtn.replaceChildren(svgIcon(video.muted ? 'mute' : 'volume'));
        });
        var volume = el('input', 'nf-p-volume');
        volume.type = 'range';
        volume.min = '0';
        volume.max = '100';
        volume.value = String(Math.round((video.volume || 1) * 100));
        volume.addEventListener('input', function () {
            var level = Number(volume.value) / 100;
            // Straight past the wheel guard: this is a deliberate change.
            if (video.nfVolume) video.nfVolume(level);
            else video.volume = level;
            video.muted = level === 0;
        });
        var volumeWrap = el('div', 'nf-p-volume-wrap');
        volumeWrap.appendChild(volumeBtn);
        volumeWrap.appendChild(volume);
        left.appendChild(volumeWrap);

        // Right cluster mirrors Netflix: next episode, episode list, subtitles,
        // fullscreen. The first three only make sense for an episode.
        right.appendChild(
            playerButton('next', 'Prossimo episodio', function () {
                proxyClick('.videoOsdBottom .btnNextTrack');
            }, 'nf-p-next-btn')
        );
        // Netflix opens these on hover, not on click.
        var hoverPanel = function (button, open) {
            var timer = null;
            button.addEventListener('mouseenter', function () {
                clearTimeout(timer);
                timer = setTimeout(function () {
                    open(true);
                }, 120);
            });
            button.addEventListener('mouseleave', function () {
                clearTimeout(timer);
            });
            return button;
        };

        // A film has no episodes, so it does not get the button. It is revealed once
        // the item resolves and turns out to belong to a series - showing a control
        // that answers nothing is worse than showing none.
        var episodesBtn = hoverPanel(playerButton('episodes', 'Episodi', openEpisodesPanel), openEpisodesPanel);
        episodesBtn.classList.add('nf-p-episodes-btn');
        episodesBtn.hidden = true;
        right.appendChild(episodesBtn);

        // Only on while a channel is: a file has no channel above or below it.
        right.appendChild(
            playerButton('chevronup', 'Canale successivo', function () {
                tvChannelStep(1);
            }, 'nf-p-zap-btn')
        );
        right.appendChild(
            playerButton('chevrondown', 'Canale precedente', function () {
                tvChannelStep(-1);
            }, 'nf-p-zap-btn')
        );
        var channelsBtn = hoverPanel(
            playerButton('channels', 'Canali', openChannelsPanel, 'nf-p-channels-btn'),
            openChannelsPanel
        );
        right.appendChild(channelsBtn);

        var tracksBtn = hoverPanel(playerButton('subtitles', 'Sottotitoli e audio', openTracksPanel), openTracksPanel);
        tracksBtn.classList.add('nf-p-tracks-btn');
        right.appendChild(tracksBtn);
        right.appendChild(
            playerButton('fullscreen', 'Schermo intero', function () {
                if (document.fullscreenElement) document.exitFullscreen();
                else (document.querySelector('.videoPlayerContainer') || document.body).requestFullscreen();
            })
        );

        row.appendChild(left);
        row.appendChild(centre);
        row.appendChild(right);

        /* A channel is not a file, and the controls of one are wrong for the
         * other: there is nothing to scrub, nothing to skip ten seconds of, and
         * no next episode - what there is instead is a programme with a start
         * and an end, something after it, and a way back to the live edge. The
         * transport that does not apply is put away in CSS rather than built
         * twice, so an ordinary title still gets all of it. */
        var live = el('div', 'nf-p-live');

        var pill = el('button', 'nf-p-live-pill');
        pill.type = 'button';
        pill.appendChild(el('span', 'nf-tv-dot'));
        pill.appendChild(el('span', 'nf-p-live-word', 'Diretta'));
        pill.addEventListener('click', function (event) {
            event.stopPropagation();
            if (tvState.channel && tvState.shift > 0) tvTune(tvState.channel, 'live');
        });

        var liveCopy = el('div', 'nf-p-live-copy');
        var liveTitle = el('strong', null, '');
        var liveSub = el('span', null, '');
        liveCopy.appendChild(liveTitle);
        liveCopy.appendChild(liveSub);

        /* The line above the bar says what is on; the controls are all in the
         * row below it. Having one of them up here was half the reason the
         * player read as scattered. */
        var liveHead = el('div', 'nf-p-live-head');
        liveHead.appendChild(pill);
        liveHead.appendChild(liveCopy);
        live.appendChild(liveHead);

        var track = el('div', 'nf-p-live-track');
        var liveStart = el('span', 'nf-p-live-time', '');
        var liveBar = el('div', 'nf-tv-bar');
        var liveFill = el('span');
        liveBar.appendChild(liveFill);
        var liveEnd = el('span', 'nf-p-live-time', '');
        track.appendChild(liveStart);
        track.appendChild(liveBar);
        track.appendChild(liveEnd);
        live.appendChild(track);

        bottom.appendChild(live);
        bottom.appendChild(row);
        node.appendChild(bottom);

        player = {
            node: node,
            video: video,
            seriesId: null,
            live: {
                pill: pill,
                word: pill.querySelector('.nf-p-live-word'),
                title: liveTitle,
                sub: liveSub,
                start: liveStart,
                end: liveEnd,
                fill: liveFill
            }
        };
        hostPlayer();

        /* Scrolling was still moving the volume after guarding the two range
         * inputs, and no synthetic wheel on the video, the container, the OSD or
         * either slider reproduced it - so the listener wants a trusted event and
         * chasing which element owns it is guesswork.
         *
         * The wheel is swallowed for the whole window while the player is up
         * instead, before it reaches anyone. Netflix does nothing on scroll
         * either; the panels are the one place a wheel still has a job. */
        /* Swallowing the event was not enough: jellyfin-web binds its own
         * volume-on-wheel and its listener is registered before ours, so it has
         * already run by the time we cancel anything - hence the volume overlay
         * still appearing top right.
         *
         * The volume is therefore defended at the property instead. For a moment
         * after each wheel, writes to video.volume are ignored no matter who
         * makes them; our own controls set nfVolume, which passes through. */
        var suppressUntil = 0;
        var describe = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
        if (describe && describe.set) {
            Object.defineProperty(video, 'volume', {
                configurable: true,
                get: function () {
                    return describe.get.call(this);
                },
                set: function (value) {
                    if (Date.now() < suppressUntil) return;
                    describe.set.call(this, value);
                }
            });
            video.nfVolume = function (value) {
                describe.set.call(video, value);
            };
        }

        /* Every wheel is stopped from reaching anyone else, panels included -
         * letting them through was exactly how the volume still moved while a
         * panel was open. Scrolling is the browser's default action, decided by
         * hit-testing rather than by listeners, so halting propagation costs the
         * panel nothing; only preventDefault would, and that is reserved for
         * wheels outside a panel, where there is nothing to scroll. */
        player.wheelGuard = function (event) {
            var inPanel = !!(event.target && event.target.closest && event.target.closest('.nf-p-panel'));
            suppressUntil = Date.now() + 500;
            if (!inPanel) event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        };
        window.addEventListener('wheel', player.wheelGuard, { capture: true, passive: false });

        var scrubbing = false;
        range.addEventListener('input', function () {
            scrubbing = true;
        });
        range.addEventListener('change', function () {
            scrubbing = false;
            var duration = video.duration || 0;
            seekTo(video, (Number(range.value) / 1000) * duration);
        });

        // timeupdate fires about four times a second, and this used to rebuild the
        // play/pause SVG on every one of them - inside the subtree the page-wide
        // MutationObserver is watching, so each one also queued a decoration pass.
        // The glyph only ever has two states.
        var drawnPaused = null;

        var sync = function () {
            var duration = video.duration || 0;
            if (!scrubbing && duration) {
                range.value = String(Math.round((video.currentTime / duration) * 1000));
            }
            remaining.textContent = '-' + fmt(duration - video.currentTime);
            range.style.setProperty('--nf-progress', (Number(range.value) / 10).toFixed(2) + '%');
            if (video.paused !== drawnPaused) {
                drawnPaused = video.paused;
                playBtn.replaceChildren(svgIcon(drawnPaused ? 'play' : 'pause'));
            }
        };

        var onPause = function () {
            sync();
            showPlayerChrome();
        };

        // Kept on the player so destroyPlayer can take them off the video element,
        // which Jellyfin reuses between titles rather than replacing.
        player.videoListeners = [
            ['timeupdate', sync],
            ['loadedmetadata', sync],
            ['play', sync],
            ['pause', onPause]
        ];
        player.videoListeners.forEach(function (pair) {
            video.addEventListener(pair[0], pair[1]);
        });
        sync();

        node.addEventListener('mousemove', showPlayerChrome);
        document.addEventListener('mousemove', showPlayerChrome);
        showPlayerChrome();

        // The title Jellyfin already resolved for this stream.
        var osdTitle = document.querySelector('.osdTitle, .videoOsdBottom .osdTextContainer');
        if (osdTitle && osdTitle.textContent.trim()) {
            centre.textContent = osdTitle.textContent.trim();
        }

        var label = function (item) {
            if (!item || !item.Id || !player) return;
            player.itemId = item.Id;
            if (item.SeriesId) player.seriesId = item.SeriesId;
            if (item.SeasonId) player.seasonId = item.SeasonId;

            var episodesBtn = player.node.querySelector('.nf-p-episodes-btn');
            if (episodesBtn) episodesBtn.hidden = !item.SeriesId;
            centre.textContent = item.SeriesName
                ? item.SeriesName +
                  '  ' +
                  (item.ParentIndexNumber ? 'S' + item.ParentIndexNumber : '') +
                  (item.IndexNumber ? ':E' + item.IndexNumber : '') +
                  '  ' +
                  item.Name
                : item.Name;
        };

        player.label = label;
        resolveSoon(0);
    }

    /* The player is built the moment the video element appears, which is before the
     * server has a playback session to report and often before the element has a
     * src. A single attempt at that moment finds nothing and nothing tries again,
     * which is why both panels stayed dead for the life of the player. It keeps
     * asking for a few seconds instead. */
    function resolveSoon(attempt) {
        if (!player) return;
        var current = player;
        ensureItem().then(function (item) {
            if (player !== current || item || attempt >= 6) return;
            setTimeout(function () {
                if (player === current) resolveSoon(attempt + 1);
            }, 700);
        });
    }

    /* Which title is on screen. Asked from three places because no single one of
     * them is dependable:
     *
     *   playbackManager   present during playback on some builds and absent on
     *                     others - it is not exposed on window here at all.
     *   the stream URL    Jellyfin serves the media from /Videos/<id>/..., so the
     *                     video element itself carries the answer whenever there is
     *                     anything playing. This is the one that always works.
     *   the route         only carries ?id= when playback was reached by URL.
     *
     * Resolving from the route alone is what left the panels dead: the route often
     * does not carry an id, and then nothing set player.itemId at all. */
    function currentItemId() {
        if (!player) return null;
        if (player.itemId) return player.itemId;

        try {
            var pm = window.playbackManager;
            if (pm && typeof pm.currentItem === 'function') {
                var item = pm.currentItem();
                if (item && item.Id) return item.Id;
            }
        } catch (err) {
            log('currentItem unavailable', err);
        }

        // Transcoded playback runs through MSE, where video.src is a blob: URL with
        // no id in it - which is why a film's audio panel stayed dead while direct
        // play worked. The session knows regardless of how the media is delivered.
        if (player.sessionItemId) return player.sessionItemId;

        var src = (player.video && (player.video.currentSrc || player.video.src)) || '';
        // Case-insensitive on purpose: direct play is served from /Videos/<id>/ and
        // the HLS endpoints from /videos/<id>/.
        var fromStream = /\/videos\/([0-9a-fA-F-]{32,36})\//i.exec(src);
        if (fromStream) return fromStream[1];

        var fromRoute = window.location.hash.match(/[?&]id=([^&]+)/);
        if (fromRoute) return fromRoute[1];

        // Jellyfin's own OSD shows the artwork of whatever is playing, and the id
        // is in the URL of that image.
        var art = document.querySelector(
            '#videoOsdPage img[src*="/Items/"], .videoOsdBottom img[src*="/Items/"],'
                + ' .videoOsdTop img[src*="/Items/"]'
        );
        var fromArt = art && /\/Items\/([0-9a-fA-F-]{32,36})\//.exec(art.src);
        return fromArt ? fromArt[1] : null;
    }

    /* Resolved once per player and remembered, so a press that arrives before the
     * answer waits for it rather than being dropped. */
    /* Resolved once per player and remembered - but only a real answer is
     * remembered. Anything that comes back empty clears the memo, because the
     * common case is asking too early: the player is built the instant the video
     * element appears, before the server has a session to report and often before
     * the element has a src. Keeping a resolved-null promise here is what made both
     * panels dead for the life of the player - every retry short-circuited on the
     * nothing that had been cached. */
    function ensureItem() {
        if (!player) return Promise.resolve(null);
        if (player.itemPromise) return player.itemPromise;

        var client = api();
        if (!client) return Promise.resolve(null);

        var current = player;
        var forget = function (value) {
            if (player === current && !value) current.itemPromise = null;
            return value || null;
        };

        var id = currentItemId();
        if (!id) {
            // The session knows however the media is being delivered, which the
            // stream URL does not: a transcode arrives as a blob: with no id in it.
            player.itemPromise = client
                .getSessions({})
                .then(function (sessions) {
                    var device = client.deviceId && client.deviceId();
                    var playing = (sessions || []).filter(function (session) {
                        return session.NowPlayingItem && session.NowPlayingItem.Id;
                    });
                    var mine = playing.filter(function (session) {
                        return session.DeviceId === device;
                    })[0] || playing[0];

                    if (!mine || player !== current) return forget(null);
                    current.sessionItemId = mine.NowPlayingItem.Id;
                    current.itemPromise = null;
                    return ensureItem();
                })
                .catch(function (err) {
                    log('could not read the playback session', err);
                    return forget(null);
                });
            return player.itemPromise;
        }

        player.itemPromise = client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                if (player === current && current.label && item && item.Id) {
                    try {
                        current.label(item);
                    } catch (err) {
                        log('could not label the player', err);
                    }
                }
                return forget(item && item.Id ? item : null);
            })
            .catch(function (err) {
                log('could not resolve the playing item', err);
                return forget(null);
            });

        return player.itemPromise;
    }

    /* Sole owner of nf-playing, which hides Jellyfin's header so the player can draw
     * its own back arrow over a bare video.
     *
     * It has to be sole owner. It used to be set from applyBodyFlags as well, on the
     * looser test "does .videoOsdBottom exist" - and Jellyfin leaves that element in
     * the DOM, invisible, long after you have left the video and gone back to the
     * home screen. destroyPlayer returns early when there is no player of ours to
     * tear down, so it never cleared the flag the other function had set, and the
     * header stayed hidden on the home page. The live video element is the only
     * honest signal. */
    function managePlayer() {
        var video = document.querySelector('.videoPlayerContainer video, video.htmlvideoplayer');
        if (!video) {
            destroyPlayer();
            document.body.classList.remove('nf-playing');
            return;
        }
        if (player && player.video === video) return;
        destroyPlayer();
        document.body.classList.add('nf-playing');
        buildPlayer(video);
    }

    /* --------------------------------------------------------- shuffled rows
     *
     * The sagas arrive in the home row alphabetically, which means the row opens
     * on the same three collections every day and the twentieth is never seen.
     * They are dealt again on each visit instead - once per row per page, since
     * every mutation of the page runs refresh() and a row that reshuffled under
     * the cursor would be unusable.
     */

    var SAGA_ROW = /cofanett/i;

    /* Dealing the row again in the browser is not enough: the row is sixteen
     * cards of a hundred and two collections, and which sixteen is decided by
     * name before it ever reaches us - so shuffling them only ever reshuffles
     * the same first sixteen. The cards are re-pointed instead, at sixteen
     * collections drawn at random by the server, which is also why a saga added
     * tomorrow turns up here without anyone maintaining a list. */
    function paintSagaRow() {
        var sections = document.querySelectorAll('.verticalSection');

        Array.prototype.forEach.call(sections, function (section) {
            if (section.dataset.nfSagas) return;

            var heading = section.querySelector('.sectionTitle');
            if (!heading || !SAGA_ROW.test(heading.textContent)) return;

            var slider = section.querySelector('.itemsContainer');
            if (!slider) return;

            var cards = Array.prototype.slice.call(slider.children).filter(function (card) {
                return card.classList.contains('card');
            });
            // Still filling: re-pointing two of sixteen would strand the rest.
            if (cards.length < 3) return;

            var client = api();
            if (!client) return;

            section.dataset.nfSagas = '1';

            client
                .getItems(client.getCurrentUserId(), {
                    IncludeItemTypes: 'BoxSet',
                    Recursive: true,
                    SortBy: 'Random',
                    Fields: 'ChildCount',
                    Limit: cards.length * 2
                })
                .then(function (result) {
                    // A saga worth the name has more than one film in it.
                    var sets = (result.Items || []).filter(function (set) {
                        return (set.ChildCount || 0) > 1;
                    });

                    cards.forEach(function (card, index) {
                        var set = sets[index];
                        if (!set) return;

                        card.setAttribute('data-id', set.Id);
                        card.setAttribute('data-serverid', set.ServerId);

                        var text = card.querySelector('.cardText-first') || card.querySelector('.cardText');
                        if (text) text.textContent = set.Name;

                        var url = client.getImageUrl(set.Id, { type: 'Primary', maxWidth: 400 });
                        var image = card.querySelector('img.cardImage');
                        if (image) {
                            image.src = url;
                            return;
                        }

                        /* A collection made minutes ago has no artwork yet, so
                         * its card is a placeholder with an icon in it. Give it
                         * the picture and take the placeholder away. */
                        var box = card.querySelector('.cardImageContainer');
                        if (!box) return;
                        box.style.backgroundImage = 'url("' + url + '")';
                        box.style.backgroundSize = 'cover';
                        box.style.backgroundPosition = 'center';
                        box.classList.remove('defaultCardBackground');
                        var icon = box.querySelector('.cardImageIcon');
                        if (icon) icon.remove();
                    });
                })
                .catch(function (err) {
                    log('could not deal the sagas row', err);
                });
        });
    }

    /* ------------------------------------------------------------ billboard */

    /* Netflix's billboard puts a play glyph on the primary button and nothing at
       all on "Altre info". */
    function heroButton(label, glyph, cls) {
        var button = el('button', 'nf-btn ' + cls);
        button.type = 'button';
        if (glyph) button.appendChild(icon(glyph));
        button.appendChild(el('span', null, label));
        return button;
    }

    /* Another plugin's hero (Media Bar Enhanced and friends) wins if present:
     * two stacked billboards are worse than either alone. */
    var RIVAL_HERO = '#slides-container, #slideshow, .mediaBar, .jellyfin-enhanced-hero';

    /* The badges Netflix hangs off a billboard - "Nuova stagione", "Candidata
     * agli Emmy" - are claims about the title, so ours are only ever derived
     * from data that actually exists somewhere:
     *
     *   awards               Oscar / Emmy / Golden Globe / BAFTA tallies, served by
     *                        the plugin from Wikidata plus the OMDb payloads Jellyfin
     *                        already cached (see Awards/AwardsService.cs)
     *   DateCreated          when the title entered the library
     *   DateLastMediaAdded   when episodes were last added to a series
     *   CriticRating         the aggregated critics' score from the provider
     *   CommunityRating      the audience score
     *
     * Most titles will show nothing, which is correct - Netflix's badges are
     * the exception too. */
    var DAY = 86400000;
    var awardsByImdb = null;

    function loadAwards() {
        if (awardsByImdb) return Promise.resolve(awardsByImdb);
        var client = api();
        // getUrl honours a server running under a base path; the literal only has to
        // cover the case where ApiClient is not up yet.
        var url = client ? client.getUrl('NetflixFin/awards') : '/NetflixFin/awards';
        return fetch(url)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                awardsByImdb = (data && data.titles) || {};
                return awardsByImdb;
            })
            .catch(function () {
                awardsByImdb = {};
                return awardsByImdb;
            });
    }

    function ageInDays(value) {
        if (!value) return Infinity;
        var when = Date.parse(value);
        return isNaN(when) ? Infinity : (Date.now() - when) / DAY;
    }

    /* Netflix states the fact and never the count - "Emmy Award Winner", never
     * "Winner of 4 Emmys" - and that happens to be the honest choice here too.
     * The counts are good but not perfect: Wikidata splits Ben-Hur's score win
     * across two category entities and is missing Toy Story 3's song win, so a
     * number would be wrong now and then. A bare fact is not. */
    /* Keys are camelCase: the controller serialises with JsonNamingPolicy.CamelCase. */
    var AWARDS = [
        { win: 'oscarWins', nom: 'oscarNoms', won: 'Premiat$ agli Oscar®', cand: 'Candidat$ agli Oscar®' },
        { win: 'emmyWins', nom: 'emmyNoms', won: 'Premiat$ agli Emmy®', cand: 'Candidat$ agli Emmy®' },
        { win: 'globeWins', nom: 'globeNoms', won: 'Premiat$ ai Golden Globe', cand: 'Candidat$ ai Golden Globe' },
        { win: 'baftaWins', nom: 'baftaNoms', won: 'Premiat$ ai BAFTA', cand: 'Candidat$ ai BAFTA' }
    ];

    function awardBadge(item) {
        var imdb = item.ProviderIds && item.ProviderIds.Imdb;
        var record = imdb && awardsByImdb && awardsByImdb[imdb];
        if (!record) return null;

        // "il film" is masculine, "la serie" feminine, and Netflix Italia does agree
        // its own copy ("Stand-up vincitrici e candidate agli Emmy®").
        var ending = item.Type === 'Series' ? 'a' : 'o';

        for (var i = 0; i < AWARDS.length; i++) {
            var family = AWARDS[i];
            var wins = record[family.win] || 0;
            var noms = record[family.nom] || 0;
            if (!wins && !noms) continue;

            var template = wins ? family.won : family.cand;
            return {
                glyph: 'laurel',
                text: template.replace('$', ending),
                hint: wins
                    ? wins + (wins === 1 ? ' premio vinto' : ' premi vinti')
                    : noms + (noms === 1 ? ' candidatura' : ' candidature')
            };
        }

        return null;
    }

    function itemBadges(item) {
        var badges = [];

        var award = awardBadge(item);
        if (award) badges.push(award);

        if (item.Type === 'Series' && ageInDays(item.DateLastMediaAdded) <= 45) {
            badges.push({ glyph: 'megaphone', text: 'Nuovi episodi' });
        } else if (ageInDays(item.DateCreated) <= 30) {
            badges.push({ glyph: 'megaphone', text: 'Novità' });
        }

        if (!award) {
            if (item.CriticRating >= 90) {
                badges.push({ glyph: 'laurel', text: 'Acclamat' + (item.Type === 'Series' ? 'a' : 'o') + ' dalla critica' });
            } else if (item.CommunityRating >= 8.5) {
                badges.push({ glyph: 'laurel', text: 'Molto amat' + (item.Type === 'Series' ? 'a' : 'o') });
            }
        }

        return badges.slice(0, 2);
    }

    function buildHero(items, client) {
        var hero = el('div', 'nf-hero');
        hero.setAttribute('data-nf-hero', '1');

        var layers = items.map(function (item, i) {
            var layer = el('div', 'nf-hero-media' + (i === 0 ? ' is-active' : ''));

            // Both crops are published as custom properties and the stylesheet
            // picks: 16:9 for the wide billboard, the poster for the phone's 3:4
            // one. A backdrop squeezed into 3:4 is a sliver of the middle of the
            // frame, which is what the phone used to show.
            layer.style.setProperty(
                '--nf-art-wide',
                'url("' +
                    client.getImageUrl(item.Id, {
                        type: 'Backdrop',
                        maxWidth: 1920,
                        tag: item.BackdropImageTags && item.BackdropImageTags[0]
                    }) +
                    '")'
            );

            if (item.ImageTags && item.ImageTags.Primary) {
                layer.style.setProperty(
                    '--nf-art-tall',
                    'url("' +
                        client.getImageUrl(item.Id, {
                            type: 'Primary',
                            maxWidth: 780,
                            tag: item.ImageTags.Primary
                        }) +
                        '")'
                );
            }

            hero.appendChild(layer);
            return layer;
        });

        // After the layers so it paints over the artwork, still under the scrim.
        var videoBox = el('div', 'nf-hero-video');
        hero.appendChild(videoBox);

        var mute = el('button', 'nf-hero-mute');
        mute.type = 'button';
        hero.appendChild(mute);

        var content = el('div', 'nf-hero-content');
        var logo = el('img', 'nf-hero-logo');
        logo.alt = '';
        var title = el('h1', 'nf-hero-title');
        var meta = el('div', 'nf-hero-meta');
        var overview = el('p', 'nf-hero-overview');
        var buttons = el('div', 'nf-hero-buttons');
        var play = heroButton('Riproduci', 'play_arrow', 'nf-btn-primary');
        var info = heroButton('Altre info', null, 'nf-btn-secondary');
        buttons.appendChild(play);
        buttons.appendChild(info);
        content.appendChild(logo);
        content.appendChild(title);
        content.appendChild(meta);
        content.appendChild(overview);
        content.appendChild(buttons);
        hero.appendChild(content);

        var badges = el('div', 'nf-hero-badges');
        hero.appendChild(badges);

        var current = 0;

        function render(index) {
            var item = items[index];
            current = index;

            stopTrailer();
            scheduleTrailer();

            layers.forEach(function (layer, i) {
                layer.classList.toggle('is-active', i === index);
            });

            var hasLogo = item.ImageTags && item.ImageTags.Logo;
            if (hasLogo) {
                logo.src = client.getImageUrl(item.Id, { type: 'Logo', maxWidth: 640 });
                logo.style.display = '';
                logo.alt = item.Name;
                title.style.display = 'none';
            } else {
                logo.style.display = 'none';
                title.style.display = '';
                title.textContent = item.Name;
            }

            meta.textContent = '';
            var bits = [];
            if (isPhone()) {
                /* The app's line is three descriptive tags - "Avventura • Un mondo
                 * epico • Pirati" - not a spec sheet. Genres are the closest thing
                 * Jellyfin holds; the wide layout keeps the spec sheet, which is
                 * what netflix.com shows there. */
                bits = (item.Genres || []).slice(0, 3);
                if (!bits.length) {
                    bits.push(item.Type === 'Series' ? 'Serie' : 'Film');
                    if (item.ProductionYear) bits.push(String(item.ProductionYear));
                }
            } else {
                // "Serie • Fantascienza • 2020 • 5 stagioni • 16+"
                bits.push(item.Type === 'Series' ? 'Serie' : 'Film');
                if (item.Genres && item.Genres.length) bits.push(item.Genres[0]);
                if (item.ProductionYear) bits.push(String(item.ProductionYear));
                var runtime = runtimeLabel(item);
                if (runtime) bits.push(runtime);
                if (item.OfficialRating) bits.push(item.OfficialRating);
            }
            bits.forEach(function (bit, i) {
                if (i) meta.appendChild(el('span', 'nf-dot', '●'));
                meta.appendChild(el('span', null, bit));
            });

            overview.textContent = item.Overview || '';

            paintBadges();
            tintFrom(item, client);
            if (isPhone()) {
                paintListButton(item, info);
            } else if (!info.querySelector('span') || info.textContent !== 'Altre info') {
                info.textContent = '';
                info.appendChild(el('span', null, 'Altre info'));
            }
        }

        function paintBadges() {
            var item = items[current];
            if (!item) return;
            badges.textContent = '';
            itemBadges(item).forEach(function (badge) {
                var pill = el('span', 'nf-hero-badge' + (badge.glyph === 'megaphone' ? ' nf-hero-badge-new' : ''));
                if (badge.hint) pill.title = badge.hint;
                pill.appendChild(svgIcon(badge.glyph));
                pill.appendChild(el('span', null, badge.text));
                badges.appendChild(pill);
            });
        }

        // The awards map arrives on its own schedule; repaint once it lands so the
        // first billboard is not the only one that misses out.
        loadAwards().then(paintBadges);

        /* --- Trailer ---------------------------------------------------------
         * Jellyfin's providers record trailers as YouTube links (591 of 744 titles
         * on the library this was built against; none of them local files), so an
         * embed is the only way to play one. It is muted, chrome-free and inert to
         * the pointer, and a title without a trailer simply keeps its artwork. */
        var trailerCap = null;
        var mountTimer = null;
        var pingTimer = null;
        var pings = 0;
        var frame = null;
        var muted = true;
        var handshake = 1;

        function youTubeId(url) {
            var match = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/.exec(url || '');
            return match ? match[1] : null;
        }

        function trailerFor(item) {
            var list = (item && item.RemoteTrailers) || [];
            for (var i = 0; i < list.length; i++) {
                var id = youTubeId(list[i].Url);
                if (id) return id;
            }
            return null;
        }

        function command(func) {
            if (!frame || !frame.contentWindow) return;
            frame.contentWindow.postMessage(
                JSON.stringify({ event: 'command', func: func, args: [], id: handshake, channel: 'widget' }),
                '*');
        }

        function syncMute() {
            mute.textContent = '';
            mute.appendChild(svgIcon(muted ? 'mute' : 'volume'));
            mute.title = muted ? 'Riattiva l\'audio' : 'Disattiva l\'audio';
            mute.setAttribute('aria-label', mute.title);
        }

        /* One handshake on the iframe's load event is not enough - the player is often
         * not listening yet and the message goes nowhere, after which no state ever
         * comes back. Repeating it costs nothing and is what makes the reveal reliable. */
        function ping() {
            pingTimer = null;
            if (!frame || !frame.contentWindow) return;
            frame.contentWindow.postMessage(
                JSON.stringify({ event: 'listening', id: handshake, channel: 'widget' }), '*');
            if (++pings < 20) pingTimer = setTimeout(ping, 400);
        }

        /* The billboard swaps to the video only when the player says it is playing,
         * never on a timer. Everything else - buffering, an embed the owner blocked
         * (onError 150, which is what L'alba dei morti dementi answers), a tab the
         * browser has backgrounded and is refusing to decode media in - leaves the
         * artwork exactly where it was. A trailer that starts late simply appears
         * late; one that never starts is never seen. */
        function reveal() {
            if (!frame || hero.classList.contains('is-playing')) return;
            hero.classList.add('is-playing');
            // The cap runs from here, not from mount: a player that spent a minute
            // buffering has not used up its screen time.
            if (trailerCap) clearTimeout(trailerCap);
            trailerCap = setTimeout(stopTrailer, 40000);
        }

        function stopTrailer() {
            if (trailerCap) { clearTimeout(trailerCap); trailerCap = null; }
            if (mountTimer) { clearTimeout(mountTimer); mountTimer = null; }
            if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
            pings = 0;
            hero.classList.remove('is-playing');
            videoBox.textContent = '';
            frame = null;
            muted = true;
            syncMute();
        }

        function scheduleTrailer() {
            if (cfg.enableHeroTrailer === false) return;
            var id = trailerFor(items[current]);
            if (!id) return;

            // Mounted after the pause so the artwork gets its moment, then held behind
            // it until the player reports that it is running.
            var delay = Math.max(0, cfg.heroTrailerDelaySeconds == null ? 3 : cfg.heroTrailerDelaySeconds);
            mountTimer = setTimeout(function () {
                mountTimer = null;
                if (!document.body.contains(hero)) return;

                frame = document.createElement('iframe');
                frame.allow = 'autoplay; encrypted-media';
                frame.setAttribute('frameborder', '0');
                // Jellyfin's index.html carries <meta name="referrer" content="no-referrer">,
                // and YouTube refuses an embed that arrives with no referrer at all:
                // "Error 153, video player configuration error". The attribute overrides
                // the document policy for this one request. Verified both ways in the
                // browser - without it the player never loads.
                frame.referrerPolicy = 'strict-origin-when-cross-origin';
                frame.src =
                    'https://www.youtube-nocookie.com/embed/' + id +
                    '?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3' +
                    '&playsinline=1&disablekb=1&fs=0&enablejsapi=1&origin=' +
                    encodeURIComponent(location.origin);
                videoBox.appendChild(frame);
                pings = 0;
                ping();
            }, delay * 1000);
        }

        function onPlayerMessage(event) {
            if (!frame || !/youtube(-nocookie)?\.com$/.test(event.origin.replace(/^https?:\/\/(www\.)?/, ''))) {
                return;
            }
            var data = event.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { return; }
            }
            if (!data) return;
            if (data.event === 'onError') {
                stopTrailer();
                return;
            }
            var info = data.info;
            var state = data.event === 'onStateChange' ? info : (info && info.playerState);
            if (state === 1) reveal();
            if (state === 0) stopTrailer();
        }

        window.addEventListener('message', onPlayerMessage);

        /* Teardown has to be reachable from outside. It used to hang off the rotation
         * interval - which hashchange clears directly, so the callback that would have
         * removed this listener never ran, and every billboard ever built left one
         * behind, each still holding its items and its iframe. */
        if (heroTeardown) heroTeardown();
        heroTeardown = function () {
            heroTeardown = null;
            if (heroTimer) {
                clearInterval(heroTimer);
                heroTimer = null;
            }
            stopTrailer();
            window.removeEventListener('message', onPlayerMessage);
        };

        mute.addEventListener('click', function (event) {
            event.stopPropagation();
            muted = !muted;
            command(muted ? 'mute' : 'unMute');
            syncMute();
        });

        syncMute();

        play.addEventListener('click', function () {
            playNow(items[current].Id, items[current].ServerId, items[current].Type);
        });
        info.addEventListener('click', function () {
            var item = items[current];
            // On a phone the second button is Netflix's "La mia lista", not an info
            // button - the app has no third button and reaches the details by
            // tapping the artwork, which is wired below.
            if (isPhone()) {
                toggleFavourite(item, info);
                return;
            }
            openModal(item.Id);
        });

        // Tapping the artwork opens the title, the way the app does.
        hero.addEventListener('click', function (event) {
            if (!isPhone()) return;
            if (event.target.closest('.nf-hero-buttons, .nf-hero-mute')) return;
            openModal(items[current].Id);
        });

        if (heroTimer) clearInterval(heroTimer);
        if (cfg.heroAutoRotate && items.length > 1) {
            heroTimer = setInterval(function () {
                if (!document.body.contains(hero)) {
                    if (heroTeardown) heroTeardown();
                    return;
                }
                // A trailer holds the billboard: rotating out mid-play would be
                // the one thing Netflix never does.
                if (hero.classList.contains('is-playing')) return;
                render((current + 1) % items.length);
            }, Math.max(4, cfg.heroRotateSeconds) * 1000);
        }

        render(0);
        return hero;
    }

    var heroRequest = null;
    var tintCache = {};

    function isPhone() {
        return window.matchMedia('(max-width: 820px)').matches;
    }

    /* The phone billboard's second button. Jellyfin's favourite is the nearest
     * thing it has to My List, and it is what the hover card's + already uses. */
    function toggleFavourite(item, button) {
        var client = api();
        if (!client || !item) return;
        var on = !(item.UserData && item.UserData.IsFavorite);
        client
            .updateFavoriteStatus(client.getCurrentUserId(), item.Id, on)
            .then(function () {
                item.UserData = item.UserData || {};
                item.UserData.IsFavorite = on;
                paintListButton(item, button);
            })
            .catch(function (err) {
                log('could not update the list', err);
            });
    }

    function paintListButton(item, button) {
        if (!button) return;
        var on = !!(item.UserData && item.UserData.IsFavorite);
        button.textContent = '';
        button.appendChild(svgIcon(on ? 'check' : 'plus'));
        button.appendChild(el('span', null, 'La mia lista'));
    }

    /* Netflix washes the page behind the billboard with a colour taken from the
     * current artwork - measured on netflix.com as an SVG radial gradient centred
     * half a viewport above the top edge, 250% by 250%, opaque to 20% and clear by
     * 65%. It is NOT red: three samples gave dark maroon, dark navy and dark olive,
     * always with the largest RGB channel at exactly 38, i.e. the artwork's hue at
     * about 15% brightness. Red is simply what it looks like on red key art.
     *
     * The colour is sampled from the backdrop itself, which is same-origin, so the
     * canvas stays readable. */
    function tintFrom(item, client) {
        var root = document.documentElement;
        var tag = item.BackdropImageTags && item.BackdropImageTags[0];
        if (!tag) return;

        if (tintCache[item.Id]) {
            root.style.setProperty('--nf-hero-tint', tintCache[item.Id]);
            return;
        }

        var probe = new Image();
        probe.crossOrigin = 'anonymous';
        probe.onload = function () {
            try {
                var canvas = document.createElement('canvas');
                canvas.width = 16;
                canvas.height = 9;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(probe, 0, 0, 16, 9);
                var data = ctx.getImageData(0, 0, 16, 9).data;

                var r = 0, g = 0, b = 0, n = 0;
                for (var i = 0; i < data.length; i += 4) {
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    n++;
                }
                r /= n; g /= n; b /= n;

                // Keep the hue, pin the brightness: whatever the art, the wash is
                // as dim as Netflix's. A flat grey average would read as sludge, so
                // the channels are scaled by the brightest one.
                var peak = Math.max(r, g, b, 1);
                var scale = 38 / peak;
                var tint =
                    'rgb(' + Math.round(r * scale) + ',' +
                    Math.round(g * scale) + ',' + Math.round(b * scale) + ')';
                tintCache[item.Id] = tint;
                root.style.setProperty('--nf-hero-tint', tint);
            } catch (err) {
                log('could not sample the artwork', err);
            }
        };
        probe.src = client.getImageUrl(item.Id, { type: 'Backdrop', maxWidth: 96, tag: tag });
    }

    /* The billboard has to be the first thing in the column. It is claimed early
     * now - earlier than jellyfin-web finishes populating the container - and
     * jellyfin-web then prepends its own #categories-wrapper above it, which left
     * the billboard sitting 32px lower than Netflix's. */
    function hoistHero(container, node) {
        if (container.firstElementChild !== node) {
            container.insertBefore(node, container.firstElementChild);
        }
    }

    function mountHero() {
        if (!cfg.enableHeroBanner) return;

        var onHome =
            /#\/home/.test(window.location.hash) ||
            window.location.hash === '' ||
            window.location.hash === '#/';
        if (!onHome) return;

        if (document.querySelector(RIVAL_HERO)) {
            document.querySelectorAll('.nf-hero').forEach(function (node) {
                node.remove();
            });
            return;
        }

        var container = document.querySelector('.homeSectionsContainer');
        if (!container) return;

        var mounted = container.querySelector('[data-nf-hero]');
        if (mounted) {
            hoistHero(container, mounted);
            return;
        }

        // Claim the top of the column at its final height straight away. Without this
        // the billboard drops in later and shoves every row down the page; with it the
        // rows land in their final position first time.
        var slot = container.querySelector('.nf-hero-reserve');
        if (!slot) {
            slot = el('div', 'nf-hero nf-hero-reserve');
            container.insertBefore(slot, container.firstChild);
        }
        hoistHero(container, slot);

        heroItems()
            .then(function (data) {
                if (!data || !data.items.length) {
                    // Nothing came back, so let a later pass try again rather than
                    // holding the memo - and drop the placeholder, because an empty
                    // box where the billboard should be is worse than no billboard.
                    heroRequest = null;
                    var stale = document.querySelector('.nf-hero-reserve');
                    if (stale) stale.remove();
                    return;
                }

                var existing = document.querySelector('.homeSectionsContainer');
                if (!existing || existing.querySelector('[data-nf-hero]')) return;

                var hero = buildHero(data.items.slice(0, 5), data.client);
                var reserve = existing.querySelector('.nf-hero-reserve');
                if (reserve) {
                    existing.replaceChild(hero, reserve);
                } else {
                    existing.insertBefore(hero, existing.firstChild);
                }
                hoistHero(existing, hero);
                log('billboard mounted');
            })
            .catch(function (err) {
                heroRequest = null;
                var stale = document.querySelector('.nf-hero-reserve');
                if (stale) stale.remove();
                log('billboard failed', err);
            });
    }

    /* The billboard's data is fetched once and kept, and the fetch starts the moment
     * ApiClient can answer - not when the home rows finally render.
     *
     * That ordering is the whole point. Measured on a cold load of this server: the
     * theme's own script is parsed at 341ms, but jellyfin-web does not make its first
     * API call until 1439ms, and the rows arrive well after that. Asking for the
     * billboard only once the rows exist put it last in the queue, which is exactly
     * how it looked. Now it is in flight alongside them. */
    function heroItems() {
        if (heroRequest) return heroRequest;

        heroRequest = new Promise(function (resolve) {
            var deadline = Date.now() + 30000;
            (function poll() {
                var client = api();
                if (client && client.getCurrentUserId && client.getCurrentUserId()) {
                    return resolve(client);
                }
                if (Date.now() > deadline) return resolve(null);
                setTimeout(poll, 50);
            })();
        }).then(function (client) {
            if (!client) return null;
            return client
                .getItems(client.getCurrentUserId(), {
                    IncludeItemTypes: 'Movie,Series',
                    Recursive: true,
                    SortBy: 'Random',
                    Limit: 20,
                    ImageTypeLimit: 2,
                    EnableImageTypes: 'Backdrop,Logo',
                    // The extra fields exist for the badges; without them the
                    // billboard cannot tell a new arrival from a ten-year-old one.
                    Fields:
                        'Overview,Genres,ProductionYear,OfficialRating,ChildCount,' +
                        'DateCreated,DateLastMediaAdded,CriticRating,ProviderIds,RemoteTrailers',
                    EnableTotalRecordCount: false
                })
                .then(function (result) {
                    var items = (result.Items || []).filter(function (item) {
                        return item.BackdropImageTags && item.BackdropImageTags.length && item.Overview;
                    });
                    // Warm the first backdrop while the rows are still drawing, so the
                    // artwork is in cache by the time the element exists to show it.
                    if (items.length) {
                        var warm = new Image();
                        warm.src = client.getImageUrl(items[0].Id, {
                            type: 'Backdrop',
                            maxWidth: 1920,
                            tag: items[0].BackdropImageTags && items[0].BackdropImageTags[0]
                        });
                    }
                    return { client: client, items: items };
                });
        });

        return heroRequest;
    }

    /* ------------------------------------------------------------ lifecycle */

    var scheduled = null;

    /* ==================================================================== TV
     *
     * Twelve channels that behave like a broadcaster's: a line-up that runs
     * forever, is the same on every device, and can be read 24 hours ahead.
     *
     * Nothing about it is stored. The schedule for a channel on a day is a pure
     * function of (channel, day): a shuffle seeded on both, laid end to end from
     * midnight, each programme followed by a fixed ident slot. That one property
     * buys everything the feature needs - two people tuning in see the same
     * programme at the same second, a reload does not reshuffle the evening, the
     * guide is just tomorrow's arithmetic, and there is no state to keep, migrate
     * or repair.
     *
     * Days are independent on purpose. A day is laid out from its own midnight
     * and never looks at the day before it, so no schedule depends on a chain of
     * schedules going back to the epoch.
     *
     * The last programme of a day is allowed to run past midnight rather than
     * being cut to fit. Filling the tail with whatever was short enough still
     * left a gap - a library's shortest film is over an hour, so a day could end
     * an hour early, and that hour became a station ident nobody could sit
     * through. Overrunning costs nothing: the day after is laid out from its own
     * midnight as always, and someone watching at half past twelve is simply
     * joining its first programme late, which is what a channel running behind
     * looks like anyway.
     */

    var TV_EPOCH = Date.UTC(2026, 0, 1);
    var TV_DAY_MS = 86400000;
    /* The ident between programmes. It is part of the timeline, not a pause in
     * front of it, so someone tuning in during one is in sync with everyone
     * else. */
    var TV_IDENT_MS = 20000;
    var TV_MIN_MS = 4 * 60000;
    /* How close to the end of a programme the player may disappear and still be
     * the programme finishing rather than the viewer leaving. */
    var TV_TAIL_MS = 3 * 60000;
    /* How far past midnight the last programme of a day may run. Whatever runs
     * over eats into the first programme of the day after, so the closing slot
     * is picked to overshoot by less than this where the library allows it. */
    var TV_OVERRUN_MS = 45 * 60000;

    /* Animation and family films play on Family and nowhere else. A channel that
     * bills itself as Action and then shows Gli Incredibili, or Sci-Fi and then
     * Totoro, is not a channel - the genre tags are right and the bouquet is
     * wrong - so the bouquets refuse them and Family asks for them. */
    var TV_ANIMATION = ['Animazione', 'Animation', 'Famiglia', 'Family', 'Kids'];

    /* A sitcom is comedy at half an hour or under. Genre alone put Sweetpea on
     * the sitcom channel - comedy-drama, three quarters of an hour - and Slow
     * Horses with it. Length is what actually separates the two shapes. */
    var TV_SITCOM_MS = 35 * 60000;

    /* The line-up. Uno, Saghe, Classici and 24 are curations rather than genres;
     * the rest are bouquets - unions of several genres - which is the shape a
     * film channel actually takes. The pools overlap on purpose. */
    /* Each channel signs itself the way a broadcaster's family of channels does:
     * one mark that never changes - the F - and beside it a tag in the channel's
     * own colour, set in its own way. Sky does exactly this and it is why their
     * twelve read as twelve channels of one thing rather than twelve logos.
     *
     * `ink` is the colour the tag's word takes, chosen against the tone rather
     * than assumed white; `face` is how that word is set. */
    var TV_CHANNELS = [
        { id: 'uno', name: 'Uno', tone: '#1d3f8f', kind: 'movie', blurb: 'Il meglio della libreria',
          test: function (m) { return (m.rating || 0) >= 7.5; } },
        { id: 'action', name: 'Action', tone: '#a4161a', kind: 'movie', blurb: 'Azione e avventura',
          genres: ['Azione', 'Avventura', 'Guerra', 'Action & Adventure'], notGenres: TV_ANIMATION },
        { id: 'comedy', name: 'Comedy', tone: '#e09f3e', kind: 'movie', blurb: 'Da ridere, sempre',
          genres: ['Commedia', 'Comedy'], notGenres: TV_ANIMATION },
        { id: 'family', name: 'Family', tone: '#2a9d8f', kind: 'movie', blurb: 'Per tutta la famiglia',
          genres: ['Animazione', 'Animation', 'Famiglia', 'Family', 'Kids'] },
        { id: 'scifi', name: 'Sci-Fi', tone: '#5a189a', kind: 'movie', blurb: 'Fantascienza e fantasy',
          genres: ['Fantascienza', 'Science Fiction', 'Fantasy', 'Sci-Fi & Fantasy'],
          notGenres: TV_ANIMATION },
        { id: 'suspense', name: 'Suspense', tone: '#3d0e12', kind: 'movie', blurb: 'Thriller, horror, crime',
          genres: ['Thriller', 'Horror', 'Mistero', 'Mystery', 'Crime'], notGenres: TV_ANIMATION },
        { id: 'drama', name: 'Drama', tone: '#264653', kind: 'movie', blurb: 'Storie e sentimenti',
          genres: ['Dramma', 'Drama', 'Romance', 'Storia', 'History'], notGenres: TV_ANIMATION },
        { id: 'saghe', name: 'Saghe', tone: '#6a4c93', kind: 'boxset', blurb: 'Una saga per serata' },
        { id: 'classici', name: 'Classici', tone: '#7f5539', kind: 'movie', blurb: 'Prima del 1990',
          test: function (m) { return !!m.year && m.year < 1990; } },
        /* The two episode channels split on shape rather than on genre alone, and
         * they split on the same test, so whatever Sitcom does not take Serie
         * gets and nothing falls between them. */
        { id: 'serie', name: 'Serie', tone: '#14213d', kind: 'episode', blurb: 'Episodi in ordine',
          showTest: function (genres, episodes) { return !tvIsSitcom(genres, episodes); } },
        { id: 'sitcom', name: 'Sitcom', tone: '#bc6c25', kind: 'episode', blurb: 'Comedy a episodi',
          genres: ['Commedia', 'Comedy'], showTest: tvIsSitcom },
        { id: 'nonstop', name: '24', tone: '#495057', kind: 'movie', blurb: 'Tutto, senza sosta' }
    ];

    function tvChannel(id) {
        return TV_CHANNELS.filter(function (c) { return c.id === id; })[0] || null;
    }

    /* ------------------------------------------------------------ the seed */

    function tvHash(text) {
        var h = 2166136261;
        for (var i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    /* mulberry32: small, fast, and - the only property that matters here - the
     * same sequence for the same seed in every browser, forever. Math.random
     * would reshuffle the evening on every reload. */
    function tvRandom(seed) {
        var t = seed >>> 0;
        return function () {
            t = (t + 0x6d2b79f5) >>> 0;
            var x = Math.imul(t ^ (t >>> 15), t | 1);
            x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        };
    }

    function tvShuffle(list, seed) {
        var out = list.slice();
        var rnd = tvRandom(seed);
        for (var i = out.length - 1; i > 0; i--) {
            var j = Math.floor(rnd() * (i + 1));
            var swap = out[i];
            out[i] = out[j];
            out[j] = swap;
        }
        return out;
    }

    function tvDayOf(time) {
        return Math.floor((time - TV_EPOCH) / TV_DAY_MS);
    }

    function tvDayStart(day) {
        return TV_EPOCH + day * TV_DAY_MS;
    }

    /* A day is asked for several times a second - the clock, the guide, the two
     * days either side of midnight - and it is the same answer every time. It
     * is thrown away whenever the library changes underneath it. */
    var tvDayCache = {};

    /* ------------------------------------------------------------- the pool */

    var tvPools = {};
    var tvPoolRequests = {};

    function tvRuntime(item) {
        return Math.round((item.RunTimeTicks || 0) / 10000);
    }

    function tvKeep(item) {
        var ms = tvRuntime(item);
        return ms >= TV_MIN_MS;
    }

    function tvMatches(channel, item) {
        if (channel.test && !channel.test(item)) return false;

        var genres = item.Genres || item.genres || [];
        if (channel.genres) {
            var wanted = channel.genres;
            if (!genres.some(function (g) { return wanted.indexOf(g) > -1; })) return false;
        }
        if (channel.notGenres) {
            var unwanted = channel.notGenres;
            if (genres.some(function (g) { return unwanted.indexOf(g) > -1; })) return false;
        }
        return true;
    }

    function tvMedian(numbers) {
        if (!numbers.length) return 0;
        var sorted = numbers.slice().sort(function (a, b) { return a - b; });
        return sorted[Math.floor(sorted.length / 2)];
    }

    /* Comedy at half an hour or under. The median rather than the average, so a
     * feature-length finale does not move a show off the channel. */
    function tvIsSitcom(genres, episodes) {
        var comedy = (genres || []).some(function (g) {
            return g === 'Commedia' || g === 'Comedy';
        });
        if (!comedy) return false;

        return tvMedian(episodes.map(function (e) { return e.ms; })) <= TV_SITCOM_MS;
    }

    /* One item per programme, carrying only what the schedule needs. Sorted by
     * Id, because the shuffle has to start from the same order everywhere. */
    function tvEntry(item) {
        return {
            id: item.Id,
            name: item.Name,
            ms: tvRuntime(item),
            type: item.Type,
            series: item.SeriesName || null,
            seriesId: item.SeriesId || null,
            season: item.ParentIndexNumber || null,
            episode: item.IndexNumber || null
        };
    }

    function tvSort(list) {
        return list.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    }

    /* ------------------------------------------------------- the library
     *
     * Twelve channels used to ask for the library twelve times over. Nine of
     * them are made of films, and each asked for every film in the library -
     * the same nine hundred kilobytes, nine times - while Serie and Sitcom
     * asked for the episodes of every series one series at a time, and Saghe
     * asked for the contents of a hundred and twenty-three collections one
     * collection at a time. Opening the TV page fired something like a hundred
     * and fifty requests at once, which is why it crawled, and why a card
     * sometimes never filled in at all: enough of those requests were queued
     * behind the others to time out.
     *
     * It is read once instead - films in one request, episodes in one request,
     * series in one - and every channel is a filter over what came back. What
     * came back is also kept in the browser, so opening the page again paints
     * from what is already there and checks for new titles quietly afterwards.
     */

    var TV_LIBRARY_KEY = 'nf-tv-library';
    var TV_LIBRARY_VERSION = 2;
    /* How long what is kept stays good for. A library gains a title now and
     * then; nobody is waiting on the schedule to notice within the hour. */
    var TV_LIBRARY_MS = 12 * 3600000;
    /* And how old it has to be before a visit bothers looking for new titles.
     * Without this every reload quietly re-read the whole library - three
     * requests and a hundred and twenty-three collections - which is most of
     * the traffic this was written to remove. */
    var TV_LIBRARY_SOFT_MS = 3600000;
    // And how long a half-answer is worth keeping.
    var TV_LIBRARY_PARTIAL_MS = 600000;
    // How many collections to ask about at a time.
    var TV_QUEUE_WIDTH = 4;

    var tvPools = {};
    var tvLibrary = null;
    var tvLibraryRequest = null;
    var tvLibraryRefreshed = false;

    function tvRuntime(item) {
        return Math.round((item.RunTimeTicks || 0) / 10000);
    }

    function tvKeep(item) {
        var ms = item.ms === undefined ? tvRuntime(item) : item.ms;
        return ms >= TV_MIN_MS;
    }

    /* A few at a time. A hundred and twenty-three requests let loose together
     * is what the browser and the server both choke on; four at a time is not
     * measurably slower and leaves the rest of the page usable. */
    function tvQueue(items, worker) {
        var results = [];
        var next = 0;

        function pull() {
            if (next >= items.length) return Promise.resolve();
            var index = next++;
            return Promise.resolve(worker(items[index]))
                .catch(function () { return null; })
                .then(function (value) {
                    results[index] = value;
                    return pull();
                });
        }

        var runners = [];
        for (var i = 0; i < Math.min(TV_QUEUE_WIDTH, items.length); i++) runners.push(pull());
        return Promise.all(runners).then(function () { return results; });
    }

    // Only what the schedule reads, which is also what makes it small enough
    // to keep in the browser.
    var TV_SLIM = { EnableImages: false, EnableUserData: false, EnableTotalRecordCount: false };

    function tvAsk(client, user, query) {
        var full = { Recursive: true };
        var key;
        for (key in TV_SLIM) full[key] = TV_SLIM[key];
        for (key in query) full[key] = query[key];
        return client.getItems(user, full).then(function (result) { return result.Items || []; });
    }

    function tvFetchLibrary() {
        var client = api();
        if (!client) return Promise.resolve(null);
        var user = client.getCurrentUserId();

        var films = tvAsk(client, user, {
            IncludeItemTypes: 'Movie',
            Fields: 'Genres,RunTimeTicks,ProductionYear,CommunityRating',
            Limit: 2000
        }).then(function (items) {
            return items.filter(tvKeep).map(function (m) {
                var entry = tvEntry(m);
                entry.genres = m.Genres || [];
                entry.year = m.ProductionYear || null;
                entry.rating = m.CommunityRating || 0;
                return entry;
            });
        });

        /* Every episode in one request rather than one request per series. They
         * arrive in series and episode order and are grouped here, so a channel
         * still plays a show in order. */
        var shows = Promise.all([
            tvAsk(client, user, { IncludeItemTypes: 'Series', Fields: 'Genres', Limit: 1000 }),
            tvAsk(client, user, {
                IncludeItemTypes: 'Episode',
                Fields: 'RunTimeTicks',
                SortBy: 'SeriesSortName,ParentIndexNumber,IndexNumber',
                SortOrder: 'Ascending',
                Limit: 20000
            })
        ]).then(function (both) {
            var byId = {};
            both[0].forEach(function (show) {
                byId[show.Id] = { id: show.Id, name: show.Name, genres: show.Genres || [], episodes: [] };
            });
            both[1].forEach(function (episode) {
                var show = byId[episode.SeriesId];
                if (show && tvKeep(episode)) show.episodes.push(tvEntry(episode));
            });
            return Object.keys(byId).map(function (id) { return byId[id]; })
                .filter(function (show) { return show.episodes.length; });
        });

        var sets = tvAsk(client, user, { IncludeItemTypes: 'BoxSet', Limit: 300 })
            .then(function (found) {
                return tvQueue(found, function (set) {
                    return tvAsk(client, user, {
                        ParentId: set.Id,
                        IncludeItemTypes: 'Movie',
                        Fields: 'RunTimeTicks,ProductionYear',
                        SortBy: 'PremiereDate,ProductionYear,SortName',
                        SortOrder: 'Ascending',
                        Limit: 60
                    }).then(function (films) {
                        return {
                            id: set.Id,
                            name: set.Name,
                            episodes: films.filter(tvKeep).map(tvEntry)
                        };
                    });
                });
            })
            .then(function (all) {
                return {
                    // A saga worth an evening has more than one film in it.
                    list: all.filter(function (set) { return set && set.episodes.length > 1; }),
                    failed: all.filter(function (set) { return !set; }).length,
                    found: all.length
                };
            });

        return Promise.all([films, shows, sets]).then(function (parts) {
            return {
                at: Date.now(),
                films: parts[0],
                shows: parts[1],
                sets: parts[2].list,
                /* A section that came back empty is a request that failed, not a
                 * library with nothing in it - which is what happened while the
                 * server was still coming up: every collection request was
                 * refused, Saghe lost its hundred sagas, and the answer was then
                 * kept for twelve hours. A partial answer is used but never
                 * written down. */
                partial: !parts[0].length || !parts[1].length || parts[2].failed > 0 ||
                    /* A hundred and twenty-three collections that all report
                     * nothing inside them is a library being scanned, not a
                     * hundred and twenty-three empty collections. */
                    (parts[2].found > 0 && !parts[2].list.length)
            };
        });
    }

    function tvLibraryRead() {
        try {
            var raw = window.localStorage.getItem(TV_LIBRARY_KEY);
            if (!raw) return null;
            var kept = JSON.parse(raw);
            if (kept.version !== TV_LIBRARY_VERSION) return null;
            var age = Date.now() - (kept.library ? kept.library.at : 0);
            if (!kept.library) return null;
            /* A library missing a section is still worth keeping for a few
             * minutes: throwing it away outright meant every visit re-read the
             * whole library before a single channel could paint. */
            if (age > (kept.library.partial ? TV_LIBRARY_PARTIAL_MS : TV_LIBRARY_MS)) return null;
            return kept.library;
        } catch (err) {
            return null;
        }
    }

    function tvLibraryWrite(library) {
        try {
            window.localStorage.setItem(
                TV_LIBRARY_KEY,
                JSON.stringify({ version: TV_LIBRARY_VERSION, library: library })
            );
        } catch (err) {
            // A full or disabled store costs a request next time, nothing more.
            log('tv: could not keep the library', err);
        }
    }

    function tvLibraryTake(library) {
        // Whatever came back empty keeps what it had, so the merge is what gets
        // kept as well as what gets used.
        if (tvLibrary) {
            if (!library.films.length) library.films = tvLibrary.films;
            if (!library.shows.length) library.shows = tvLibrary.shows;
            if (!library.sets.length) library.sets = tvLibrary.sets;
        }

        tvLibrary = library;
        // The channels are filters over it, so they are all out of date at once.
        tvPools = {};
        tvDayCache = {};
        return library;
    }

    /* Anything already known is good enough to paint with; what is new can
     * arrive a second later. The swap waits while a channel is on air, because
     * the line-up is a function of the library and changing it under a viewer
     * would cut the programme they are watching. */
    function tvLibraryRefresh() {
        if (tvLibraryRefreshed) return;
        if (tvLibrary && Date.now() - tvLibrary.at < TV_LIBRARY_SOFT_MS) return;
        // A channel is on air: the swap would be refused anyway, so save the ask.
        if (tvState.channel) return;
        tvLibraryRefreshed = true;

        tvFetchLibrary().then(function (fresh) {
            if (!fresh) return;
            if (fresh.partial) {
                log('tv: part of the library did not answer; keeping it briefly');
                // Worth another try, but not immediately.
                setTimeout(function () { tvLibraryRefreshed = false; }, 60000);
            }
            tvLibraryWrite(fresh);
            if (tvState.channel) return;
            tvLibraryTake(fresh);
            tvRunUpdates();
        }).catch(function (err) {
            log('tv: could not refresh the library', err);
        });
    }

    function tvLibraryLoad() {
        if (tvLibrary) return Promise.resolve(tvLibrary);
        if (tvLibraryRequest) return tvLibraryRequest;

        var kept = tvLibraryRead();
        if (kept) {
            tvLibraryTake(kept);
            tvLibraryRefresh();
            return Promise.resolve(tvLibrary);
        }

        tvLibraryRequest = tvFetchLibrary()
            .then(function (library) {
                tvLibraryRequest = null;
                if (!library) return null;
                if (library.partial) {
                    log('tv: part of the library did not answer; keeping it briefly');
                    setTimeout(function () { tvLibraryRefreshed = false; }, 60000);
                } else {
                    tvLibraryRefreshed = true;
                }
                tvLibraryWrite(library);
                return tvLibraryTake(library);
            })
            .catch(function (err) {
                tvLibraryRequest = null;
                log('tv: could not read the library', err);
                return null;
            });

        return tvLibraryRequest;
    }

    /* A channel is a filter over the library, so this no longer asks the server
     * anything - but it stays a promise, because the library still might. */
    function tvLoadPool(channel) {
        if (tvPools[channel.id]) return Promise.resolve(tvPools[channel.id]);

        return tvLibraryLoad().then(function (library) {
            if (!library) return null;

            var pool;
            if (channel.kind === 'boxset') {
                pool = { kind: 'boxset', shows: tvSort(library.sets.slice()) };
            } else if (channel.kind === 'episode') {
                pool = {
                    kind: 'episode',
                    shows: tvSort(library.shows.filter(function (show) {
                        if (!tvMatches(channel, show)) return false;
                        if (!channel.showTest) return true;
                        return channel.showTest(show.genres, show.episodes);
                    }))
                };
            } else {
                pool = {
                    kind: 'movie',
                    items: tvSort(library.films.filter(function (film) {
                        return tvMatches(channel, film);
                    }))
                };
            }

            var full = pool.items ? pool.items.length : pool.shows.length;
            // Only a real answer is kept: an empty one has to be askable again.
            if (full) tvPools[channel.id] = pool;
            return full ? pool : null;
        });
    }

    /* ---------------------------------------------------------- the line-up */

    /* A day of one channel. Deterministic and self-contained: laid out from its
     * own midnight, with the last programme allowed to run past the next one. */

    function tvDaySchedule(channel, pool, day) {
        if (!pool) return [];

        var key = channel.id + ':' + day;
        if (tvDayCache[key] && tvDayCache[key].pool === pool) return tvDayCache[key].slots;

        var slots = tvBuildDay(channel, pool, day);
        // Yesterday, today, tomorrow, and room to spare while the date turns.
        if (Object.keys(tvDayCache).length > 48) tvDayCache = {};
        tvDayCache[key] = { pool: pool, slots: slots };
        return slots;
    }

    function tvBuildDay(channel, pool, day) {

        var seed = tvHash(channel.id + ':' + day);
        var slots = [];
        var start = tvDayStart(day);
        var end = start + TV_DAY_MS;
        var at = start;

        if (pool.kind === 'movie') {
            var order = tvShuffle(pool.items, seed);
            // eslint-disable-next-line no-unused-vars
            var i = 0;
            while (at < end && order.length) {
                var film = order[i % order.length];
                var span = film.ms + TV_IDENT_MS;

                if (at + span > end) {
                    /* Closing slot: the longest that still fits, which keeps the
                     * day tight. When nothing fits, this one plays anyway and
                     * runs into tomorrow. */
                    var room = end - at;
                    var fits = order.filter(function (m) { return m.ms + TV_IDENT_MS <= room; });
                    if (fits.length) {
                        film = fits.reduce(function (longest, m) {
                            return m.ms > longest.ms ? m : longest;
                        });
                    } else {
                        /* Nothing fits, so something has to run over. The first
                         * in the day's own order that only just overshoots -
                         * which is a different film each night, where taking the
                         * shortest in the library would have been the same one
                         * every night. */
                        var near = order.filter(function (m) {
                            return m.ms + TV_IDENT_MS <= room + TV_OVERRUN_MS;
                        });
                        film = near.length
                            ? near[0]
                            : order.reduce(function (shortest, m) {
                                return m.ms < shortest.ms ? m : shortest;
                            });
                    }
                    span = film.ms + TV_IDENT_MS;
                }

                slots.push({ item: film, start: at, end: at + film.ms, identEnd: at + span });
                at += span;
                i++;
            }
            return slots;
        }

        /* Series and sagas: in order within a title, and carrying on across days.
         * Where a title resumes is arithmetic rather than history - day N starts
         * where N days of an average day's episodes would have left it - so no
         * day has to look up the one before it.
         *
         * Titles are chained rather than looped. A single show held the whole day
         * on the first run: nineteen episodes of For All Mankind, then round
         * again. A run of three and on to the next show is what a channel of this
         * kind actually does, and a saga simply plays to its end before the next
         * one starts. */
        var shows = pool.shows;
        if (!shows.length) return [];

        var order = tvShuffle(shows, tvHash(channel.id + ':show:' + day));
        var run = pool.kind === 'boxset' ? Infinity : 3;
        var showAt = 0;
        var taken = 0;
        var cursors = {};

        /* Where a title stands today: N days of an average day's episodes on
         * from the epoch, so no day has to look up the one before it. */
        function cursorFor(show) {
            if (cursors[show.id] === undefined) {
                var episodes = show.episodes;
                var average = episodes.reduce(function (sum, e) {
                    return sum + e.ms + TV_IDENT_MS;
                }, 0) / episodes.length;
                var perDay = Math.max(1, Math.floor(TV_DAY_MS / average));
                cursors[show.id] = ((day * perDay) % episodes.length + episodes.length) % episodes.length;
            }
            return cursors[show.id];
        }

        while (at < end && showAt < order.length * 4) {
            var show = order[showAt % order.length];
            var flat = show.episodes;

            cursorFor(show);

            var episode = flat[cursors[show.id] % flat.length];
            var length = episode.ms + TV_IDENT_MS;

            if (at + length > end) {
                /* What this show has next is too long for the evening that is
                 * left. Giving the remainder to the closing ident is what left
                 * Saghe showing a title card for half an hour, so the longest
                 * episode that does fit takes the slot, from whichever show is
                 * waiting - the tail of a day is where a channel stops being in
                 * order and starts being a channel. */
                var room = end - at;
                var best = null;
                order.forEach(function (other) {
                    var candidate = other.episodes[cursorFor(other) % other.episodes.length];
                    if (candidate.ms + TV_IDENT_MS > room) return;
                    if (!best || candidate.ms > best.episode.ms) {
                        best = { show: other, episode: candidate };
                    }
                });
                /* Nothing short enough is waiting, so something runs into
                 * tomorrow: whichever show overshoots least. */
                if (!best) {
                    order.forEach(function (other) {
                        var candidate = other.episodes[cursorFor(other) % other.episodes.length];
                        if (!best || candidate.ms < best.episode.ms) {
                            best = { show: other, episode: candidate };
                        }
                    });
                }
                if (best) {
                    show = best.show;
                    flat = show.episodes;
                    episode = best.episode;
                    length = episode.ms + TV_IDENT_MS;
                }
            }

            slots.push({
                item: episode,
                show: show.name,
                start: at,
                end: at + episode.ms,
                identEnd: at + length
            });
            at += length;
            cursors[show.id]++;
            taken++;

            // A saga hands over once it has played out; a series after its block.
            var done = pool.kind === 'boxset'
                ? cursors[show.id] % flat.length === 0
                : taken >= run;
            if (done) {
                showAt++;
                taken = 0;
            }
        }
        return slots;
    }

    /* What is on, and how far in. Returns null while the pool is still loading.
     *
     * Yesterday is consulted first: its last programme is allowed to run past
     * midnight, and while it does, it is what is on. Today's line-up carries on
     * underneath from its own midnight, so the moment the overrun ends the
     * viewer joins today's first programme already under way. */
    function tvNow(channel, pool, when) {
        var time = when || Date.now();
        var today = tvDaySchedule(channel, pool, tvDayOf(time));

        var yesterday = tvDaySchedule(channel, pool, tvDayOf(time) - 1);
        var over = yesterday[yesterday.length - 1];
        if (over && time >= over.start && time < over.identEnd) {
            return {
                slot: over,
                next: today[0] || null,
                offset: Math.max(0, time - over.start),
                inIdent: time >= over.end
            };
        }

        var slots = today;
        for (var i = 0; i < slots.length; i++) {
            if (time >= slots[i].start && time < slots[i].identEnd) {
                var next = slots[i + 1] || null;
                // The last ident of the day has tomorrow's first programme
                // after it, not nothing.
                if (!next) next = tvDaySchedule(channel, pool, tvDayOf(time) + 1)[0] || null;

                return {
                    slot: slots[i],
                    next: next,
                    offset: Math.max(0, time - slots[i].start),
                    inIdent: time >= slots[i].end
                };
            }
        }
        return null;
    }

    /* The next 24 hours, which is today's tail and tomorrow's head. */
    function tvGuide(channel, pool, when) {
        var time = when || Date.now();
        var day = tvDayOf(time);
        var slots = tvDaySchedule(channel, pool, day - 1)
            .concat(tvDaySchedule(channel, pool, day))
            .concat(tvDaySchedule(channel, pool, day + 1));

        /* A programme that ran past midnight covers the start of the day it ran
         * into, so what it covered is not listed: the guide says what a viewer
         * would actually see, in the order they would see it. */
        var on = tvNow(channel, pool, time);
        var floor = on ? on.slot.start : time;

        return slots.filter(function (s) {
            return s.identEnd > time && s.start >= floor && s.start < time + TV_DAY_MS;
        });
    }

    /* A handle for checking the line-up without a UI in front of it. */
    window.nfTv = {
        channels: TV_CHANNELS,
        pool: function (id) { return tvLoadPool(tvChannel(id)); },
        now: function (id, when) {
            var c = tvChannel(id);
            return tvLoadPool(c).then(function (pool) { return tvNow(c, pool, when); });
        },
        guide: function (id, when) {
            var c = tvChannel(id);
            return tvLoadPool(c).then(function (pool) { return tvGuide(c, pool, when); });
        }
    };

    /* --------------------------------------------------------- TV: watching
     *
     * Watching a channel leaves no trace. Nothing is marked played, nothing
     * turns up in Continue Watching, and no resume position is written - which
     * also settled how tuning in mid-programme works: rather than writing the
     * offset into the item's user data and pressing resume, playback starts at
     * zero and the video is seeked once it is ready. Nothing to restore, because
     * nothing was changed.
     *
     * The client reports through three ApiClient methods, so they are shadowed on
     * the instance for as long as a channel is on. Progress is dropped outright;
     * stopped is let through with the position forced to zero, so the server
     * still tears the transcode down but remembers nothing worth resuming.
     */

    var tvState = {
        channel: null,
        shift: 0,
        video: null,
        timer: null,
        guard: null,
        pending: null,
        tunedAt: 0,
        started: false,
        retried: false,
        route: null,
        slotId: null,
        ambient: false,
        ended: false
    };

    function tvGuardReporting(on) {
        var client = api();
        if (!client) return;

        if (on) {
            if (tvState.guard) return;
            tvState.guard = {
                ownProgress: Object.prototype.hasOwnProperty.call(client, 'reportPlaybackProgress'),
                ownStopped: Object.prototype.hasOwnProperty.call(client, 'reportPlaybackStopped'),
                ownPlayed: Object.prototype.hasOwnProperty.call(client, 'markPlayed'),
                progress: client.reportPlaybackProgress,
                stopped: client.reportPlaybackStopped,
                played: client.markPlayed
            };

            client.reportPlaybackProgress = function () {
                return Promise.resolve();
            };
            client.markPlayed = function () {
                return Promise.resolve();
            };
            client.reportPlaybackStopped = function (info) {
                var quiet = {};
                var key;
                for (key in info || {}) {
                    if (Object.prototype.hasOwnProperty.call(info, key)) quiet[key] = info[key];
                }
                quiet.PositionTicks = 0;
                return tvState.guard.stopped.call(client, quiet);
            };
            return;
        }

        if (!tvState.guard) return;
        var saved = tvState.guard;
        if (saved.ownProgress) client.reportPlaybackProgress = saved.progress;
        else delete client.reportPlaybackProgress;
        if (saved.ownStopped) client.reportPlaybackStopped = saved.stopped;
        else delete client.reportPlaybackStopped;
        if (saved.ownPlayed) client.markPlayed = saved.played;
        else delete client.markPlayed;
        tvState.guard = null;
    }

    function tvClock() {
        return Date.now() - tvState.shift;
    }

    /* ------------------------------------------------------------ the page */

    /* refresh() runs on every DOM mutation, and the page is on the page: painting
     * here unconditionally rebuilt the grid a moment after a channel was opened,
     * so the channel view never survived its own click. It paints once, when the
     * panel is made; after that the view belongs to whoever is looking at it. */
    function tvOpen() {
        document.body.classList.add('nf-tv');
        if (document.querySelector('.nf-tv-page')) return;

        var panel = el('div', 'nf-tv-page');
        document.body.appendChild(panel);
        tvPaintGrid(panel);
    }

    function tvClose() {
        document.body.classList.remove('nf-tv');
        var panel = document.querySelector('.nf-tv-page');
        if (panel) panel.classList.remove('is-channel');
        if (panel) panel.remove();
        tvCardUpdates = [];
        if (tvGridTimer) {
            clearInterval(tvGridTimer);
            tvGridTimer = null;
        }
    }

    /* The grid is painted once, so what is on it has to keep itself current: the
     * programme changes while you are looking at the page, and the first pass can
     * land before ApiClient has a user, which is what left every channel reading
     * "Fuori onda" for good. Each card keeps its own updater and they all run
     * again every twenty seconds. */
    var tvCardUpdates = [];
    var tvGridTimer = null;

    function tvRunUpdates() {
        tvCardUpdates.forEach(function (update) {
            update();
        });
    }

    function tvOnPage() {
        return /[?&]nftv=1/.test(window.location.hash);
    }

    function tvTimeLabel(time) {
        var d = new Date(time);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    /* Wide art is asked for at the width it will be drawn at. A billboard is the
     * width of the window - two thousand pixels on this screen - and it was
     * being handed the same 780px file as a card an eighth of the size, which is
     * what "sgranate quando sono grandi" was. */
    var TV_ART_WIDTH = { hero: 1920, wide: 780, poster: 400 };

    function tvArt(entry, client, shape) {
        if (!entry || !client) return '';

        var width = TV_ART_WIDTH[shape] || TV_ART_WIDTH.wide;
        var options = {
            type: shape === 'poster' ? 'Primary' : 'Backdrop',
            maxWidth: width,
            quality: shape === 'hero' ? 92 : 90
        };

        /* An episode has no wide art of its own - the backdrop belongs to the
         * series - so the two channels made of episodes showed empty cards. */
        if (shape !== 'poster' && entry.type === 'Episode' && entry.seriesId) {
            return client.getImageUrl(entry.seriesId, options);
        }

        return client.getImageUrl(entry.id, options);
    }

    /* What a programme has left, said the way a listings page says it. */
    function tvRemaining(on) {
        var left = Math.round((on.slot.end - tvClock()) / 60000);
        if (on.inIdent) return 'Sta per finire';
        if (left <= 0) return 'Finisce ora';
        if (left < 60) return 'Ancora ' + left + ' min';
        return 'Ancora ' + Math.floor(left / 60) + 'h ' + (left % 60) + 'm';
    }

    /* Each channel has a lockup of its own, drawn rather than set: the F and the
     * channel's tag as one piece of vector, shipped with the plugin. Nothing
     * here composes them any more - it hangs the drawing at the size the place
     * it is going asks for. */
    function tvLockup(channel, cls) {
        var badge = el('div', 'nf-tv-logo' + (cls ? ' ' + cls : ''));
        badge.style.setProperty('--nf-tv-tone', channel.tone);

        var art = el('img', 'nf-tv-logo-art');
        art.src = '/NetflixFin/tv/logo/' + channel.id;
        art.alt = channel.name;
        art.decoding = 'async';
        badge.appendChild(art);
        return badge;
    }

    /* A programme's own page carries an overview and, for most titles, a logo
     * drawn by whoever made it. Neither is in the pool - the pool is kept small
     * because it is kept in the browser - so the billboard asks for the one
     * title it is about to show, once. */
    var tvDetailCache = {};

    function tvDetails(id) {
        if (tvDetailCache[id]) return Promise.resolve(tvDetailCache[id]);

        var client = api();
        if (!client) return Promise.resolve(null);

        return client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                tvDetailCache[id] = item;
                return item;
            })
            .catch(function () {
                return null;
            });
    }

    function tvLogoUrl(item, client) {
        if (!item || !client) return null;
        if (item.ImageTags && item.ImageTags.Logo) {
            return client.getImageUrl(item.Id, { type: 'Logo', maxWidth: 480 });
        }
        // An episode's logo belongs to the series, as its backdrop does.
        if (item.ParentLogoItemId) {
            return client.getImageUrl(item.ParentLogoItemId, { type: 'Logo', maxWidth: 480 });
        }
        return null;
    }

    /* The billboard: one channel, full width, the way the home page opens.
     *
     * Which channel is not a setting - it is whatever is best on right now,
     * highest rated first, which makes the page open on something worth
     * watching at three in the afternoon and something else at nine. */
    function tvFeature(states) {
        var best = null;
        states.forEach(function (state) {
            if (!state.on || state.on.inIdent) return;
            var rating = state.on.slot.item.rating || 0;
            if (!best || rating > best.rating) best = { state: state, rating: rating };
        });
        if (best) return best.state;
        return states.filter(function (state) { return state.on; })[0] || null;
    }

    function tvPaintBill(host, panel) {
        var art = el('div', 'nf-tv-bill-art');
        var copy = el('div', 'nf-tv-bill-copy');
        host.appendChild(art);
        host.appendChild(copy);

        var painted = null;

        var update = function () {
            var states = TV_CHANNELS.map(function (channel) {
                var pool = tvPools[channel.id];
                return { channel: channel, on: pool ? tvNow(channel, pool, tvClock()) : null };
            });

            var feature = tvFeature(states);
            if (!feature) return;

            var channel = feature.channel;
            var on = feature.on;
            host.style.setProperty('--nf-tv-tone', channel.tone);

            /* Asked for again on every pass rather than kept: the page is
             * painted while jellyfin-web is still signing in, and a client taken
             * once at that moment is null for the life of the page - which is
             * every picture on it missing. */
            var client = api();
            if (!client) return;

            if (painted !== on.slot.item.id) {
                painted = on.slot.item.id;
                art.style.backgroundImage = 'url("' + tvArt(on.slot.item, client, 'wide') + '")';

                copy.textContent = '';

                var badges = el('div', 'nf-tv-badges');
                badges.appendChild(tvLockup(channel));
                var kicker = el('div', 'nf-tv-kicker');
                kicker.appendChild(el('span', 'nf-tv-dot'));
                kicker.appendChild(el('span', null, 'In onda ora'));
                badges.appendChild(kicker);
                copy.appendChild(badges);

                var title = el('h2', 'nf-tv-bill-title', on.slot.item.name);
                copy.appendChild(title);

                /* The clock, the progress and what is left read as one line of
                 * information, so they are one block rather than three. */
                var meter = el('div', 'nf-tv-bill-meter');
                meter.appendChild(el('div', 'nf-tv-bill-clock', ''));
                var bar = el('div', 'nf-tv-bar');
                bar.appendChild(el('span'));
                meter.appendChild(bar);
                copy.appendChild(meter);

                tvDetails(on.slot.item.id).then(function (item) {
                    if (painted !== on.slot.item.id || !item) return;
                    var logo = tvLogoUrl(item, client);
                    if (logo) {
                        title.classList.add('has-logo');
                        title.style.backgroundImage = 'url("' + logo + '")';
                        title.setAttribute('aria-label', on.slot.item.name);
                    }
                    if (item.Overview) {
                        var line = el('p', 'nf-tv-bill-blurb', item.Overview);
                        copy.insertBefore(line, copy.querySelector('.nf-tv-actions'));
                    }
                });

                var actions = el('div', 'nf-tv-actions');
                var watch = el('button', 'nf-btn nf-btn-primary');
                watch.type = 'button';
                watch.appendChild(svgIcon('play'));
                watch.appendChild(el('span', null, 'Guarda'));
                watch.addEventListener('click', function () {
                    tvTune(channel.id, 'live');
                });
                actions.appendChild(watch);

                // Netflix puts a glyph on the primary button and none at all on
                // the one beside it.
                var open = el('button', 'nf-btn nf-btn-secondary');
                open.type = 'button';
                open.appendChild(el('span', null, 'Vai al canale'));
                open.addEventListener('click', function () {
                    tvPaintChannel(panel, channel.id);
                });
                actions.appendChild(open);
                copy.appendChild(actions);
            }

            var span = on.slot.end - on.slot.start;
            var clock = copy.querySelector('.nf-tv-bill-clock');
            var fill = copy.querySelector('.nf-tv-bar > span');
            if (clock) {
                clock.textContent =
                    (on.slot.show ? on.slot.show + '  ·  ' : '') +
                    tvTimeLabel(on.slot.start) + ' – ' + tvTimeLabel(on.slot.end) +
                    '  ·  ' + tvRemaining(on);
            }
            if (fill) fill.style.width = Math.min(100, Math.round((on.offset / span) * 100)) + '%';
        };

        tvCardUpdates.push(update);

        // The billboard needs every channel's line-up to choose between them.
        Promise.all(TV_CHANNELS.map(tvLoadPool)).then(update);
    }

    function tvPaintGrid(panel) {
        panel.textContent = '';
        panel.scrollTop = 0;
        tvCardUpdates = [];

        var bill = el('div', 'nf-tv-bill');
        panel.appendChild(bill);
        tvPaintBill(bill, panel);

        var grid = el('div', 'nf-tv-grid');
        panel.appendChild(grid);

        TV_CHANNELS.forEach(function (channel) {
            var card = el('button', 'nf-tv-card');
            card.type = 'button';
            card.style.setProperty('--nf-tv-tone', channel.tone);

            /* Artwork, the channel's mark on it, and the progress of what is on
             * along its bottom edge; the words sit under the picture on the
             * page's own black, which is where a row of cards keeps them. */
            var shot = el('div', 'nf-tv-shot');
            shot.appendChild(tvLockup(channel));

            var bar = el('div', 'nf-tv-bar');
            var fill = el('span');
            bar.appendChild(fill);
            shot.appendChild(bar);
            card.appendChild(shot);

            var body = el('div', 'nf-tv-info');
            var line = el('div', 'nf-tv-onair', channel.blurb);
            var follow = el('div', 'nf-tv-follow', '');
            body.appendChild(line);
            body.appendChild(follow);
            card.appendChild(body);

            card.addEventListener('click', function () {
                tvPaintChannel(panel, channel.id);
            });
            grid.appendChild(card);

            var painted = null;

            var update = function () {
                tvLoadPool(channel).then(function (pool) {
                    // No pool yet is not the same as nothing on: keep waiting.
                    if (!pool) return;

                    var on = tvNow(channel, pool, tvClock());
                    if (!on) {
                        line.textContent = 'Fuori onda';
                        return;
                    }

                    line.textContent = on.slot.item.name;
                    follow.textContent = on.next
                        ? tvRemaining(on) + ' · a seguire ' + on.next.item.name
                        : tvRemaining(on);

                    var span = on.slot.end - on.slot.start;
                    fill.style.width = Math.min(100, Math.round((on.offset / span) * 100)) + '%';

                    // See tvPaintBill: the client is asked for per pass, not kept.
                    var client = api();
                    if (client && painted !== on.slot.item.id) {
                        painted = on.slot.item.id;
                        shot.style.backgroundImage = 'url("' + tvArt(on.slot.item, client, 'wide') + '")';
                    }
                });
            };

            tvCardUpdates.push(update);
            update();
        });

        if (tvGridTimer) clearInterval(tvGridTimer);
        tvGridTimer = setInterval(tvRunUpdates, 20000);
    }

    /* The guide is also a way in. A programme listed for nine o'clock is a film
     * that is sitting in the library right now, and being told to wait for it is
     * a strange thing for an app that owns the file - so a row opens on what the
     * film is, and offers to play it.
     *
     * On demand means on demand: no channel is involved, nothing is guarded, and
     * it counts as watched like anything else. Playback goes through the
     * programme's own page for the same reason a channel does - it is the one
     * control on this build that reliably starts anything. */
    function tvWatchNow(id, attempt) {
        var client = api();
        var route = '#/details?id=' + id;

        if (!attempt) {
            tvGuardReporting(false);
            window.location.hash = route + (client ? '&serverId=' + client.serverId() : '');
        }

        var press = function (tries) {
            // The viewer moved on while the page was loading.
            if (window.location.hash.indexOf(route) !== 0) return;

            var button = document.querySelector('.mainDetailButtons .btnResume, .mainDetailButtons .btnPlay');
            if (!button || button.offsetParent === null) {
                if (tries < 60) setTimeout(function () { press(tries + 1); }, 250);
                return;
            }

            button.click();

            /* And then check. jellyfin-web delegates this click, and one that
             * lands while the page is still settling reaches nothing at all -
             * silently. Pressing it a second time is what makes it play, which
             * is the same thing the channels learned the hard way. */
            if ((attempt || 0) >= 3) return;
            setTimeout(function () {
                if (tvPlayerBusy()) return;
                if (window.location.hash.indexOf(route) !== 0) return;
                tvWatchNow(id, (attempt || 0) + 1);
            }, 6000);
        };

        press(0);
    }

    function tvOpenRow(row, slot, channel) {
        if (row.classList.contains('is-open')) {
            row.classList.remove('is-open');
            var open = row.querySelector('.nf-tv-row-more');
            if (open) open.remove();
            return;
        }

        row.classList.add('is-open');

        var more = el('div', 'nf-tv-row-more');
        var art = el('div', 'nf-tv-row-poster');
        var copy = el('div', 'nf-tv-row-copy');
        more.appendChild(art);
        more.appendChild(copy);
        row.appendChild(more);

        var client = api();
        if (client) {
            art.style.backgroundImage = 'url("' + tvArt(slot.item, client, 'poster') + '")';
        }

        var meta = el('div', 'nf-tv-row-meta', '');
        var blurb = el('p', 'nf-tv-row-blurb', 'Caricamento…');
        copy.appendChild(el('h4', null, slot.item.name));
        copy.appendChild(meta);
        copy.appendChild(blurb);

        var actions = el('div', 'nf-tv-row-actions');

        var watch = el('button', 'nf-btn nf-btn-primary');
        watch.type = 'button';
        watch.appendChild(svgIcon('play'));
        watch.appendChild(el('span', null, 'Guarda ora'));
        watch.addEventListener('click', function (event) {
            event.stopPropagation();
            tvWatchNow(slot.item.id, 0);
        });
        actions.appendChild(watch);

        var live = el('button', 'nf-btn nf-btn-secondary');
        live.type = 'button';
        live.appendChild(el('span', null, 'Guarda il canale'));
        live.addEventListener('click', function (event) {
            event.stopPropagation();
            tvTune(channel.id, 'live');
        });
        actions.appendChild(live);

        copy.appendChild(actions);

        tvDetails(slot.item.id).then(function (item) {
            if (!item || !row.isConnected) return;

            var bits = [];
            if (slot.show) bits.push(slot.show);
            if (item.ProductionYear) bits.push(String(item.ProductionYear));
            bits.push(Math.round(slot.item.ms / 60000) + ' min');
            if (item.OfficialRating) bits.push(item.OfficialRating);
            if ((item.Genres || []).length) bits.push(item.Genres.slice(0, 3).join(', '));
            meta.textContent = bits.join('  ·  ');

            blurb.textContent = item.Overview || 'Nessuna trama disponibile.';

            var logo = tvLogoUrl(item, client);
            if (logo) {
                var h4 = copy.querySelector('h4');
                h4.classList.add('has-logo');
                h4.style.backgroundImage = 'url("' + logo + '")';
            }
        });
    }

    /* Which day a slot falls on, said the way a guide says it. */
    function tvDayLabel(time) {
        var day = tvDayOf(time);
        var today = tvDayOf(tvClock());
        if (day === today) return 'Oggi';
        if (day === today + 1) return 'Domani';
        return new Date(time).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    }

    function tvPaintChannel(panel, id) {
        var channel = tvChannel(id);
        if (!channel) return;

        panel.textContent = '';
        panel.scrollTop = 0;
        panel.classList.add('is-channel');

        tvCardUpdates = [];
        if (tvGridTimer) {
            clearInterval(tvGridTimer);
            tvGridTimer = null;
        }

        var hero = el('div', 'nf-tv-hero');
        hero.style.setProperty('--nf-tv-tone', channel.tone);

        var back = el('button', 'nf-tv-back');
        back.type = 'button';
        back.appendChild(svgIcon('back'));
        back.appendChild(el('span', null, 'Tutti i canali'));
        back.addEventListener('click', function () {
            panel.classList.remove('is-channel');
            tvPaintGrid(panel);
        });
        hero.appendChild(back);

        var art = el('div', 'nf-tv-hero-art');
        hero.appendChild(art);
        var copy = el('div', 'nf-tv-hero-copy');
        hero.appendChild(copy);
        panel.appendChild(hero);

        var guide = el('div', 'nf-tv-guide');
        panel.appendChild(guide);

        tvLoadPool(channel).then(function (pool) {
            var client = api();

            if (!pool) {
                // Nothing to draw yet; the next pass will have it.
                setTimeout(function () {
                    if (panel.isConnected) tvPaintChannel(panel, id);
                }, 1200);
                return;
            }

            var on = tvNow(channel, pool, tvClock());
            copy.textContent = '';

            var badges = el('div', 'nf-tv-badges');
            badges.appendChild(tvLockup(channel));

            if (!on) {
                copy.appendChild(badges);
                copy.appendChild(el('h2', 'nf-tv-bill-title', 'Fuori onda'));
                return;
            }

            var kicker = el('div', 'nf-tv-kicker');
            if (!on.inIdent) kicker.appendChild(el('span', 'nf-tv-dot'));
            kicker.appendChild(el('span', null, on.inIdent ? 'Fra poco' : 'In onda ora'));
            badges.appendChild(kicker);
            copy.appendChild(badges);

            if (client) art.style.backgroundImage = 'url("' + tvArt(on.slot.item, client, 'hero') + '")';

            var title = el('h2', 'nf-tv-bill-title', on.slot.item.name);
            copy.appendChild(title);
            tvDetails(on.slot.item.id).then(function (item) {
                var logo = tvLogoUrl(item, client);
                if (!logo) return;
                title.classList.add('has-logo');
                title.style.backgroundImage = 'url("' + logo + '")';
                title.setAttribute('aria-label', on.slot.item.name);
            });

            var meter = el('div', 'nf-tv-bill-meter');
            meter.appendChild(
                el('div', 'nf-tv-bill-clock',
                    (on.slot.show ? on.slot.show + '  ·  ' : '') +
                        tvTimeLabel(on.slot.start) + ' – ' + tvTimeLabel(on.slot.end) +
                        '  ·  ' + tvRemaining(on))
            );
            var bar = el('div', 'nf-tv-bar');
            var fill = el('span');
            bar.appendChild(fill);
            meter.appendChild(bar);
            fill.style.width =
                Math.min(100, Math.round((on.offset / (on.slot.end - on.slot.start)) * 100)) + '%';
            copy.appendChild(meter);

            tvDetails(on.slot.item.id).then(function (item) {
                if (!item || !item.Overview) return;
                copy.insertBefore(el('p', 'nf-tv-bill-blurb', item.Overview), copy.querySelector('.nf-tv-actions'));
            });

            var actions = el('div', 'nf-tv-actions');
            var watch = el('button', 'nf-btn nf-btn-primary');
            watch.type = 'button';
            watch.appendChild(svgIcon('play'));
            watch.appendChild(el('span', null, 'Guarda'));
            watch.addEventListener('click', function () {
                tvTune(channel.id, 'live');
            });

            var restart = el('button', 'nf-btn nf-btn-secondary');
            restart.type = 'button';
            restart.appendChild(svgIcon('restart'));
            restart.appendChild(el('span', null, "Dall'inizio"));
            restart.addEventListener('click', function () {
                tvTune(channel.id, 'restart');
            });

            var ambient = el('button', 'nf-btn nf-btn-secondary nf-tv-ambient-btn');
            ambient.type = 'button';
            ambient.appendChild(svgIcon('mute'));
            ambient.appendChild(el('span', null, 'Sottofondo'));
            ambient.addEventListener('click', function () {
                tvTune(channel.id, 'ambient');
            });

            actions.appendChild(watch);
            actions.appendChild(restart);
            actions.appendChild(ambient);
            copy.appendChild(actions);

            guide.appendChild(el('h3', null, 'Guida TV'));

            var day = null;
            tvGuide(channel, pool, tvClock()).forEach(function (slot, i) {
                var label = tvDayLabel(slot.start);
                if (label !== day) {
                    day = label;
                    guide.appendChild(el('div', 'nf-tv-day', label));
                }

                var row = el('div', 'nf-tv-row' + (i === 0 ? ' is-now' : ''));
                row.setAttribute('role', 'button');
                row.setAttribute('tabindex', '0');
                row.addEventListener('click', function () {
                    tvOpenRow(row, slot, channel);
                });
                row.addEventListener('keydown', function (event) {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    tvOpenRow(row, slot, channel);
                });

                if (i === 0) {
                    var progress = el('span', 'nf-tv-row-fill');
                    progress.style.width =
                        Math.min(100, Math.round((on.offset / (slot.end - slot.start)) * 100)) + '%';
                    row.appendChild(progress);
                }

                row.appendChild(el('span', 'nf-tv-row-time', tvTimeLabel(slot.start)));

                var text = el('span', 'nf-tv-row-text');
                text.appendChild(el('strong', null, slot.item.name));
                if (slot.show) text.appendChild(el('em', null, slot.show));
                row.appendChild(text);

                row.appendChild(
                    el('span', 'nf-tv-row-len', Math.round(slot.item.ms / 60000) + ' min')
                );
                row.appendChild(svgIcon('chevrondown'));
                guide.appendChild(row);
            });
        });
    }

    function tvTune(id, mode) {
        var channel = tvChannel(id);
        if (!channel) return;

        tvLoadPool(channel).then(function (pool) {
            var on = tvNow(channel, pool, Date.now());
            if (!on) return;

            // Restarting steps the clock back by however far in we were, and the
            // channel carries on from there - time-shifted, with a way back.
            tvState.shift = mode === 'restart' ? on.offset : 0;
            tvState.ambient = mode === 'ambient';
            tvState.channel = channel.id;
            tvState.tunedAt = Date.now();
            tvState.started = false;
            tvState.retried = false;
            tvState.pipTried = false;
            tvState.pending = { channel: channel, slot: on.slot, offset: mode === 'restart' ? 0 : on.offset };
        tvState.ended = false;

            tvGuardReporting(true);
            /* Only the panel comes down. Navigating away from the hash - which
             * this used to do - rebuilt the page underneath while playNow was
             * still looking for something to click, so pressing Guarda landed you
             * back on the home page with nothing playing. The hash stays as it
             * is, and refresh() knows not to reopen the page while a channel is
             * on, so leaving the player brings it back. */
            tvClose();

            tvPlay(on.slot.item, tvState.pending.offset);
            tvWatchPlayer();
        });
    }

    /* playNow clicks a card, and on this build that click reaches nothing at all:
     * no handler runs and the server is never even asked for PlaybackInfo. The
     * details page's own play button is a real, bound control, so a channel goes
     * through there. It costs a page behind the player, which is why leaving a
     * channel puts the hash back where it was. */
    function tvPlay(item, offset) {
        var client = api();
        var route = '#/details?id=' + item.id;

        /* The route is also how the channel knows it is still being watched.
         * Jellyfin leaves a <video> behind after you exit - 427x194, connected,
         * paused - so its presence proves nothing, and the OSD lingers too. The
         * hash does not: while a programme plays it is that programme's details
         * route, and the moment you stop, Jellyfin goes back and it is not. */
        tvState.route = route;
        tvState.slotId = item.id;

        if (window.location.hash.indexOf(route) !== 0) {
            window.location.hash = route + (client ? '&serverId=' + client.serverId() : '');
        }
        tvCover(true);
        tvPressPlay(0);
    }

    /* The details page is a means, not a destination: it is covered until the
     * player is up, so pressing Guarda shows the channel starting rather than a
     * title card flashing past. */
    function tvCover(on) {
        var cover = document.querySelector('.nf-tv-cover');
        if (!on) {
            if (cover) cover.remove();
            return;
        }

        var channel = tvChannel(tvState.channel);
        if (!channel) return;

        if (!cover) {
            cover = el('div', 'nf-tv-cover');
            cover.appendChild(tvLockup(channel));
            cover.appendChild(el('div', 'nf-tv-kicker', 'Sintonizzazione'));
            document.body.appendChild(cover);
        }
        cover.style.setProperty('--nf-tv-tone', channel.tone);
    }

    /* On air while the app is either on the programme's own page or in the
     * player it opened from there. */
    function tvOnAir() {
        var hash = window.location.hash;
        if (!tvState.route) return false;
        return hash.indexOf(tvState.route) === 0 || hash.indexOf('#/video') === 0;
    }

    /* A programme that has finished leaves its <video> behind - connected,
     * paused, with nothing loaded. Taking that for a running player is what
     * wedged the hand-over on the tuning card: the channel believed the next
     * programme had started, so it stopped waiting for it and stopped trying. */
    /* Asked for, and on its way. A transcode of a film this server has to encode
     * from scratch takes a while to produce its first segment, and during that
     * time the element exists with a source and nothing decoded. Pressing play
     * again then does real harm: it starts the whole thing over, so the wait
     * never ends and the channel eventually gives up on itself. */
    /* The server can fail to play a file outright - a codec its hardware cannot
     * decode, a broken remux - and jellyfin-web then puts up a dialog and waits
     * for someone to acknowledge it. Behind that dialog the channel would sit
     * for its four minutes of patience and leave on its own, so it is dismissed
     * and the channel closes at once, which at least says what happened. */
    function tvFatalDialog() {
        var dialogs = document.querySelectorAll('.dialogContainer, .dialog');
        for (var i = 0; i < dialogs.length; i++) {
            var text = dialogs[i].textContent || '';
            if (/playback error|fatal player|errore di riproduzione/i.test(text)) return dialogs[i];
        }
        return null;
    }

    function tvPlayerBusy() {
        var video = document.querySelector('.videoPlayerContainer video, video.htmlvideoplayer');
        return !!(video && (video.currentSrc || video.src));
    }

    function tvLiveVideo() {
        var video = document.querySelector('.videoPlayerContainer video, video.htmlvideoplayer');
        if (!video) return null;

        /* Reading "not paused" as playing was too generous: between pressing
         * play and the first frame - which on a transcode is a good while - the
         * element is unpaused with nothing loaded and no source, and taking that
         * for a running programme retired the retries that would have started
         * it. Something decoded, or a clock that has moved. */
        if (video.readyState >= 2) return video;
        if (video.currentTime > 0) return video;
        return null;
    }

    function tvPressPlay(tries) {
        if (!tvState.channel || !tvState.route) return;

        /* Still in the player the last programme was in. Leaving it is this
         * function's job rather than a reason to give up - returning here left
         * the hand-over with nobody to press anything, and the retry a second
         * later hit the same wall. */
        if (window.location.hash.indexOf('#/video') === 0) {
            window.location.hash = tvState.route;
        }

        var button = document.querySelector('.mainDetailButtons .btnResume, .mainDetailButtons .btnPlay');
        if (button && button.offsetParent !== null) {
            button.click();
            return;
        }

        // The page has to render first, and a transcoding server is not quick.
        if (tries < 80) {
            setTimeout(function () {
                tvPressPlay(tries + 1);
            }, 250);
        }
    }

    function tvStop() {
        var route = tvState.route;
        tvState.route = null;
        tvState.slotId = null;
        tvState.ambient = false;

        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(function () {});
        }
        tvState.channel = null;
        tvState.shift = 0;
        tvState.pending = null;
        tvState.started = false;
        tvState.retried = false;
        tvState.ended = false;
        if (tvState.timer) {
            clearInterval(tvState.timer);
            tvState.timer = null;
        }
        tvGuardReporting(false);
        document.body.classList.remove('nf-tv-on');
        tvCover(false);
        var skin = document.querySelector('.nf-tv-skin');
        if (skin) skin.remove();
        /* The details page is a detour this code took to reach the player, so
         * being left on it is not somewhere anyone navigated - undoing it is not
         * hijacking. Anywhere else, the viewer went there deliberately and is
         * left alone. */
        if (route && window.location.hash.indexOf(route) === 0) {
            window.location.hash = '#/home?nftv=1';
        }
    }

    /* The overlay that makes it a channel rather than a file: the watermark, and
     * the card that covers the ident between programmes. */
    function tvSkin() {
        var skin = document.querySelector('.nf-tv-skin');
        if (skin) return skin;

        skin = el('div', 'nf-tv-skin');

        // The channel's own lockup; tvWatchPlayer says which channel.
        var mark = el('div', 'nf-tv-bug');
        mark.appendChild(el('img', 'nf-tv-logo-art'));
        skin.appendChild(mark);

        var corner = el('button', 'nf-tv-corner');
        corner.type = 'button';
        corner.textContent = 'Riduci a finestra';
        corner.addEventListener('click', function () {
            var video = tvLiveVideo();
            if (!video) return;
            video.requestPictureInPicture().then(function () {
                skin.classList.remove('needs-pip');
            }).catch(function (err) {
                log('tv: the corner window is not available here', err);
            });
        });
        skin.appendChild(corner);

        /* The ident is a real clip, played by an element of ours rather than
         * through Jellyfin's player: it is already in a format every browser
         * takes, so there is nothing to transcode and no fake item in anyone's
         * library. What is coming next stays as text over it, because a video
         * per hand-over would be a file per hand-over. */
        var card = el('div', 'nf-tv-ident');

        var clip = el('video', 'nf-tv-ident-clip');
        clip.muted = false;
        clip.playsInline = true;
        clip.preload = 'auto';
        card.appendChild(clip);

        var copy = el('div', 'nf-tv-ident-copy');
        copy.appendChild(el('div', 'nf-tv-kicker', 'A seguire'));
        copy.appendChild(el('h2', null, ''));
        copy.appendChild(el('div', 'nf-tv-meta', ''));
        card.appendChild(copy);

        skin.appendChild(card);

        document.body.appendChild(skin);
        return skin;
    }

    function tvWatchPlayer() {
        document.body.classList.add('nf-tv-on');
        var skin = tvSkin();
        var channel = tvChannel(tvState.channel);
        if (channel) {
            var bug = skin.querySelector('.nf-tv-bug');
            var art = bug.querySelector('.nf-tv-logo-art');
            art.src = '/NetflixFin/tv/logo/' + channel.id;
            art.alt = channel.name;
            skin.style.setProperty('--nf-tv-tone', channel.tone);
        }
        skin.classList.toggle('is-shifted', tvState.shift > 0);

        hostPlayer();

        if (tvState.timer) clearInterval(tvState.timer);
        tvState.timer = setInterval(tvTick, 1000);
    }

    /* One second at a time. The order matters: the line-up is read before the
     * player, because between two programmes there is no player at all and that
     * is the schedule working, not the viewer leaving. */
    function tvTick() {
        if (!tvState.channel) return;

        /* Left the channel? The route says so - the player's leftovers outlive
         * it, so nothing about the <video> can be trusted here. The player has a
         * route of its own, #/video, and that counts as being on air. */
        if (tvState.started && tvState.route && !tvOnAir()) {
            tvStop();
            return;
        }

        var channel = tvChannel(tvState.channel);
        var pool = tvPools[channel.id];
        var on = pool ? tvNow(channel, pool, tvClock()) : null;

        var video = tvLiveVideo();
        if (video) {
            tvState.started = true;
            tvCover(false);
            if (tvState.ambient) tvAmbient(video);
        }

        tvPaintIdent(on);
        tvPaintOsd(on);

        var fatal = tvFatalDialog();
        if (fatal) {
            var acknowledge = fatal.querySelector('button');
            if (acknowledge) acknowledge.click();
            log('tv: the server could not play this one');
            tvStop();
            return;
        }

        if (!video) {
            if (!tvState.started) {
                var waited = Date.now() - tvState.tunedAt;

                /* Asking again, on a ladder. The click that starts playback is
                 * delegated by jellyfin-web, and one that lands while the page
                 * is still settling reaches nothing at all - silently - so the
                 * first rung is early. The later ones are for the hand-over,
                 * which asks the server for a new transcode with nobody
                 * watching the request: forty seconds of patience was short
                 * enough that a slow one ended the evening.
                 *
                 * Counted rather than named. Naming the rungs let a later one
                 * satisfy an earlier one's test, so the channel pressed play
                 * every second and never reached the point of giving up. */
                var rungs = [6000, 20000, 45000];
                var asked = tvState.retried || 0;
                if (asked < rungs.length && waited > rungs[asked] && tvState.pending && !tvPlayerBusy()) {
                    tvState.retried = asked + 1;
                    log('tv: nothing started yet, asking again (' + (asked + 1) + ')');
                    tvPressPlay(0);
                    return;
                }

                // Four minutes of patience while something is loading, ninety
                // seconds when nothing was ever asked for.
                if (waited > (tvPlayerBusy() ? 240000 : 90000)) {
                    log('tv: nothing started, leaving the channel');
                    tvStop();
                }
                return;
            }

            /* No player, on a channel that has been running. Jellyfin takes the
             * player down when a programme ends, and reading that as a departure
             * is what sent the viewer back to the TV page exactly as the ident
             * came up. Only a stop in the middle of a programme, with nothing
             * else under way, is someone leaving. */
            if (tvState.pending) return;
            if (on && on.inIdent) return;
            if (on && tvState.slotId && on.slot.item.id !== tvState.slotId) {
                tvHandOver(on);
                return;
            }

            /* The player is gone while the line-up still has this programme on.
             * The two do not end on the same second - the seek is allowed
             * fifteen seconds of slack and a file rarely runs to the length its
             * metadata claims - so the last minutes of a programme are exactly
             * where its ending looks like someone leaving. Near the end it is
             * the ending: the ident comes up early and the channel waits for
             * what is next instead of dropping the viewer on the TV page. */
            if (on && on.slot.end - tvClock() < TV_TAIL_MS) {
                tvState.ended = true;
                tvPaintIdent(on);
                return;
            }

            // No line-up at all is a pool still loading, not a departure.
            if (!on) return;

            tvStop();
            return;
        }

        /* One seek at readyState 1 was not enough: the player applies its own
         * start position once the metadata lands, so the programme went back to
         * the beginning a moment after being put in the right place. It repeats
         * until the video sits within fifteen seconds of where the channel is,
         * and the target is recomputed each time so a slow start lands on the
         * clock rather than in the past. */
        var pending = tvState.pending;
        if (pending && video.readyState >= 1) {
            var wanted = on && on.slot.item.id === pending.slot.item.id ? on.offset : pending.offset;
            // "Dall'inizio" means zero and stays zero.
            if (pending.offset === 0) wanted = 0;

            var here = video.currentTime * 1000;
            if (Math.abs(here - wanted) > 15000) {
                pending.tries = (pending.tries || 0) + 1;
                if (pending.tries <= 25) {
                    seekTo(video, wanted / 1000);
                } else {
                    log('tv: the seek would not hold, leaving it where it is');
                    tvState.pending = null;
                }
            } else {
                tvState.pending = null;
            }
        }

        if (!on || on.inIdent || tvState.pending) return;

        // The line-up has moved on while the last programme was still on screen.
        if (tvState.slotId && on.slot.item.id !== tvState.slotId) {
            tvHandOver(on);
        }
    }

    /* Left on rather than watched: muted, and in the browser's own corner window
     * where there is one. Picture-in-Picture wants a gesture it can trace back to
     * the viewer, and this is several steps and a page load away from the button
     * that started it, so a refusal is expected rather than exceptional - the
     * skin then offers a button, and a tap on that is a gesture by definition.
     *
     * The corner window lives on the same element the player owns. Navigating far
     * enough for Jellyfin to tear that element down takes the window with it, and
     * the channel stops the way it does anywhere else. */
    function tvAmbient(video) {
        video.muted = true;

        var skin = document.querySelector('.nf-tv-skin');
        if (skin) skin.classList.add('is-ambient');

        if (tvState.pipTried || !document.pictureInPictureEnabled) return;
        if (document.pictureInPictureElement) return;
        if (video.readyState < 2) return;

        tvState.pipTried = true;
        video.requestPictureInPicture().catch(function (err) {
            log('tv: the corner window was refused, offering the button', err);
            if (skin) skin.classList.add('needs-pip');
        });
    }

    function tvPaintOsd(on) {
        if (!player || !player.live || !tvState.channel) return;

        var channel = tvChannel(tvState.channel);
        var live = player.live;
        if (channel) player.node.style.setProperty('--nf-tv-tone', channel.tone);

        var shifted = tvState.shift > 0;
        live.pill.classList.toggle('is-shifted', shifted);
        live.word.textContent = shifted ? 'Torna in diretta' : 'Diretta';

        if (!on) return;

        live.title.textContent = on.slot.item.name;
        live.sub.textContent =
            (channel ? channel.name : '') +
            (on.next ? ' · A seguire ' + on.next.item.name + ' alle ' + tvTimeLabel(on.next.start) : '');
        live.start.textContent = tvTimeLabel(on.slot.start);
        live.end.textContent = tvTimeLabel(on.slot.end);

        var span = on.slot.end - on.slot.start;
        live.fill.style.width = Math.min(100, Math.round((on.offset / span) * 100)) + '%';
    }

    function tvHandOver(on) {
        var channel = tvChannel(tvState.channel);
        log('tv: handing over to ' + on.slot.item.name);
        tvState.pending = { channel: channel, slot: on.slot, offset: on.offset };
        tvState.ended = false;
        tvState.started = false;
        tvState.retried = false;
        tvState.tunedAt = Date.now();
        tvPlay(on.slot.item, on.offset);
    }

    /* The card that covers the ident slot, with what is coming on it. */
    function tvPaintIdent(on) {
        var skin = document.querySelector('.nf-tv-skin');
        if (!skin || !on) return;

        if (!on.inIdent && !tvState.ended) {
            skin.classList.remove('is-ident');
            return;
        }
        if (skin.classList.contains('is-ident')) return;

        var card = skin.querySelector('.nf-tv-ident');
        var channel = tvChannel(tvState.channel);
        skin.classList.add('is-ident');
        card.querySelector('h2').textContent = on.next ? on.next.item.name : '';
        card.querySelector('.nf-tv-meta').textContent =
            (on.next && on.next.show) || (channel && channel.name) || '';

        var clip = card.querySelector('.nf-tv-ident-clip');
        if (clip && channel) {
            var source = '/NetflixFin/tv/ident/' + channel.id;
            if (clip.getAttribute('data-nf-ident') !== channel.id) {
                clip.setAttribute('data-nf-ident', channel.id);
                clip.src = source;
            }
            clip.currentTime = 0;
            /* Started by the hand-over, which the viewer set going, so the
             * browser counts it as wanted rather than as an advert starting
             * itself. If it is refused anyway the card stands on its own. */
            var playing = clip.play();
            if (playing && playing.catch) {
                playing.catch(function () {
                    clip.muted = true;
                    clip.play().catch(function () {});
                });
            }
        }
    }

    function refresh() {
        applyTileCount();
        applyBodyFlags();
        publishHeaderHeight();
        applyPhoneMark();
        if (tvOnPage() && !tvState.channel) tvOpen();
        else if (!tvOnPage()) tvClose();
        applyLogo();
        publishBrandLogo();
        netflixHeaderIcons();
        buildNav();
        buildTabBar();
        decorateDetail();
        mountHero();
        decorateTop10();
        decorateRows();
        paintSagaRow();
        managePlayer();
        widenCards();
        reapplyThumbs();
    }

    function schedule() {
        if (scheduled) return;
        scheduled = setTimeout(function () {
            scheduled = null;
            refresh();
        }, 150);
    }

    function start() {
        applyTileCount();
        window.addEventListener(
            'resize',
            function () {
                applyTileCount();
                publishHeaderHeight();
                // The rows' arrows and page dots are sized off the viewport, and this
                // is the one place that redraws them - the alternative was a listener
                // per row, which leaked.
                decorateRows();
            },
            { passive: true });
        applyBodyFlags();
        bindScrollState();
        bindPreview();
        bindModal();

        // One listener for the life of the page: the player is rebuilt often, and
        // binding this per player would leave one behind every time.
        document.addEventListener('fullscreenchange', hostPlayer);
        document.addEventListener('webkitfullscreenchange', hostPlayer);

        // Both go out immediately, in parallel with jellyfin-web's own boot, rather
        // than waiting for a render that only happens a second and a half later.
        if (cfg.enableHeroBanner) heroItems();
        loadAwards();

        refresh();

        // Attributes are watched too: the lazy loader rewrites card backgrounds
        // in place, which is not a childList change.
        new MutationObserver(schedule).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });

        window.addEventListener('hashchange', function () {
            if (heroTeardown) heroTeardown();
            schedule();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
