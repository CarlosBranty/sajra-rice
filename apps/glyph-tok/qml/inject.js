// inyectado en cada página (DocumentCreation, mundo principal). Expone window.__tok para la barra de glyph-tok:
// pausar/reanudar al ocultar y siguiente/anterior en cualquier perfil; el CSS (solo el feed en la ventana estrecha,
// colores de glyph) en tiktok.com; en dailymotion.com el video a pantalla completa y las recomendaciones en un panel
// inferior (__tok.recs). Netflix y Crunchyroll se dejan como son.
(() => {
    if (window.__tok) return;

    const style = document.createElement("style");
    style.id = "glyph-tok";
    const put = () => (document.head || document.documentElement).appendChild(style);
    if (document.documentElement) put();
    else document.addEventListener("readystatechange", put, { once: true });

    const tiktok = /(^|\.)tiktok\.com$/.test(location.hostname);
    const dm = /(^|\.)dailymotion\.com$/.test(location.hostname);
    let theme = null;
    let paused = [];

    // las clases de TikTok están ofuscadas (cambian en cada deploy): solo selectores por data-e2e, id y estructura
    // Dailymotion: class names are CSS modules (Name__part___hash), so match on the stable "Name__part" prefix.
    // On a video page the player fills the window like TikTok; the right column (info + recommendations) is hidden
    // and opens as a bottom sheet with html.tok-recs (glyph-tok bar button → __tok.recs())
    const watch = `html:has([data-testid="watching-discovery-desktop"])`;
    const dmCss = () => `
        /* Dailymotion's own left rail: the glyph-tok bar replaces it */
        [class*="Root__desktopVerticalNav"] { display: none !important; }
        [class*="Root__mainWithVerticalNav"] { margin-left: 0 !important; padding-left: 0 !important; }
        ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }

        ${watch} body { overflow: hidden !important; }
        ${watch} #player-wrapper {
            position: fixed !important; inset: 0 !important;
            width: 100vw !important; height: 100vh !important; max-width: none !important;
            transform: none !important; margin: 0 !important; z-index: 40 !important; background: #000 !important;
        }
        ${watch} #player-wrapper div, ${watch} #player-wrapper iframe {
            width: 100% !important; height: 100% !important; max-width: none !important;
            padding: 0 !important; position: static !important;
        }
        ${watch} [class*="WatchingSectionDesktop__rightColumn"]:not([class*="Scroll"]) { display: none !important; }

        /* recommendations as a bottom sheet over the video */
        ${watch}.tok-recs [class*="WatchingSectionDesktop__rightColumn"]:not([class*="Scroll"]) {
            display: block !important; position: fixed !important;
            left: 10px !important; right: 10px !important; bottom: 10px !important; top: 34vh !important;
            width: auto !important; height: auto !important; max-width: none !important; z-index: 60 !important;
            overflow-y: auto !important; padding: 14px !important; border-radius: 26px !important;
            background: var(--tok-sheet, #fff) !important;
            box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.35) !important;
            animation: tok-sheet-in 0.28s cubic-bezier(0.25, 1, 0.5, 1);
        }
        ${watch}.tok-recs [class*="WatchingSectionDesktop__rightColumnScroll"] {
            position: static !important; height: auto !important; max-height: none !important; overflow: visible !important;
            width: 100% !important; top: auto !important;
        }
        ${watch}.tok-recs [class*="WatchingSectionDesktop__rightColumn"] * { max-width: 100% !important; }
        @keyframes tok-sheet-in { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
    `;
    const css = () => dm ? dmCss() : !tiktok ? "" : `
        /* barra lateral de TikTok (búsqueda, inicio, explorar…): la sustituye la barra de glyph-tok.
           Ocupaba 72 px y empujaba el video fuera de la ventana estrecha */
        #app > div > div:has([data-e2e="nav-search"]),
        #app > div > div:has([data-e2e="nav-more-menu"]) { display: none !important; }
        /* flechas ↑↓ a la derecha del feed: quedan fuera de la ventana; el teclado y la rueda siguen */
        [data-e2e="anchoring-scroll-controls"] { display: none !important; }
        /* copia desenfocada del video detrás del reproductor: solo gasto */
        [data-e2e="anchoring-ambient"] { display: none !important; }
        ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
        ${theme ? `
        /* marco alrededor de la tarjeta del video = color de la barra de glyph-tok */
        html, body, #app, #app > div, main { background: ${theme.s1} !important; }
        ` : ""}
    `;

    // a recommendation was picked inside the sheet: close it, the new video plays full window
    document.addEventListener("click", e => {
        if (e.target.closest && e.target.closest('[class*="WatchingSectionDesktop__rightColumn"] a[href]'))
            document.documentElement.classList.remove("tok-recs");
    }, true);

    window.__tok = {
        // Dailymotion: open / close the recommendations sheet; returns whether it is open
        recs(open) {
            const h = document.documentElement;
            open = open === undefined ? !h.classList.contains("tok-recs") : !!open;
            if (open) h.style.setProperty("--tok-sheet", getComputedStyle(document.body).backgroundColor || "#fff");
            h.classList.toggle("tok-recs", open);
            return open;
        },
        theme(t) {
            theme = t;
            style.textContent = css();
        },
        // ocultar: pausar lo que suena y recordarlo; mostrar: reanudar solo eso
        pause() {
            paused = [...document.querySelectorAll("video")].filter(v => !v.paused);
            paused.forEach(v => v.pause());
        },
        resume() {
            paused.forEach(v => v.play().catch(() => {}));
            paused = [];
        },
        // siguiente / anterior (Super+↓/↑): los botones del feed (ocultos por CSS pero vivos); si no están (otra
        // página), la tecla de flecha que TikTok ya entiende
        step(d) {
            const b = document.querySelector(`[data-e2e="feed-navigation-${d > 0 ? "next" : "prev"}"]`);
            if (b && !b.disabled && !b.classList.contains("TUXButton--disabled")) return b.click();
            const key = d > 0 ? "ArrowDown" : "ArrowUp";
            for (const type of ["keydown", "keyup"])
                document.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: d > 0 ? 40 : 38, which: d > 0 ? 40 : 38, bubbles: true }));
        },
    };
    style.textContent = css();
})();
