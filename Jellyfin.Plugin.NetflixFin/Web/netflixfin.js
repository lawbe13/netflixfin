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

    function goToDetails(id, serverId, autoplay) {
        window.location.hash = '/details?id=' + id + '&serverId=' + serverId;
        if (!autoplay) return;
        // The details view builds asynchronously; press its own play button.
        waitFor('.mainDetailButtons .btnResume, .mainDetailButtons .btnPlay', 6000, function (btn) {
            if (btn) btn.click();
        });
    }

    /* ------------------------------------------------------------ body flags */

    function applyBodyFlags() {
        document.body.classList.toggle('nf-hover-preview', !!cfg.enableHoverPreview);
        document.body.classList.toggle('nf-hide-card-text', !!cfg.hideCardText);

        // Netflix's player chrome is a back arrow and nothing else, so the rest of
        // the header steps aside whenever a video is on screen.
        document.body.classList.toggle(
            'nf-playing',
            !!document.querySelector('.videoPlayerContainer video, .videoOsdBottom')
        );
    }

    function bindScrollState() {
        var update = function () {
            var scroller = document.querySelector('.mainAnimatedPages') || document.documentElement;
            var y = window.scrollY || scroller.scrollTop || 0;
            document.body.classList.toggle('nf-scrolled', y > 60);
        };
        window.addEventListener('scroll', update, { passive: true, capture: true });
        document.addEventListener('scroll', update, { passive: true, capture: true });
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
        // mutation, so the observer never sees it land.
        if (logo && !hasLogo) setTimeout(decorateDetail, 700);

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
                    slider.addEventListener('scroll', update, { passive: true });
                    window.addEventListener('resize', update, { passive: true });
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
                var ids = cards.map(function (card) {
                    return card.dataset.id;
                });

                client
                    .getItems(client.getCurrentUserId(), {
                        Ids: ids.join(','),
                        EnableImageTypes: 'Thumb',
                        EnableTotalRecordCount: false
                    })
                    .then(function (result) {
                        var tags = {};
                        (result.Items || []).forEach(function (item) {
                            if (item.ImageTags && item.ImageTags.Thumb) {
                                tags[item.Id] = item.ImageTags.Thumb;
                            }
                        });

                        if (!ids.every(function (id) { return tags[id]; })) {
                            row.dataset.nfThumb = 'no-thumbs';
                            return;
                        }

                        cards.forEach(function (card) {
                            var container = card.querySelector('.cardImageContainer');
                            if (!container) return;

                            var url = client.getImageUrl(card.dataset.id, {
                                type: 'Thumb',
                                maxWidth: 640,
                                tag: tags[card.dataset.id]
                            });

                            // Jellyfin drops its blurhash when its own image loads.
                            // Ours is a different URL, so that never fires.
                            var preload = new Image();
                            preload.onload = function () {
                                container.classList.remove('blurhashed');
                            };
                            preload.src = url;

                            container.dataset.nfThumbUrl = url;
                            container.style.backgroundImage = 'url("' + url + '")';
                            card.classList.add('nf-thumb');
                        });

                        row.dataset.nfThumb = 'yes';
                        log('thumbed row of', cards.length);
                    })
                    .catch(function (err) {
                        row.dataset.nfThumb = 'error';
                        log('thumb lookup failed', err);
                    });
            });
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
            container.classList.remove('blurhashed');
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
                                    goToDetails(episode.Id, episode.ServerId, true);
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
            goToDetails(resumeOf.Id, resumeOf.ServerId, true);
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
            goToDetails(item.Id, item.ServerId, true);
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

        var watched = el('button', 'nf-circle');
        watched.type = 'button';
        watched.title = 'Visto';
        watched.appendChild(icon('check'));
        watched.addEventListener('click', function () {
            client.markPlayed(client.getCurrentUserId(), item.Id, new Date());
            watched.style.borderColor = '#fff';
        });

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

    function bindPreview() {
        if (document.body.dataset.nfPreviewBound) return;
        document.body.dataset.nfPreviewBound = '1';

        document.addEventListener(
            'mouseover',
            function (event) {
                if (!cfg.enableHoverPreview) return;
                if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

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

    /* Netflix's transport is one row: play/back-10/forward-10/volume hard left,
     * title centred, next-episode/episodes/subtitles/fullscreen hard right, with
     * a full-width scrubber above it.
     *
     * Jellyfin's controls are *moved* into that arrangement rather than
     * reimplemented. Rebuilding them would mean re-deriving seeking, which the
     * server drives differently for direct play and for transcodes; relocating
     * the real elements keeps every behaviour attached to them. An earlier
     * attempt to rearrange the same controls with flex order instead tore the
     * layout apart, because the OSD is not one flex row to begin with. */
    /* DISABLED. Relocating Jellyfin's controls produced a player that looked
     * closer to Netflix but whose buttons no longer responded - twice. The OSD
     * carries behaviour that does not survive being re-parented, and a player
     * that cannot be operated is worse than one that is merely styled. It is
     * kept here as a record of the approach, not called.
     *
     * Doing this properly means driving playback ourselves rather than moving
     * Jellyfin's widgets, which is a much larger piece of work. */
    function layoutPlayerDisabled() {
        var osd = document.querySelector('.videoOsdBottom');
        if (!osd) return;
        if (osd.querySelector('.nf-osd')) return;

        // Half a rearrangement is worse than none: if this build of jellyfin-web
        // does not have the pieces this expects, the stock OSD is left exactly as
        // it is rather than being taken apart into something unusable.
        var essential = osd.querySelector('.sliderContainer');
        var transport = osd.querySelector('.btnPause, .btnPlay');
        if (!essential || !transport) {
            log('player: expected controls not found, leaving the OSD alone');
            return;
        }

        var shell = el('div', 'nf-osd');
        var scrub = el('div', 'nf-osd-scrub');
        var row = el('div', 'nf-osd-row');
        var left = el('div', 'nf-osd-left');
        var centre = el('div', 'nf-osd-centre');
        var right = el('div', 'nf-osd-right');

        row.appendChild(left);
        row.appendChild(centre);
        row.appendChild(right);
        shell.appendChild(scrub);
        shell.appendChild(row);

        // One at a time, in the order Netflix places them - a selector list would
        // move them in DOM order instead, which is how the transport came out as
        // PiP/rewind/pause/forward.
        var move = function (selector, target) {
            var node = osd.querySelector(selector);
            if (node && node.parentNode !== target) target.appendChild(node);
            return node;
        };

        // The volume control is a .sliderContainer too, which is why two bars
        // ended up side by side in the scrubber row. Take the seek slider by
        // identity, not by class alone.
        var sliders = Array.prototype.filter.call(
            osd.querySelectorAll('.sliderContainer'),
            function (node) {
                return !node.closest('.volumeButtons, .osdVolumeSliderContainer');
            }
        );
        if (sliders[0]) scrub.appendChild(sliders[0]);
        move('.osdDurationText', scrub);

        move('.btnPause, .btnPlay', left);
        move('.btnRewind', left);
        move('.btnFastForward', left);
        var volume = move('.volumeButtons', left);
        if (!volume) {
            move('.buttonMute', left);
            move('.osdVolumeSliderContainer', left);
        }

        move('.osdTextContainer', centre) || move('.osdTitle', centre);

        move('.btnNextTrack', right);
        move('.btnSubtitles', right);
        move('.btnAudio', right);
        move('.btnFullscreen, .btnToggleFullscreen', right);

        osd.appendChild(shell);
    }

    /* ------------------------------------------------- player component */

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

    function openEpisodesPanel(hovered) {
        if (!player) return;
        var client = api();
        var seriesId = player.seriesId;
        if (!client || !seriesId) return;

        var wasOpen = player.node.querySelector('.nf-p-panel-episodes');
        // Hover only ever opens; a click still toggles.
        if (wasOpen && hovered === true) return;
        closePanels();
        if (wasOpen) return;

        var panel = panelShell('Episodi', 'nf-p-panel-episodes');

        // Netflix lets you move between seasons from inside this panel.
        var picker = el('select', 'nf-p-season');
        panel.querySelector('.nf-p-panel-head').appendChild(picker);

        var list = el('div', 'nf-p-panel-body');
        panel.appendChild(list);
        player.node.appendChild(panel);

        var render = function (seasonId) {
            list.textContent = '';
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
                    var row = el('div', 'nf-p-episode' + (episode.Id === player.itemId ? ' is-current' : ''));
                    row.appendChild(el('div', 'nf-p-episode-index', String(episode.IndexNumber || '')));

                    var thumb = el('div', 'nf-p-episode-thumb');
                    thumb.style.backgroundImage =
                        'url("' + client.getImageUrl(episode.Id, { type: 'Primary', maxWidth: 280 }) + '")';
                    row.appendChild(thumb);

                    var text = el('div');
                    text.appendChild(el('h4', null, episode.Name));
                    var mins = minutes(episode.RunTimeTicks);
                    text.appendChild(el('p', null, (mins ? mins + 'm  ' : '') + (episode.Overview || '')));
                    row.appendChild(text);

                        row.addEventListener('click', function () {
                            closePanels();
                            goToDetails(episode.Id, episode.ServerId, true);
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
                var seasons = result.Items || [];
                seasons.forEach(function (season) {
                    var option = el('option', null, season.Name);
                    option.value = season.Id;
                    picker.appendChild(option);
                });
                if (!seasons.length) {
                    picker.remove();
                    render(player.seasonId);
                    return;
                }
                var start = player.seasonId && seasons.some(function (season) {
                    return season.Id === player.seasonId;
                })
                    ? player.seasonId
                    : seasons[0].Id;
                picker.value = start;
                picker.addEventListener('change', function () {
                    render(picker.value);
                });
                render(start);
            })
            .catch(function () {
                picker.remove();
                render(player.seasonId);
            });
    }

    function openTracksPanel(hovered) {
        if (!player) return;
        var client = api();
        if (!client || !player.itemId) return;

        var wasOpen = player.node.querySelector('.nf-p-panel-tracks');
        if (wasOpen && hovered === true) return;
        closePanels();
        if (wasOpen) return;

        var panel = panelShell('Audio e sottotitoli', 'nf-p-panel-tracks');
        var body = el('div', 'nf-p-panel-body nf-p-tracks');
        panel.appendChild(body);
        player.node.appendChild(panel);

        client
            .getItem(client.getCurrentUserId(), player.itemId)
            .then(function (item) {
                var streams = item.MediaStreams || [];
                var pm = window.playbackManager;

                var column = function (heading, kind, apply) {
                    var col = el('div', 'nf-p-track-col');
                    col.appendChild(el('h4', null, heading));

                    var options = streams.filter(function (stream) {
                        return stream.Type === kind;
                    });

                    if (kind === 'Subtitle') {
                        options = [{ Index: -1, DisplayTitle: 'Non attivi' }].concat(options);
                    }

                    options.forEach(function (stream) {
                        var button = el(
                            'button',
                            'nf-p-track',
                            stream.DisplayTitle || stream.Language || 'Traccia ' + stream.Index
                        );
                        button.type = 'button';
                        button.addEventListener('click', function () {
                            apply(stream.Index, pm);
                            body.querySelectorAll('.nf-p-track').forEach(function (other) {
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

    function proxyClick(selector) {
        var target = document.querySelector(selector);
        if (target) target.click();
    }

    function destroyPlayer() {
        if (!player) return;
        if (player.node.parentNode) player.node.parentNode.removeChild(player.node);
        player = null;
        document.body.classList.remove('nf-playing');
    }

    function showPlayerChrome() {
        if (!player) return;
        player.node.classList.remove('is-idle');
        clearTimeout(playerHideTimer);
        playerHideTimer = setTimeout(function () {
            if (player && !player.video.paused) player.node.classList.add('is-idle');
        }, 3000);
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
            video.volume = Number(volume.value) / 100;
            video.muted = Number(volume.value) === 0;
        });
        var volumeWrap = el('div', 'nf-p-volume-wrap');
        volumeWrap.appendChild(volumeBtn);
        volumeWrap.appendChild(volume);
        left.appendChild(volumeWrap);

        // Right cluster mirrors Netflix: next episode, episode list, subtitles,
        // fullscreen. The first three only make sense for an episode.
        var proxy = function (selector) {
            var target = document.querySelector(selector);
            if (target) target.click();
        };

        right.appendChild(
            playerButton('next', 'Prossimo episodio', function () {
                proxy('.videoOsdBottom .btnNextTrack');
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

        right.appendChild(hoverPanel(playerButton('episodes', 'Episodi', openEpisodesPanel), openEpisodesPanel));
        right.appendChild(
            hoverPanel(playerButton('subtitles', 'Sottotitoli e audio', openTracksPanel), openTracksPanel)
        );
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

        document.body.appendChild(node);

        player = { node: node, video: video, range: range, remaining: remaining, title: centre, playBtn: playBtn, seriesId: null };

        // A range input answers the wheel when the pointer is over it, so
        // scrolling the page was dragging the volume and the playhead.
        [range, volume].forEach(function (input) {
            input.addEventListener(
                'wheel',
                function (event) {
                    event.preventDefault();
                },
                { passive: false }
            );
        });

        var scrubbing = false;
        range.addEventListener('input', function () {
            scrubbing = true;
        });
        range.addEventListener('change', function () {
            scrubbing = false;
            var duration = video.duration || 0;
            seekTo(video, (Number(range.value) / 1000) * duration);
        });

        var sync = function () {
            var duration = video.duration || 0;
            if (!scrubbing && duration) {
                range.value = String(Math.round((video.currentTime / duration) * 1000));
            }
            remaining.textContent = '-' + fmt(duration - video.currentTime);
            range.style.setProperty('--nf-progress', (Number(range.value) / 10).toFixed(2) + '%');
            playBtn.replaceChildren(svgIcon(video.paused ? 'play' : 'pause'));
        };

        video.addEventListener('timeupdate', sync);
        video.addEventListener('loadedmetadata', sync);
        video.addEventListener('play', sync);
        video.addEventListener('pause', function () {
            sync();
            showPlayerChrome();
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
            if (!item) return;
            player.itemId = item.Id;
            if (item.SeriesId) player.seriesId = item.SeriesId;
            if (item.SeasonId) player.seasonId = item.SeasonId;
            centre.textContent = item.SeriesName
                ? item.SeriesName +
                  '  ' +
                  (item.ParentIndexNumber ? 'S' + item.ParentIndexNumber : '') +
                  (item.IndexNumber ? ':E' + item.IndexNumber : '') +
                  '  ' +
                  item.Name
                : item.Name;
        };

        var client = api();
        if (window.playbackManager && typeof window.playbackManager.currentItem === 'function') {
            try {
                label(window.playbackManager.currentItem());
            } catch (err) {
                log('currentItem unavailable', err);
            }
        }

        // playbackManager is not always reachable from here, and Jellyfin's own
        // title element is hidden with its OSD, so fall back to the item the
        // route is already pointing at.
        if (!centre.textContent && client) {
            var match = window.location.hash.match(/[?&]id=([^&]+)/);
            if (match) {
                client.getItem(client.getCurrentUserId(), match[1]).then(label).catch(function () {});
            }
        }
    }

    function managePlayer() {
        var video = document.querySelector('.videoPlayerContainer video, video.htmlvideoplayer');
        if (!video) {
            destroyPlayer();
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

        var current = 0;

        function render(index) {
            var item = items[index];
            current = index;

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
        }

        play.addEventListener('click', function () {
            goToDetails(items[current].Id, items[current].ServerId, true);
        });
        info.addEventListener('click', function () {
            openModal(items[current].Id);
        });

        if (heroTimer) clearInterval(heroTimer);
        if (cfg.heroAutoRotate && items.length > 1) {
            heroTimer = setInterval(function () {
                if (!document.body.contains(hero)) {
                    clearInterval(heroTimer);
                    heroTimer = null;
                    return;
                }
                render((current + 1) % items.length);
            }, Math.max(4, cfg.heroRotateSeconds) * 1000);
        }

        render(0);
        return hero;
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
        if (!container || container.querySelector('[data-nf-hero]')) return;

        var client = api();
        if (!client) return;

        client
            .getItems(client.getCurrentUserId(), {
                IncludeItemTypes: 'Movie,Series',
                Recursive: true,
                SortBy: 'Random',
                Limit: 20,
                ImageTypeLimit: 2,
                EnableImageTypes: 'Backdrop,Logo',
                Fields: 'Overview,Genres,ProductionYear,OfficialRating,ChildCount',
                EnableTotalRecordCount: false
            })
            .then(function (result) {
                var items = (result.Items || []).filter(function (item) {
                    return item.BackdropImageTags && item.BackdropImageTags.length && item.Overview;
                });
                if (!items.length) return;

                var existing = document.querySelector('.homeSectionsContainer');
                if (!existing || existing.querySelector('[data-nf-hero]')) return;
                existing.insertBefore(buildHero(items.slice(0, 5), client), existing.firstChild);
                log('billboard mounted');
            })
            .catch(function (err) {
                log('billboard failed', err);
            });
    }

    /* ------------------------------------------------------------ lifecycle */

    var scheduled = null;

    function refresh() {
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
        applyBodyFlags();
        bindScrollState();
        bindPreview();
        bindModal();
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
            if (heroTimer) {
                clearInterval(heroTimer);
                heroTimer = null;
            }
            schedule();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
