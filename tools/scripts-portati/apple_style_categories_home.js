(function () {
    "use strict";

    let currentActive = null;

    function injectCSS() {
        if (document.getElementById("categories-css")) return;

        const s = document.createElement("style");
        s.id = "categories-css";

        s.textContent = `
            #categories-wrapper,
            #categories-wrapper * {
                box-sizing: border-box !important;
            }

            #categories-wrapper{
                margin: 16px 4% !important;
                display:flex !important;
                flex-direction:column !important;
                gap:14px !important;
            }

            .categories-scroll{
                display:flex !important;
                flex-wrap:wrap !important;
                gap:8px !important;
            }

            .category-card{
                padding:6px 12px !important;
                border-radius:999px !important;
                font-size:12px !important;
                cursor:pointer !important;
                color:white !important;
                background:rgba(255,255,255,.06) !important;
                border:1px solid rgba(255,255,255,.1) !important;
                transition:.2s ease !important;
                user-select:none !important;
                white-space:nowrap !important;
            }

            .category-card:hover{
                transform:scale(1.05) !important;
            }

            .category-active{
                background:rgba(255,255,255,.18) !important;
                border-color:rgba(255,255,255,.35) !important;
            }

            /* =========================
               DESKTOP GRID
            ========================= */
            .category-results{
                display:grid !important;
                grid-template-columns:repeat(auto-fill,minmax(130px,1fr)) !important;
                gap:12px !important;

                width:100% !important;
                max-width:100% !important;

                margin-top:10px !important;
                padding:6px 0 !important;

                max-height:65vh !important;
                overflow-y:auto !important;
                overflow-x:hidden !important;
            }

            .item{
                cursor:pointer !important;
                display:flex !important;
                flex-direction:column !important;
                transition:transform .2s ease !important;
                min-width:0 !important;
            }

            .item:hover{
                transform:scale(1.02) !important;
            }

            .item img{
                width:100% !important;
                aspect-ratio:2/3 !important;
                object-fit:cover !important;
                border-radius:10px !important;
                box-shadow:0 6px 18px rgba(0,0,0,.35) !important;
            }

            /* ❌ TITOLI COMPLETAMENTE RIMOSSI */
            .item div{
                display:none !important;
            }

            /* =========================
                TABLET
            ========================= */
            @media (max-width: 1024px){
                .category-results{
                    grid-template-columns:repeat(auto-fill,minmax(115px,1fr)) !important;
                    gap:10px !important;
                }
            }

            /* =========================
                MOBILE
            ========================= */
            @media (max-width: 600px){
                .category-results{
                    grid-template-columns:repeat(3,1fr) !important;
                    gap:7px !important;
                }

                .item{
                    margin-top:4px !important;
                    margin-bottom:4px !important;
                }
            }

            /* =========================
                HIDE SCROLLBAR (FIX)
            ========================= */
            .category-results::-webkit-scrollbar{
                display:none !important;
            }

            .category-results{
                -ms-overflow-style: none !important;  /* IE / Edge */
                scrollbar-width: none !important;      /* Firefox */
            }
        `;

        document.head.appendChild(s);
    }

    function getCreds() {
        try {
            const raw = localStorage.getItem("jellyfin_credentials");
            if (!raw) return null;

            const c = JSON.parse(raw);
            const sv = c?.Servers?.[0];
            if (!sv) return null;

            return {
                token: sv.AccessToken,
                userId: sv.UserId,
                base: (sv.ManualAddress || sv.LocalAddress || location.origin).replace(/\/+$/, "")
            };
        } catch {
            return null;
        }
    }

    async function fetchGenres(creds) {
        const url =
            `${creds.base}/Users/${creds.userId}/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Genres`;

        const r = await fetch(url, {
            headers: { Authorization: `MediaBrowser Token="${creds.token}"` }
        });

        const j = await r.json();

        const genres = new Set();
        for (const it of (j.Items || [])) {
            (it.Genres || []).forEach(g => genres.add(g));
        }

        return [...genres].sort();
    }

    async function fetchByGenre(creds, genre) {
        const url =
            `${creds.base}/Users/${creds.userId}/Items?Genres=${encodeURIComponent(genre)}&IncludeItemTypes=Movie&Recursive=true&SortBy=PremiereDate&SortOrder=Descending`;

        const r = await fetch(url, {
            headers: { Authorization: `MediaBrowser Token="${creds.token}"` }
        });

        const j = await r.json();
        return j.Items || [];
    }

    function buildItems(items, base) {
        const row = document.createElement("div");
        row.className = "category-results";

        if (!items.length) {
            row.innerHTML = `<div style="color:#888">No movies found</div>`;
            return row;
        }

        for (const it of items) {
            const img = it.ImageTags?.Primary
                ? `${base}/Items/${it.Id}/Images/Primary?maxHeight=300&tag=${it.ImageTags.Primary}`
                : "";

            const el = document.createElement("div");
            el.className = "item";

            el.innerHTML = `<img src="${img}">`;

            el.onclick = () => {
                location.hash = `#/details?id=${it.Id}&serverId=${it.ServerId}`;
            };

            row.appendChild(el);
        }

        return row;
    }

    async function inject() {
        if (document.getElementById("categories-wrapper")) return;

        const creds = getCreds();
        if (!creds) return;

        injectCSS();

        const wrapper = document.createElement("div");
        wrapper.id = "categories-wrapper";

        const scroll = document.createElement("div");
        scroll.className = "categories-scroll";

        const genres = await fetchGenres(creds);

        for (const g of genres) {
            const card = document.createElement("div");
            card.className = "category-card";
            card.textContent = g;

            card.onclick = async () => {
                const old = wrapper.querySelector(".category-results");

                if (currentActive === g) {
                    old?.remove();
                    card.classList.remove("category-active");
                    currentActive = null;
                    return;
                }

                old?.remove();

                wrapper.querySelectorAll(".category-active")
                    .forEach(c => c.classList.remove("category-active"));

                card.classList.add("category-active");
                currentActive = g;

                const items = await fetchByGenre(creds, g);
                wrapper.appendChild(buildItems(items, creds.base));
            };

            scroll.appendChild(card);
        }

        wrapper.appendChild(scroll);

        const host =
            document.querySelector(".homeSectionsContainer") ||
            document.querySelector(".homeSection") ||
            document.body;

        host.prepend(wrapper);
    }

    function waitHome() {
        const ok =
            document.querySelector(".homeSectionsContainer") ||
            document.querySelector(".homeSection");

        if (ok) inject();
        else setTimeout(waitHome, 1000);
    }

    waitHome();
})();