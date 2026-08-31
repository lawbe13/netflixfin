# Gli script che stavano in JavaScript Injector

Quattro script scritti dal proprietario e iniettati nel client da un plugin a parte.
Il plugin è stato rimosso il 31/08/2026; questi sono gli originali, così com'erano.

- `providers_streaming.js` — la striscia dei marchi (Apple TV+, Prime, Netflix, HBO,
  Disney+, Pixar, Hulu) che si apre sui titoli di quello studio.
  **Portato dentro netflixfin.js** (`nfProviders`). Da fuori aveva smesso di funzionare:
  costruiva il proprio guscio e restava vuoto, perché il tema ridisegna la home sotto.
- `badge_new_kids.js` — il bollino NEW sui cartoni arrivati negli ultimi sette giorni.
  **Portato dentro netflixfin.js** (`nfFreshBadges`).
- `top10.js` — i numeri giganti sulla riga Top 10. **Non portato**: il tema li disegna
  da mesi (`decorateTop10`), e i due si contendevano gli stessi nodi.
- `apple_style_categories_home.js` — una riga di pillole per genere. **Non portato**:
  costruiva diciotto pillole con altezza zero, quindi non si vedeva nulla.
