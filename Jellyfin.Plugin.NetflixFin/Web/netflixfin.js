/* NetflixFin - behaviour layer.
 *
 * Everything here is progressive: if a selector disappears in a future
 * jellyfin-web release the CSS still applies and the page still works.
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

    var TOP10_RE = /top\s*-?\s*10/i;
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

    function ticksToMinutes(ticks) {
        if (!ticks) return null;
        return Math.round(ticks / 600000000);
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

    /* ------------------------------------------------------------ body flags */

    function applyBodyFlags() {
        document.body.classList.toggle('nf-hover-preview', !!cfg.enableHoverPreview);
        document.body.classList.toggle('nf-hide-card-text', !!cfg.hideCardText);
    }

    /* The header is transparent over the hero and solid once the page moves. */
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

    /* ------------------------------------------------------- detail page */

    /* The stylesheet needs three things it cannot ask for itself: whether this is
     * a detail route, whether the item has a logo (so the duplicate text title can
     * go), and the localised label for the play button, which Jellyfin only puts
     * in the button's title attribute. */
    function decorateDetail() {
        var onDetail = /#\/details/.test(window.location.hash);
        document.body.classList.toggle('nf-detail', onDetail);
        if (!onDetail) {
            document.body.classList.remove('nf-detail-logo');
            return;
        }

        var logo = document.querySelector('.detailLogo');
        var hasLogo = !!logo && getComputedStyle(logo).backgroundImage !== 'none';
        document.body.classList.toggle('nf-detail-logo', hasLogo);

        // The logo is lazy-loaded into a background-image, which is not a DOM
        // mutation, so the observer never sees it arrive.
        if (logo && !hasLogo) {
            setTimeout(decorateDetail, 700);
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

    /* ------------------------------------------------------------- Top 10 */

    function decorateTop10() {
        if (!cfg.enableTop10) return;
        document.querySelectorAll('.verticalSection').forEach(function (section) {
            var title = section.querySelector('.sectionTitle');
            var isTop10 = title && TOP10_RE.test(title.textContent || '');
            section.classList.toggle('nf-top10', !!isTop10);
            if (!isTop10) return;

            var cards = section.querySelectorAll('.itemsContainer > .card');
            Array.prototype.forEach.call(cards, function (card, i) {
                if (i >= 10) {
                    card.style.display = 'none';
                    return;
                }
                var box = card.querySelector('.cardBox');
                if (box) box.setAttribute('data-nf-rank', String(i + 1));
            });
        });
    }

    /* ------------------------------------------------- 16:9 row thumbnails */

    var PORTRAIT_CARD = /(\b|-)(overflowPortrait|portrait|overflowSquare|square)Card\b/;

    /* Widening is decided per row, not per card. Mixing 16:9 and 2:3 tiles in one
     * row makes it twice as tall as it needs to be and leaves a band of empty
     * space, so a row is only converted when every item in it has a backdrop.
     * One request per row answers that. */
    function widenCards(root) {
        if (!cfg.useWideThumbnails) return;

        var client = api();
        if (!client) return;

        (root || document)
            .querySelectorAll('.homeSectionsContainer .itemsContainer.scrollSlider')
            .forEach(function (row) {
                if (row.dataset.nfWide) return;

                // The row element exists before its cards are rendered into it.
                // Marking it now would settle the decision against an empty row and
                // it would never be revisited.
                var all = row.querySelectorAll('.card[data-id]');
                if (!all.length) return;

                var cards = Array.prototype.filter.call(all, function (card) {
                    return PORTRAIT_CARD.test(card.className);
                });

                if (!cards.length) {
                    row.dataset.nfWide = 'skip';
                    return;
                }

                row.dataset.nfWide = 'pending';
                var ids = cards.map(function (card) {
                    return card.dataset.id;
                });

                client
                    .getItems(client.getCurrentUserId(), {
                        Ids: ids.join(','),
                        Fields: 'BackdropImageTags',
                        EnableImageTypes: 'Backdrop',
                        EnableTotalRecordCount: false
                    })
                    .then(function (result) {
                        var tags = {};
                        (result.Items || []).forEach(function (item) {
                            if (item.BackdropImageTags && item.BackdropImageTags.length) {
                                tags[item.Id] = item.BackdropImageTags[0];
                            }
                        });

                        var complete = ids.every(function (id) {
                            return tags[id];
                        });

                        if (!complete) {
                            row.dataset.nfWide = 'partial';
                            return;
                        }

                        cards.forEach(function (card) {
                            var container = card.querySelector('.cardImageContainer');
                            if (!container) return;

                            var url = client.getImageUrl(card.dataset.id, {
                                type: 'Backdrop',
                                maxWidth: 640,
                                tag: tags[card.dataset.id]
                            });

                            // Jellyfin clears its blurhash placeholder when its own
                            // image loads. Ours is a different URL, so that never
                            // happens and the blur stays on top of the artwork.
                            var preload = new Image();
                            preload.onload = function () {
                                container.classList.remove('blurhashed');
                            };
                            preload.src = url;

                            container.dataset.nfWideUrl = url;
                            container.style.backgroundImage = 'url("' + url + '")';
                            card.classList.add('nf-wide');
                        });

                        row.dataset.nfWide = 'yes';
                        log('widened row of', cards.length);
                    })
                    .catch(function (err) {
                        row.dataset.nfWide = 'error';
                        log('widen failed', err);
                    });
            });
    }

    /* Jellyfin lazy-loads a row's posters when it scrolls into view, which writes
     * the Primary URL straight back over ours and restores the blurhash. Rather
     * than fight for the write, the swap is simply re-applied whenever it is found
     * undone. */
    function reapplyWide() {
        document.querySelectorAll('.card.nf-wide .cardImageContainer').forEach(function (container) {
            var url = container.dataset.nfWideUrl;
            if (!url) return;

            if ((container.style.backgroundImage || '').indexOf(url) === -1) {
                container.style.backgroundImage = 'url("' + url + '")';
            }

            container.classList.remove('blurhashed');
        });
    }

    /* ------------------------------------------------------------ hero banner */

    function heroButton(label, icon, cls) {
        var button = el('button', 'nf-btn ' + cls);
        if (icon) {
            var glyph = el('span', 'material-icons', icon);
            glyph.setAttribute('aria-hidden', 'true');
            button.appendChild(glyph);
        }
        button.appendChild(el('span', null, label));
        return button;
    }

    function goToDetails(item, autoplay) {
        var url = '#/details?id=' + item.Id + '&serverId=' + item.ServerId;
        window.location.hash = url.slice(1);
        if (!autoplay) return;
        // The details view builds asynchronously; press its own play button once it exists.
        waitFor('.mainDetailButtons .btnResume, .mainDetailButtons .btnPlay', 6000, function (btn) {
            if (btn) btn.click();
        });
    }

    function buildHero(items) {
        var hero = el('div', 'nf-hero');
        hero.setAttribute('data-nf-hero', '1');

        var layers = items.map(function (item, i) {
            var layer = el('div', 'nf-hero-media' + (i === 0 ? ' is-active' : ''));
            layer.style.backgroundImage =
                'url("' +
                window.ApiClient.getImageUrl(item.Id, {
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
        var play = heroButton('Play', 'play_arrow', 'nf-btn-primary');
        var info = heroButton('More info', 'info', 'nf-btn-secondary');
        buttons.appendChild(play);
        buttons.appendChild(info);
        content.appendChild(logo);
        content.appendChild(title);
        content.appendChild(meta);
        content.appendChild(overview);
        content.appendChild(buttons);
        hero.appendChild(content);

        var dots = el('div', 'nf-hero-dots');
        hero.appendChild(dots);

        var current = 0;

        function render(index) {
            var item = items[index];
            current = index;

            layers.forEach(function (layer, i) {
                layer.classList.toggle('is-active', i === index);
            });

            var hasLogo = item.ImageTags && item.ImageTags.Logo;
            if (hasLogo) {
                logo.src = window.ApiClient.getImageUrl(item.Id, { type: 'Logo', maxWidth: 640 });
                logo.style.display = '';
                title.style.display = 'none';
                logo.alt = item.Name;
            } else {
                logo.style.display = 'none';
                title.style.display = '';
                title.textContent = item.Name;
            }

            meta.textContent = '';
            var bits = [];
            if (item.ProductionYear) bits.push(String(item.ProductionYear));
            if (item.OfficialRating) bits.push(item.OfficialRating);
            if (item.Type === 'Series' && item.ChildCount) {
                bits.push(item.ChildCount + (item.ChildCount === 1 ? ' season' : ' seasons'));
            } else if (item.RunTimeTicks) {
                var mins = ticksToMinutes(item.RunTimeTicks);
                bits.push(Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm');
            }
            if (item.Genres && item.Genres.length) bits.push(item.Genres.slice(0, 2).join(', '));
            bits.forEach(function (bit, i) {
                if (i) meta.appendChild(el('span', 'nf-dot', '●'));
                meta.appendChild(el('span', null, bit));
            });

            overview.textContent = item.Overview || '';

            Array.prototype.forEach.call(dots.children, function (dot, i) {
                dot.classList.toggle('is-active', i === index);
            });
        }

        items.forEach(function (item, i) {
            var dot = el('button');
            dot.type = 'button';
            dot.setAttribute('aria-label', item.Name);
            dot.addEventListener('click', function () {
                render(i);
                restart();
            });
            dots.appendChild(dot);
        });

        play.addEventListener('click', function () {
            goToDetails(items[current], true);
        });
        info.addEventListener('click', function () {
            goToDetails(items[current], false);
        });

        function restart() {
            if (heroTimer) clearInterval(heroTimer);
            if (!cfg.heroAutoRotate || items.length < 2) return;
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
        restart();
        return hero;
    }

    /* Media Bar Enhanced and friends already put a hero on the home screen. Two of
     * them stacked is worse than either alone, so theirs wins - it is the one the
     * user configured. */
    var RIVAL_HERO = '#slides-container, #slideshow, .mediaBar, .jellyfin-enhanced-hero';

    function hasRivalHero() {
        return !!document.querySelector(RIVAL_HERO);
    }

    function mountHero() {
        if (!cfg.enableHeroBanner) return;
        if (hasRivalHero()) {
            document.querySelectorAll('.nf-hero').forEach(function (node) {
                node.remove();
            });
            return;
        }
        if (!/#\/home/.test(window.location.hash) && window.location.hash !== '' && window.location.hash !== '#/') {
            return;
        }

        var container = document.querySelector('.homeSectionsContainer');
        if (!container || container.querySelector('[data-nf-hero]')) return;

        var client = api();
        if (!client) return;

        container.dataset.nfHeroPending = '1';
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
                items = items.slice(0, 5);

                var existing = document.querySelector('.homeSectionsContainer');
                if (!existing || existing.querySelector('[data-nf-hero]')) return;
                existing.insertBefore(buildHero(items), existing.firstChild);
                log('hero mounted with', items.length, 'items');
            })
            .catch(function (err) {
                log('hero failed', err);
            });
    }

    /* ------------------------------------------------------------ lifecycle */

    var scheduled = null;

    function refresh() {
        applyBodyFlags();
        applyLogo();
        decorateDetail();
        mountHero();
        decorateTop10();
        widenCards();
        reapplyWide();
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
        refresh();

        // Attributes are watched too: the lazy loader overwrites card backgrounds
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
