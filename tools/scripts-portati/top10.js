(function () {

    const CLASS = 'jf-top-rank';

    // =========================
    // FONT RESPONSIVE
    // =========================
    const getFontSize = () => {
        const w = window.innerWidth;

        if (w < 500) return '44px';
        if (w < 900) return '70px';
        return '84px';
    };

    // =========================
    // STYLE GLOW
    // =========================
    const applyStyle = (el) => {

        const w = window.innerWidth;

        if (w >= 900) {
            el.style.webkitTextStroke = '3.8px rgba(255,255,255,0.9)';
            el.style.textShadow = '0 0 14px rgba(0,0,0,0.75)';
            el.style.opacity = '0.80';
        }
        else if (w >= 500) {
            el.style.webkitTextStroke = '2.8px rgba(255,255,255,0.78)';
            el.style.textShadow = '0 0 8px rgba(0,0,0,0.55)';
            el.style.opacity = '0.74';
        }
        else {
            el.style.webkitTextStroke = '2px rgba(255,255,255,0.65)';
            el.style.textShadow = '0 0 5px rgba(0,0,0,0.45)';
            el.style.opacity = '0.70';
        }
    };

    // =========================
    // FIX DEFINITIVO POSIZIONE
    // =========================
    const setPosition = (el, card) => {

        //  IMPORTANTISSIMO: blocca layout shift
        card.style.position = 'relative';
        card.style.overflow = 'hidden';

        //  ANCORAGGIO FISSO (NO OFFSET, NO DRIFT)
        el.style.position = 'absolute';
        el.style.left = '6px';
        el.style.bottom = '6px';

        el.style.top = 'auto';
        el.style.right = 'auto';

        el.style.transform = 'translateZ(0)';
        el.style.willChange = 'transform';
    };

    // =========================
    // APPLY TOP 10
    // =========================
    const apply = () => {

        const section = document.querySelector('.verticalSection.Top');
        if (!section) return;

        const cards = section.querySelectorAll('.card');
        if (!cards.length) return;

        let rank = 1;

        cards.forEach(card => {

            if (rank > 10) return;

            let el = card.querySelector('.' + CLASS);

            if (!el) {

                el = document.createElement('div');
                el.className = CLASS;

                el.style.position = 'absolute';
                el.style.zIndex = '2';
                el.style.pointerEvents = 'none';

                el.style.fontFamily = 'Arial Black, Impact, sans-serif';
                el.style.fontWeight = '900';
                el.style.letterSpacing = '-6px';
                el.style.color = 'transparent';

                el.style.transform = 'translateZ(0)';
                el.style.willChange = 'transform';

                card.appendChild(el);
            }

            el.textContent = rank;
            el.style.fontSize = getFontSize();

            applyStyle(el);
            setPosition(el, card);

            rank++;
        });
    };

    // =========================
    // LIGHT RECHECK
    // =========================
    let lastCount = 0;

    const tick = () => {
        const section = document.querySelector('.verticalSection.Top');
        const count = section ? section.querySelectorAll('.card').length : 0;

        if (count !== lastCount) {
            lastCount = count;
            apply();
        }
    };

    setInterval(tick, 1000);

    // =========================
    // EVENTS SAFE
    // =========================
    window.addEventListener('resize', apply);

    window.addEventListener('focus', () => {
        setTimeout(apply, 300);
    });

    window.addEventListener('pageshow', () => {
        setTimeout(apply, 300);
    });

    setTimeout(apply, 600);

})();