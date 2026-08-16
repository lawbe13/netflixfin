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
    function playNow(id, serverId, type) {
        if (!id) return;

        var card = document.querySelector('.card[data-id="' + id + '"]');
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
            button.setAttribute('data-action', 'resume');
            proxy.appendChild(button);

            (document.querySelector('.itemsContainer') || document.body).appendChild(proxy);
            button.click();
            setTimeout(function () {
                proxy.remove();
            }, 0);
        }

        // If nothing started, fall back to the route that always worked.
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
        // Two measured anchors: 1512 wants five, 1920 and 2133 want seven. The
        // boundary therefore sits between them, not at 1400 - which is what put
        // seven on the laptop.
        var width = window.innerWidth;
        var tiles = width >= 1800 ? 7 : width >= 1200 ? 5 : width >= 700 ? 4 : 3;
        var root = document.documentElement;
        if (root.style.getPropertyValue('--nf-tiles') !== String(tiles)) {
            root.style.setProperty('--nf-tiles', String(tiles));
            log('tiles', tiles, 'at', width);
        }
    }

    function applyBodyFlags() {
        document.body.classList.toggle('nf-hover-preview', !!cfg.enableHoverPreview);
        document.body.classList.toggle('nf-hide-card-text', !!cfg.hideCardText);
        // nf-playing is managePlayer's alone - see the note there.
    }

    function bindScrollState() {
        var update = function () {
            var scroller = document.querySelector('.mainAnimatedPages') || document.documentElement;
            var y = window.scrollY || scroller.scrollTop || 0;
            document.body.classList.toggle('nf-scrolled', y > 60);
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

        return targets;
    }

    function markActive(nav) {
        var hash = window.location.hash;
        nav.querySelectorAll('[data-nf-hash]').forEach(function (node) {
            var target = node.getAttribute('data-nf-hash');
            node.classList.toggle('is-active', hash.indexOf(target.replace('#', '')) === 1);
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

        var nav = el('nav', 'nf-nav');
        nav.dataset.nfSignature = signature;

        targets.forEach(function (target, i) {
            var node;
            if (target.hash) {
                node = el('a', null, target.label);
                node.href = target.hash;
                node.setAttribute('data-nf-hash', target.hash);

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

    /* ------------------------------------------------------- detail page */

    /* Netflix's title card carries its own key art. Jellyfin paints the backdrop
     * on a fixed, full-viewport layer instead, so the art is rebuilt inside the
     * card - and the logo, which Jellyfin parks outside the container, is moved
     * in so it can be positioned against it. */
    function mountDetailArt() {
        var container = document.querySelector('.detailPagePrimaryContainer');
        if (!container) return;

        var match = window.location.hash.match(/[?&]id=([^&]+)/);
        if (!match) return;
        var id = match[1];

        var client = api();
        if (!client) return;

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

    var detailLogoTimer = null;
    var detailLogoTries = 0;

    function decorateDetail() {
        var onDetail = /#\/details/.test(window.location.hash);
        document.body.classList.toggle('nf-detail', onDetail);
        if (!onDetail) {
            document.body.classList.remove('nf-detail-logo');
            return;
        }

        mountDetailArt();

        var logo = document.querySelector('.detailLogo');
        var hasLogo = !!logo && getComputedStyle(logo).backgroundImage !== 'none';
        document.body.classList.toggle('nf-detail-logo', hasLogo);

        // The logo arrives as a lazy-loaded background-image, which is not a DOM
        // mutation, so the observer never sees it land and it has to be polled for.
        // One poll at a time, and not forever: this used to schedule an
        // uncancellable call on every refresh, so each pass through here started a
        // fresh chain on top of the ones already running.
        if (detailLogoTimer) {
            clearTimeout(detailLogoTimer);
            detailLogoTimer = null;
        }
        if (logo && !hasLogo && detailLogoTries < 8) {
            detailLogoTries++;
            detailLogoTimer = setTimeout(decorateDetail, 700);
        } else if (hasLogo || !logo) {
            detailLogoTries = 0;
        }

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
        fav.title = 'Preferiti';
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
         * up, and a double thumb up for "love this". Jellyfin models this as
         * UserData.Likes, a nullable boolean - null unrated, false down, true up -
         * so the third option has nowhere to be stored and is left out rather than
         * faked. */
        var liked = item.UserData ? item.UserData.Likes : null;
        var rate = el('div', 'nf-rate');
        var rateBtn = el('button', 'nf-circle nf-rate-open');
        rateBtn.type = 'button';
        rateBtn.title = 'Valuta';

        var paintRate = function () {
            rateBtn.replaceChildren(svgIcon(liked === false ? 'thumbdown' : 'thumbup'));
            rateBtn.classList.toggle('is-rated', liked === true || liked === false);
        };

        var setRating = function (value) {
            var userId = client.getCurrentUserId();
            // Pressing the choice you already hold clears it, which is how Netflix
            // un-rates a title.
            var next = liked === value ? null : value;
            var call =
                next === null
                    ? client.ajax({
                        type: 'DELETE',
                        url: client.getUrl('UserItems/' + item.Id + '/Rating', { userId: userId })
                    })
                    : client.ajax({
                        type: 'POST',
                        url: client.getUrl('UserItems/' + item.Id + '/Rating', {
                            userId: userId,
                            likes: next
                        })
                    });
            call.then(function () {
                liked = next;
                paintRate();
            }).catch(function (err) {
                log('could not save the rating', err);
            });
        };

        var options = el('div', 'nf-rate-options');
        [
            { glyph: 'thumbdown', label: 'Non fa per me', value: false },
            { glyph: 'thumbup', label: 'Mi piace', value: true }
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
        var resume = item.UserData && item.UserData.PlaybackPositionTicks > 0;
        var remove = null;
        if (resume) {
            remove = el('button', 'nf-circle');
            remove.type = 'button';
            remove.title = 'Rimuovi da Continua a guardare';
            remove.appendChild(svgIcon('close'));
            remove.addEventListener('click', function () {
                client
                    .ajax({
                        type: 'POST',
                        url: client.getUrl('UserItems/' + item.Id + '/UserData', {
                            userId: client.getCurrentUserId()
                        }),
                        data: JSON.stringify({ PlaybackPositionTicks: 0 }),
                        contentType: 'application/json',
                        dataType: 'json'
                    })
                    .then(function () {
                        destroyPreview();
                        // The row is server-rendered, so the tile has to go by hand.
                        var tile = card.closest('.card');
                        if (tile) tile.remove();
                    })
                    .catch(function (err) {
                        log('could not remove from continue watching', err);
                    });
            });
        }

        var expand = el('button', 'nf-circle');
        expand.type = 'button';
        expand.title = 'Altre info';
        expand.appendChild(icon('expand_more'));
        expand.addEventListener('click', function () {
            destroyPreview();
            openModal(item.Id);
        });

        actions.appendChild(play);
        actions.appendChild(fav);
        actions.appendChild(watched);
        actions.appendChild(rate);
        if (remove) actions.appendChild(remove);
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
        close: 'M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z',
        search: 'M10 2a8 8 0 105 14.3l5.3 5.3 1.4-1.4-5.3-5.3A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z',
        /* Netflix's award call-out uses a laurel wreath, not a trophy: two branches
         * curving up and open at the top, in gold. */
        laurel:
            'M12 20.6c-2.1-1.3-3.4-3-3.4-5.3 0-1 .2-1.9.6-2.7-1.5-.6-2.7-1.7-3.4-3.2C5 7.7 4.9 5.8 5.5 3.9c1.9.2 3.5 1 4.6 2.4.9 1.1 1.4 2.4 1.5 3.8V4h.8v6.1c.1-1.4.6-2.7 1.5-3.8 1.1-1.4 2.7-2.2 4.6-2.4.6 1.9.5 3.8-.3 5.5-.7 1.5-1.9 2.6-3.4 3.2.4.8.6 1.7.6 2.7 0 2.3-1.3 4-3.4 5.3zM7 5.2c-.2 1.3 0 2.5.5 3.6.5 1.1 1.3 1.9 2.4 2.4.1-1.4-.2-2.7-.9-3.8-.5-.9-1.2-1.6-2-2.2zm10 0c-.8.6-1.5 1.3-2 2.2-.7 1.1-1 2.4-.9 3.8 1.1-.5 1.9-1.3 2.4-2.4.5-1.1.7-2.3.5-3.6zm-5 6.9c-.9.9-1.4 2-1.4 3.2 0 1.3.5 2.4 1.4 3.3.9-.9 1.4-2 1.4-3.3 0-1.2-.5-2.3-1.4-3.2z',
        /* And a megaphone for "new season" / "new episode". */
        thumbup:
            'M2 20h3V9H2v11zm19.8-9.2c.1-.2.2-.5.2-.8v-1c0-1.1-.9-2-2-2h-4.6l.7-3.4v-.3c0-.4-.2-.8-.4-1.1L14.6 1 8.3 7.3c-.4.4-.6.9-.6 1.4V18c0 1.1.9 2 2 2h8c.8 0 1.5-.5 1.8-1.2l2.3-5.4c.1-.2.1-.4.1-.6v-1c0-.4-.1-.7-.1-1z',
        thumbdown:
            'M22 4h-3v11h3V4zM2.2 13.2c-.1.2-.2.5-.2.8v1c0 1.1.9 2 2 2h4.6l-.7 3.4v.3c0 .4.2.8.4 1.1L9.4 23l6.3-6.3c.4-.4.6-.9.6-1.4V6c0-1.1-.9-2-2-2H6c-.8 0-1.5.5-1.8 1.2L1.9 10.6c-.1.2-.1.4-.1.6v1c0 .4.1.7.1 1z',
        megaphone:
            'M20 3.5v17a1 1 0 01-1.6.8L11 15.6v3.9a2.5 2.5 0 01-5 0v-4H5a3 3 0 01-3-3v-1a3 3 0 013-3h6l7.4-5.7a1 1 0 011.6.7zM8 15.5v4a.5.5 0 001 0v-4H8z',
        bell: 'M12 22a2.5 2.5 0 002.5-2.5h-5A2.5 2.5 0 0012 22zm7-6v-5a7 7 0 00-5.5-6.8V3a1.5 1.5 0 00-3 0v1.2A7 7 0 005 11v5l-2 2v1h18v-1l-2-2z'
    };

    function svgIcon(name) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', GLYPHS[name] || GLYPHS.play);
        svg.appendChild(path);
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
    }

    function showPlayerChrome() {
        if (!player) return;
        player.node.classList.remove('is-idle');
        clearTimeout(playerHideTimer);
        playerHideTimer = setTimeout(function () {
            if (!player || player.video.paused) return;
            // An open panel keeps the chrome up. It lives inside .nf-player, so
            // fading the chrome faded the panel with it - hover opened it and
            // three seconds later it was gone, which read as hover doing nothing.
            if (player.node.querySelector('.nf-p-panel')) return;
            player.node.classList.add('is-idle');
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
        if (!player) return;
        var target = document.fullscreenElement || document.webkitFullscreenElement;
        if (target && target.tagName === 'VIDEO') return;
        var host = target || document.body;
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
        left.appendChild(playBtn);
        left.appendChild(
            playerButton('back10', 'Indietro di 10 secondi', function () {
                seekTo(video, video.currentTime - 10);
                flashGlyph('back10');
            })
        );
        left.appendChild(
            playerButton('forward10', 'Avanti di 10 secondi', function () {
                seekTo(video, video.currentTime + 10);
                flashGlyph('forward10');
            })
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
            })
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
        bottom.appendChild(row);
        node.appendChild(bottom);

        player = { node: node, video: video, seriesId: null };
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
            if (!item || !player) return;
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
        ensureItem();
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
        return fromRoute ? fromRoute[1] : null;
    }

    /* Resolved once per player and remembered, so a press that arrives before the
     * answer waits for it rather than being dropped. */
    function ensureItem() {
        if (!player) return Promise.resolve(null);
        if (player.itemPromise) return player.itemPromise;

        var client = api();
        if (!client) return Promise.resolve(null);

        var id = currentItemId();
        if (!id) {
            // Last resort, and the one that always knows: ask the server what this
            // device is playing.
            var waiting = player;
            player.itemPromise = client
                .getSessions({ deviceId: client.deviceId() })
                .then(function (sessions) {
                    var mine = (sessions || []).filter(function (session) {
                        return session.NowPlayingItem;
                    })[0];
                    if (!mine || player !== waiting) return null;
                    waiting.sessionItemId = mine.NowPlayingItem.Id;
                    waiting.itemPromise = null;
                    return ensureItem();
                })
                .catch(function (err) {
                    if (player === waiting) waiting.itemPromise = null;
                    log('could not read the playback session', err);
                    return null;
                });
            return player.itemPromise;
        }

        var current = player;
        player.itemPromise = client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                if (player === current && current.label) current.label(item);
                return item;
            })
            .catch(function (err) {
                // Clear it so the next press can try again rather than inheriting
                // a rejected promise for the life of the player.
                if (player === current) current.itemPromise = null;
                log('could not resolve the playing item', err);
                return null;
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
            layer.style.backgroundImage =
                'url("' +
                client.getImageUrl(item.Id, {
                    type: 'Backdrop',
                    maxWidth: 1920,
                    tag: item.BackdropImageTags && item.BackdropImageTags[0]
                }) +
                '")';
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

            // "Serie • Fantascienza • 2020 • 5 stagioni • 16+"
            meta.textContent = '';
            var bits = [];
            bits.push(item.Type === 'Series' ? 'Serie' : 'Film');
            if (item.Genres && item.Genres.length) bits.push(item.Genres[0]);
            if (item.ProductionYear) bits.push(String(item.ProductionYear));
            var runtime = runtimeLabel(item);
            if (runtime) bits.push(runtime);
            if (item.OfficialRating) bits.push(item.OfficialRating);
            bits.forEach(function (bit, i) {
                if (i) meta.appendChild(el('span', 'nf-dot', '●'));
                meta.appendChild(el('span', null, bit));
            });

            overview.textContent = item.Overview || '';

            paintBadges();
            tintFrom(item, client);
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
                if (!data || !data.items.length) return;

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

    function refresh() {
        applyTileCount();
        applyBodyFlags();
        applyLogo();
        netflixHeaderIcons();
        buildNav();
        decorateDetail();
        mountHero();
        decorateTop10();
        decorateRows();
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
