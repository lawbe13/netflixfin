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
        var tabs = document.querySelectorAll('.headerTabs .emby-tab-button');
        if (!tabs.length) return [];

        var targets = [{ label: tabs[0].textContent.trim(), tab: tabs[0], index: 0 }];

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

        for (var i = 1; i < tabs.length; i++) {
            targets.push({ label: tabs[i].textContent.trim(), tab: tabs[i], index: i });
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

                    var menu = el('div', 'nf-nav-menu');
                    siblings.forEach(function (view) {
                        var link = el('a', null, view.Name);
                        link.href =
                            (view.CollectionType === 'tvshows' ? '#/tv?topParentId=' : '#/movies?topParentId=') +
                            view.Id;
                        menu.appendChild(link);
                    });
                    wrapper.appendChild(menu);
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
                    var box = card.querySelector('.cardBox');
                    if (box) box.setAttribute('data-nf-rank', String(i + 1));
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

    function buildEpisodes(item, client, mount) {
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
                            (episodes.Items || []).forEach(function (episode, i) {
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
                loadSeason(seasons[0].Id);
            })
            .catch(function (err) {
                log('episodes failed', err);
            });
    }

    /* "Altri titoli simili" - the suggestions grid both Netflix modals carry. */
    function buildSimilar(item, client, mount) {
        client
            .getJSON(client.getUrl('Items/' + item.Id + '/Similar', {
                userId: client.getCurrentUserId(),
                limit: 9,
                fields: 'Overview,Genres,ProductionYear,OfficialRating'
            }))
            .then(function (result) {
                var items = result.Items || [];
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

    function buildModal(item, client) {
        var scrim = el('div', 'nf-modal-scrim');
        scrim.addEventListener('click', function (event) {
            if (event.target === scrim) closeModal();
        });

        var modal = el('div', 'nf-modal');

        var art = el('div', 'nf-modal-art');
        art.style.backgroundImage =
            'url("' + client.getImageUrl(item.Id, { type: 'Backdrop', maxWidth: 1280 }) + '")';

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

        var actions = el('div', 'nf-modal-actions');
        var play = el('button', 'nf-btn nf-btn-primary');
        play.type = 'button';
        play.appendChild(icon('play_arrow'));
        play.appendChild(el('span', null, 'Riproduci'));
        play.addEventListener('click', function () {
            closeModal();
            goToDetails(item.Id, item.ServerId, true);
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

        left.appendChild(el('p', 'nf-modal-overview', item.Overview || ''));
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
            buildEpisodes(item, client, episodes);
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

    function openModal(id) {
        var client = api();
        if (!client || !id) return;

        destroyPreview();
        closeModal();

        client
            .getItem(client.getCurrentUserId(), id)
            .then(function (item) {
                buildModal(item, client);
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
        buildNav();
        decorateDetail();
        mountHero();
        decorateTop10();
        decorateRows();
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
