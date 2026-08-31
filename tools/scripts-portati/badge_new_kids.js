(function () {

    const NEW_DAYS = 7;

    const TARGET_GENRES = [
        "animation",
        "animazione",
        "cartoni",
        "animated"
    ];

    // =========================
    // CHECK NEW
    // =========================
    const isNew = (item) => {
        if (!item?.DateCreated) return false;

        const diff = Date.now() - new Date(item.DateCreated).getTime();
        return diff <= NEW_DAYS * 86400000;
    };

    // =========================
    // CHECK KIDS
    // =========================
    const isKids = (item) => {
        if (!item?.Genres) return false;

        return item.Genres.some(g => {
            const name = (g.Name || g || "").toLowerCase();
            return TARGET_GENRES.some(t => name.includes(t));
        });
    };

    // =========================
    // CACHE
    // =========================
    let map = new Map();
    let ready = false;
    let lastUrl = location.href;

    async function buildCache() {

        const userId = window.ApiClient?.getCurrentUserId();
        if (!userId) return;

        try {

            const data = await window.ApiClient.getItems(userId, {
                IncludeItemTypes: "Movie,Series",
                Recursive: true,
                Fields: "Genres,Id,DateCreated"
            });

            if (!data?.Items) return;

            map = new Map();

            for (const item of data.Items) {
                map.set(item.Id, {
                    isNew: isNew(item),
                    isKids: isKids(item)
                });
            }

            ready = true;

        } catch (e) {
            console.error("Badge system error:", e);
        }
    }

    // =========================
    // GET ID
    // =========================
    const getId = (card) =>
        card.getAttribute('data-id') ||
        card.getAttribute('data-itemid');

    // =========================
    // VALID CARD
    // =========================
    const isValidCard = (card) => {

        if (card.classList.contains('personCard')) return false;
        if (card.querySelector('img.avatar')) return false;
        if (card.closest('.peopleSection')) return false;

        return true;
    };

    // =========================
    // CONTAINER STABLE
    // =========================
    function getContainer(card) {

        let c = card.querySelector('.jf-badge-container');

        if (!c) {
            c = document.createElement('div');
            c.className = 'jf-badge-container';

            c.style.cssText = `
                position:absolute;
                top:12px;
                left:8px;

                display:flex;
                flex-direction:row;
                flex-wrap:wrap;

                gap:4px;

                z-index:10;
                pointer-events:none;
                align-items:flex-start;

                max-width:140px;
            `;

            card.style.position = 'relative';
            card.appendChild(c);
        }

        return c;
    }

    // =========================
    // BADGE NEW (UPDATED STYLE)
    // =========================
    function addNew(container) {

        const el = document.createElement('div');
        el.textContent = 'New';

        el.style.cssText = `
            background:#e50914;
            color:#fff;

            font-size:10px;
            font-weight:700;

            padding:3px 10px;
            border-radius:999px;

            display:inline-flex;
            align-items:center;
            justify-content:center;

            width:fit-content;
            white-space:nowrap;

            backdrop-filter: blur(6px);
            box-shadow: 0 4px 12px rgba(0,0,0,.35);
        `;

        container.appendChild(el);
    }

    // =========================
    // BADGE KIDS (UPDATED STYLE)
    // =========================
    function addKids(container) {

        const el = document.createElement('div');
        el.textContent = 'Kids';

        el.style.cssText = `
            background:#4fc3f7;
            color:#fff;

            font-size:10px;
            font-weight:700;

            padding:3px 10px;
            border-radius:999px;

            display:inline-flex;
            align-items:center;
            justify-content:center;

            width:fit-content;
            white-space:nowrap;

            backdrop-filter: blur(6px);
            box-shadow: 0 4px 12px rgba(0,0,0,.25);
        `;

        container.appendChild(el);
    }

    // =========================
    // APPLY
    // =========================
    function apply() {

        if (!ready) return;

        const cards = document.querySelectorAll('.card');

        for (const card of cards) {

            if (!isValidCard(card)) continue;

            const id = getId(card);
            if (!id) continue;

            const data = map.get(id);
            if (!data) continue;

            const container = getContainer(card);

            while (container.firstChild) {
                container.removeChild(container.firstChild);
            }

            if (data.isNew) {
                addNew(container);
            }

            if (data.isKids) {
                addKids(container);
            }
        }
    }

    // =========================
    // URL WATCH
    // =========================
    setInterval(() => {

        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(apply, 1200);
        }

    }, 2000);

    // =========================
    // INIT
    // =========================
    async function init() {
        await buildCache();
        apply();
    }

    setTimeout(init, 1200);

})();