import QtQuick
import QtQuick.Window
import QtWebEngine

// glyph-tok: TikTok (o Netflix / Crunchyroll / Dailymotion, menú de perfiles) en proporción de celular (9:19.5), flotando a la derecha y fijado en todos los escritorios
// (reglas en ~/.config/hypr/user.lua por class glyph-tok). Dos modos: fijo (franja reservada por glyph) y flotante.
// Ocultar (botón, Super+Alt+T o Esc) pausa el video y congela la página — no gasta CPU mientras no se ve.
Window {
    id: win

    width: 420
    height: 910
    minimumWidth: 320
    minimumHeight: 360 // Netflix flotante es apaisado (16:9 + barra)
    visible: !startHidden
    title: cur.name
    flags: Qt.Window | Qt.FramelessWindowHint
    color: Theme.s1

    Binding { target: Theme; property: "pal"; value: host.palette }

    // --- perfiles: qué sitio abre la ventana (menú de la barra, o `glyph-tok tiktok|netflix|crunchyroll|dailymotion`). Cada uno con su inicio,
    // sus atajos en la barra, su modo y su ancho en fijo (se recuerdan por perfil). Sesión/cookies compartidas: un login
    // por sitio. Netflix necesita Widevine (DRM): main.cpp toma el CDM que bajó Zen/Firefox
    readonly property var apps: ({
        tiktok: {
            name: "TikTok", icon: "\u{F0387}", site: "https://www.tiktok.com", home: "/foryou",
            mode: "dock", modes: ["dock", "float"], ratio: 0.52,
            nav: [
                { icon: "\u{F02DC}", path: "/foryou", on: p => p === "/foryou" || p === "/" },
                { icon: "\u{F000E}", path: "/following", on: p => p.startsWith("/following") },
                { icon: "\u{F018B}", path: "/explore", on: p => p.startsWith("/explore") },
                { icon: "\u{F0004}", path: "/profile", profile: true,
                  on: p => p.startsWith("/profile") || p.startsWith("/@") || p.startsWith("/login") }
            ]
        },
        netflix: {
            name: "Netflix", icon: "\u{F0746}", site: "https://www.netflix.com", home: "/browse",
            mode: "corner", modes: ["corner", "float", "dock"], ratio: 0.62,
            nav: [
                { icon: "\u{F02DC}", path: "/browse", on: p => p === "/browse" || p === "/" },
                { icon: "\u{F0502}", path: "/browse/genre/83", on: p => p === "/browse/genre/83" },
                { icon: "\u{F0381}", path: "/browse/genre/34399", on: p => p === "/browse/genre/34399" },
                { icon: "\u{F0238}", path: "/latest", on: p => p.startsWith("/latest") },
                { icon: "\u{F00C0}", path: "/browse/my-list", on: p => p.startsWith("/browse/my-list") }
            ]
        },
        // Crunchyroll mete el idioma delante (/es/videos/new): cr() lo quita para comparar
        crunchyroll: {
            name: "Crunchyroll", icon: "\u{EEE6}", site: "https://www.crunchyroll.com", home: "/",
            mode: "corner", modes: ["corner", "float", "dock"], ratio: 0.62,
            nav: [
                { icon: "\u{F02DC}", path: "/", on: p => cr(p) === "/" || cr(p) === "" },
                { icon: "\u{F0394}", path: "/videos/new", on: p => cr(p).startsWith("/videos/new") },
                { icon: "\u{F0535}", path: "/videos/popular", on: p => cr(p).startsWith("/videos/popular") },
                { icon: "\u{F09D3}", path: "/simulcasts", on: p => cr(p).startsWith("/simulcast") },
                { icon: "\u{F00C0}", path: "/watchlist", on: p => cr(p).startsWith("/watchlist") || cr(p).startsWith("/crunchylists") },
                { icon: "\u{F02DA}", path: "/history", on: p => cr(p).startsWith("/history") }
            ]
        },
        // Dailymotion: landscape videos like Netflix (corner by default). "/" redirects to the country (/pe), cr() strips it.
        // Following is a tab on that page (#following); the redirect drops the hash, so it goes to /<country>#following.
        // #for-you is the default view and the page strips it, so it isn't a button. Search is /search/<query>
        dailymotion: {
            name: "Dailymotion", icon: "\u{F0B0B}", site: "https://www.dailymotion.com", home: "/",
            mode: "corner", modes: ["corner", "float", "dock"], ratio: 0.62,
            search: q => "/search/" + encodeURIComponent(q),
            nav: [
                { icon: "\u{F02DC}", path: "/", on: (p, h) => (cr(p) === "" || cr(p) === "/") && h !== "#following" },
                { icon: "\u{F000E}", path: () => (loc || "/") + "#following", on: (p, h) => (cr(p) === "" || cr(p) === "/") && h === "#following" }
            ]
        }
    })
    function cr(p) { return p.replace(/^\/[a-z]{2}(-[a-z]{2,3})?(?=\/|$)/, ""); }
    readonly property string app: apps[host.state.app] ? host.state.app : "tiktok"
    readonly property var cur: apps[app]
    function setApp(a) {
        if (!apps[a]) return;
        menu = false;
        searching = false;
        wantProfile = false;
        if (a !== app) {
            const st = Object.assign({}, host.state);
            st.modes = Object.assign({}, st.modes, { [app]: mode });
            st.app = a;
            st.mode = st.modes[a] ?? apps[a].mode;
            if (apps[a].modes.indexOf(st.mode) < 0) st.mode = apps[a].mode;
            if ((st.mode === "dock" || st.mode === "corner") && !pinned) togglePin();
            host.state = st;
            tries = 0;
            placeT.restart();
        }
        web.url = apps[a].site + apps[a].home;
    }
    property bool menu: false

    property bool pinned: true
    property bool muted: false

    // --- modos. fijo ("dock"): franja a la derecha que glyph reserva (tok/TokDock.qml lee state.json), las ventanas
    // en mosaico no la tapan y sigue en todos los escritorios. flotante ("float"): encima de todo, abajo a la derecha
    readonly property string mode: cur.modes.indexOf(host.state.mode) >= 0 ? host.state.mode : cur.mode
    // el ancho en fijo se guarda como proporción ancho/alto (no en px): la franja ocupa todo el alto del monitor, y con
    // px fijos se veía ancha en el de 1080 y flaca en el de la laptop (1440 lógicos). dockWidth = px para el monitor
    // actual, lo lee glyph para reservar la franja. Proporción por perfil (dockRatio = TikTok, dockRatio_<perfil> el resto)
    readonly property int dockWidth: host.state.dockWidth ?? 520
    readonly property string ratioKey: app === "tiktok" ? "dockRatio" : "dockRatio_" + app
    readonly property real dockRatio: host.state[ratioKey] ?? cur.ratio
    function setState(k, v) { const st = Object.assign({}, host.state); st[k] = v; host.state = st; }
    // botón / `glyph-tok mode`: el siguiente modo del perfil (TikTok fijo ⇄ flotante; Netflix esquina → flotante → fijo)
    function nextMode() { const l = cur.modes; return l[(l.indexOf(mode) + 1) % l.length]; }
    readonly property var modeIcon: ({ dock: "\u{F10AB}", float: "\u{F10AC}", corner: "\u{F0E59}" })
    function setMode(m) {
        if (cur.modes.indexOf(m) < 0) return;
        if ((m === "dock" || m === "corner") && !pinned) togglePin(); // fijo / esquina = en todos los escritorios
        const st = Object.assign({}, host.state);
        st.mode = m;
        st.modes = Object.assign({}, st.modes, { [app]: m });
        host.state = st;
        tries = 0;
        placeT.restart();
    }

    // colocar la ventana según el modo. En fijo espera a que glyph reserve la franja (llega por state.json, async)
    function hj(args) { try { return JSON.parse(host.exec(["hyprctl"].concat(args, ["-j"]))); } catch (e) { return null; } }
    property int tries: 0
    property double placedAt: 0
    Timer { id: placeT; interval: 120; onTriggered: win.place() }
    function place() {
        const retry = () => { if (tries++ < 20) placeT.restart(); };
        const me = (hj(["clients"]) ?? []).find(c => c.class === "glyph-tok" && c.mapped);
        if (!me) return retry();
        const m = (hj(["monitors"]) ?? []).find(x => x.id === me.monitor);
        if (!m) return retry();
        const g = parseInt((host.exec(["hyprctl", "getoption", "general:gaps_out"]).match(/(\d+)/) ?? [0, "10"])[1]);
        const mw = m.width / m.scale, mh = m.height / m.scale, r = m.reserved;
        let x, y, w, h;
        if (mode === "corner") {
            // esquina: arriba a la derecha, pegada al área de las ventanas (sin el bar, con el hueco exterior), 16:9 + barra.
            // El layout lua:glyph-corner de hypr (user.lua) acomoda las ventanas en mosaico alrededor, en L
            w = Math.max(640, Math.min(1280, Math.round(mw * 0.4)));
            h = Math.round(w * 9 / 16) + bar.height;
            x = m.x + mw - r[2] - g - w;
            y = m.y + r[1] + g;
        } else if (mode === "dock") {
            h = mh - r[1] - r[3] - 2 * g;
            w = Math.max(320, Math.min(900, Math.round(dockRatio * h)));
            if (w !== dockWidth) { setState("dockWidth", w); return retry(); } // otro monitor: que glyph ajuste la franja
            if (r[2] < dockWidth) return retry(); // glyph todavía no reservó
            x = m.x + mw - g - w;
            y = m.y + r[1] + g;
        } else if (app === "tiktok") {
            w = 420;
            h = Math.min(910, mh - r[1] - r[3] - 2 * g);
            x = m.x + mw - w - 16;
            y = m.y + mh - h - 16;
        } else {
            // apaisado (series, películas): 16:9 + la barra, ~40 % del ancho del monitor
            w = Math.max(640, Math.min(1280, Math.round(mw * 0.4)));
            h = Math.round(w * 9 / 16) + bar.height;
            x = m.x + mw - w - 16;
            y = m.y + mh - h - 16;
        }
        tries = 0;
        placedAt = Date.now();
        if (me.size[0] === Math.round(w) && me.size[1] === Math.round(h) && me.at[0] === Math.round(x) && me.at[1] === Math.round(y))
            return syncLayout();
        // en una sola llamada y en orden: hypr redimensiona desde el centro, así que primero tamaño y después posición.
        // Al final el layout: en la misma llamada, ya con la ventana en su sitio
        const sel = `window = "class:^(glyph-tok)$"`;
        host.run(["hyprctl", "eval",
            `hl.dispatch(hl.dsp.window.resize({ x = ${Math.round(w)}, y = ${Math.round(h)}, ${sel} })); ` +
            `hl.dispatch(hl.dsp.window.move({ x = ${Math.round(x)}, y = ${Math.round(y)}, relative = false, ${sel} }))` +
            layoutLua()]);
    }

    // --- layout de hypr en esquina: "lua:glyph-corner" (user.lua) mientras la ventana está en la esquina y se ve; si no,
    // el que había (dwindle). Volver a ponerlo aunque ya esté hace que hypr recalcule el mosaico con la ventana donde está
    readonly property bool cornered: visible && mode === "corner" && !full
    property string baseLayout: ""
    property bool layoutSet: false
    function layoutLua() {
        if (!baseLayout) {
            const v = (host.exec(["hyprctl", "getoption", "general:layout"]).match(/str:\s*(\S+)/) ?? [0, "dwindle"])[1];
            baseLayout = v.startsWith("lua:glyph") ? "dwindle" : v;
        }
        if (!cornered && !layoutSet) return "";
        layoutSet = cornered;
        return `; hl.config({ general = { layout = "${cornered ? "lua:glyph-corner" : baseLayout}" } })`;
    }
    function syncLayout() {
        const l = layoutLua();
        if (l) host.exec(["hyprctl", "eval", l.slice(2)]);
    }
    onCorneredChanged: if (!cornered) syncLayout() // al entrar, place() lo pone una vez colocada la ventana
    Component.onCompleted: {
        if (apps[startApp] && startApp !== app) setApp(startApp);
        else web.url = cur.site + cur.home;
        placeT.start();
    }
    // pasó a otro monitor (conectar/desconectar uno, moverla): recalcular el ancho con su alto
    onScreenChanged: { tries = 0; placeT.restart(); }
    // en fijo, estirar el borde izquierdo cambia el ancho de la franja (se guarda; glyph la ajusta y recolocamos).
    // Los cambios justo después de colocar son nuestros, no del usuario; en pantalla completa tampoco
    onWidthChanged: if (mode === "dock" && visible && !full && Date.now() - placedAt > 800 && Math.abs(width - dockWidth) > 4) widthT.restart()
    Timer {
        id: widthT
        interval: 400
        onTriggered: {
            const w = Math.max(320, Math.min(900, Math.round(win.width)));
            const st = Object.assign({}, host.state, { dockWidth: w, [win.ratioKey]: Math.round(w / win.height * 1000) / 1000 });
            host.state = st;
            win.tries = 0;
            placeT.restart();
        }
    }

    // --- mostrar / ocultar
    function hide() {
        if (full) web.triggerWebAction(WebEngineView.ExitFullScreen);
        web.runJavaScript("window.__tok && __tok.pause()");
        // players inside cross-origin iframes (Dailymotion, Crunchyroll) aren't reached by __tok.pause(): mute while hidden
        web.audioMuted = true;
        visible = false;
    }
    function show() {
        visible = true;
        raise();
        requestActivate();
        web.audioMuted = muted;
        web.runJavaScript("window.__tok && __tok.resume()");
    }
    Connections {
        target: host
        function onCommand(cmd) {
            if (cmd === "show") win.show();
            else if (cmd === "hide") win.hide();
            else if (cmd === "quit") { win.visible = false; win.syncLayout(); Qt.quit(); }
            else if (cmd === "mode") win.setMode(win.nextMode());
            else if (cmd === "next" || cmd === "prev") web.runJavaScript(`window.__tok && __tok.step(${cmd === "next" ? 1 : -1})`);
            else if (cmd === "dock" || cmd === "float" || cmd === "corner") win.setMode(cmd);
            else if (cmd === "place") { if (win.visible) { win.tries = 0; placeT.restart(); } } // glyph: cambió el bar
            else if (win.apps[cmd]) { win.setApp(cmd); win.show(); } // glyph-tok tiktok | netflix | crunchyroll | dailymotion
            else win.visible ? win.hide() : win.show();
        }
    }
    // oculta: congelar la página (sin JS ni video); Frozen solo se permite con la vista invisible
    onVisibleChanged: {
        web.lifecycleState = visible ? WebEngineView.LifecycleState.Active : WebEngineView.LifecycleState.Frozen;
        if (visible) { tries = 0; placeT.restart(); } // al volver a mostrarse hypr aplica las reglas de nuevo
    }

    function hypr(lua) { host.run(["hyprctl", "dispatch", lua]); }
    function togglePin() {
        pinned = !pinned;
        hypr(`hl.dsp.window.pin({ action = "${pinned ? "on" : "off"}", window = "class:^(glyph-tok)$" })`);
    }
    function go(path) { web.url = cur.site + (typeof path === "function" ? path() : path); }

    // pantalla completa (botón del reproductor): la de hypr, no solo ocultar la barra. Fijada (pin) hypr no la deja:
    // se suelta mientras dura y se vuelve a fijar al salir
    property bool full: false
    property bool pinBeforeFull: false
    function fullscreen(on) {
        if (on === full) return;
        full = on;
        // el dispatcher alterna: solo si hypr no está ya en el estado pedido
        const me = (hj(["clients"]) ?? []).find(c => c.class === "glyph-tok" && c.mapped);
        const toggle = () => host.exec(["hyprctl", "eval",
            `hl.dispatch(hl.dsp.window.fullscreen({ mode = "fullscreen", window = "class:^(glyph-tok)$" }))`]);
        if (on) {
            pinBeforeFull = pinned;
            if (pinned) { pinned = false; host.exec(["hyprctl", "dispatch", `hl.dsp.window.pin({ action = "off", window = "class:^(glyph-tok)$" })`]); }
            if (me && !me.fullscreen) toggle();
        } else {
            // el encogido al salir es de hypr, no un ancho elegido: que onWidthChanged no lo guarde
            placedAt = Date.now() + 1500;
            if (me && me.fullscreen) toggle();
            if (pinBeforeFull && !pinned) togglePin();
            tries = 0;
            placeT.restart();
        }
    }
    // perfil sin sesión: TikTok redirige /profile al feed y su botón "Log in" vivía en la barra lateral que ocultamos.
    // Si el perfil acaba en el feed, ir a /login (correo, teléfono, QR…)
    property bool wantProfile: false
    // last locale prefix seen (/pe on Dailymotion, /es on Crunchyroll): kept while browsing pages that don't carry it
    property string loc: ""
    // Dailymotion recommendations sheet (inject.js). A new page closes it
    property bool recs: false
    function setRecs(open) { recs = open; web.runJavaScript(`window.__tok && __tok.recs(${open})`); }
    onPathChanged: {
        recs = false;
        const lm = path.match(/^\/[a-z]{2}(-[a-z]{2,3})?(?=\/|$)/);
        if (lm) loc = lm[0];
        if (!wantProfile) return;
        if (path.startsWith("/foryou") || path === "/") { wantProfile = false; go("/login"); }
        else if (path.startsWith("/@")) wantProfile = false;
    }
    readonly property string path: {
        const m = String(web.url).match(/^https?:\/\/[^/]+(\/[^?#]*)/);
        return m ? m[1] : "";
    }
    // "#following": Dailymotion's sections are tabs on one page, told apart only by the hash
    readonly property string hash: { const i = String(web.url).indexOf("#"); return i < 0 ? "" : String(web.url).slice(i); }

    property bool searching: false
    function search(q) {
        searching = false;
        if (q.trim()) go(cur.search ? cur.search(q.trim()) : "/search?q=" + encodeURIComponent(q.trim()));
    }
    // Esc: primero lo que esté abierto encima (menú, búsqueda); la pantalla completa la cierra la página misma
    Shortcut { sequence: "Escape"; enabled: !win.full; onActivated: win.menu ? win.menu = false : win.searching ? win.searching = false : win.recs ? win.setRecs(false) : win.hide() }
    Shortcut { sequence: "Ctrl+F"; onActivated: win.searching = true }
    Shortcut { sequence: "Ctrl+R"; onActivated: web.reload() }

    // --- barra glyph: navegación a la izquierda, ventana a la derecha. Arrastrar la barra mueve la ventana
    Rectangle {
        id: bar
        width: parent.width
        height: 44
        color: Theme.s1
        z: 2

        MouseArea {
            anchors.fill: parent
            onPressed: win.startSystemMove()
            onDoubleClicked: win.go(win.cur.home)
        }

        Row {
            id: nav
            x: 10
            anchors.verticalCenter: parent.verticalCenter
            spacing: 2
            visible: !win.searching
            Btn { icon: "\u{F004D}"; onClicked: web.goBack(); opacity: web.canGoBack ? 1 : 0.35 }
            Btn { icon: "\u{F0349}"; on: win.path.startsWith("/search"); onClicked: win.searching = true }
            // atajos del perfil (TikTok: para ti · siguiendo · explorar · perfil; Netflix: inicio · series · películas · novedades · mi lista)
            Repeater {
                model: win.cur.nav
                Btn {
                    required property var modelData
                    icon: modelData.icon
                    on: modelData.on(win.path, win.hash)
                    onClicked: { win.wantProfile = !!modelData.profile; win.go(modelData.path); }
                }
            }
        }

        // búsqueda (lupa o Ctrl+F): pastilla s2 como el buscador del lanzador de glyph
        Rectangle {
            visible: win.searching
            anchors { left: parent.left; leftMargin: 10; right: tools.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
            height: 36
            radius: Theme.corner(18)
            color: Theme.s2
            onVisibleChanged: if (visible) { field.text = ""; field.forceActiveFocus(); }
            Text {
                id: lens
                x: 12
                anchors.verticalCenter: parent.verticalCenter
                text: "\u{F0349}"
                font { family: Theme.nf; pixelSize: 20 }
                color: Theme.grey
                layer.enabled: true
                layer.effect: Dm {}
            }
            TextInput {
                id: field
                anchors { left: lens.right; leftMargin: 10; right: parent.right; rightMargin: 12; verticalCenter: parent.verticalCenter }
                font { family: Theme.ui; pixelSize: 15 }
                color: Theme.fg
                selectionColor: Theme.s3
                clip: true
                onAccepted: win.search(text)
                cursorDelegate: Rectangle {
                    width: 2
                    color: Theme.accent
                    Timer { running: field.activeFocus; interval: 500; repeat: true; onTriggered: parent.opacity = 1 - parent.opacity }
                }
                Text { visible: !field.text; text: "Search " + win.cur.name; font: field.font; color: Theme.mute }
            }
        }

        // centro: carga — tres puntos como el resto de glyph
        Row {
            anchors { left: nav.right; right: tools.left; verticalCenter: parent.verticalCenter }
            visible: web.loading && !win.searching
            spacing: 5
            leftPadding: (width - 3 * 5 - 2 * 5) / 2
            Repeater {
                model: 3
                Rectangle {
                    required property int index
                    width: 5
                    height: 5
                    radius: 2.5
                    color: Theme.fg
                    opacity: 0.25
                    SequentialAnimation on opacity {
                        running: web.loading
                        loops: Animation.Infinite
                        PauseAnimation { duration: index * 150 }
                        NumberAnimation { to: 1; duration: 300 }
                        NumberAnimation { to: 0.25; duration: 300 }
                        PauseAnimation { duration: (2 - index) * 150 }
                    }
                }
            }
        }

        Row {
            id: tools
            anchors { right: parent.right; rightMargin: 10; verticalCenter: parent.verticalCenter }
            spacing: 2
            // perfil: el icono del sitio actual; abre el menú para cambiar
            // Dailymotion video page: recommendations as a sheet over the full-window video (inject.js __tok.recs)
            Btn { visible: win.app === "dailymotion" && win.path.startsWith("/video/"); icon: "\u{F0570}"; on: win.recs; onClicked: win.setRecs(!win.recs) }
            Btn { id: appBtn; icon: win.cur.icon; on: win.menu; onClicked: win.menu = !win.menu }
            Btn { icon: win.muted ? "\u{F075F}" : "\u{F057E}"; on: win.muted; onClicked: { win.muted = !win.muted; web.audioMuted = win.muted; } }
            // fijo ⇄ flotante
            // icono = el modo al que pasa
            Btn { icon: win.modeIcon[win.nextMode()]; onClicked: win.setMode(win.nextMode()) }
            Btn { visible: win.mode === "float"; icon: win.pinned ? "\u{F0403}" : "\u{F0404}"; on: win.pinned; onClicked: win.togglePin() }
            Btn { icon: "\u{F0374}"; onClicked: win.hide() } // ocultar (sigue vivo, sesión y posición)
        }
    }

    // --- menú de perfiles, bajo su botón. Clic fuera lo cierra
    MouseArea {
        anchors.fill: parent
        z: 3
        visible: win.menu
        onClicked: win.menu = false
    }
    Rectangle {
        id: menuBox
        z: 4
        visible: win.menu
        // bajo el botón de perfil, alineado a su borde derecho (tools y appBtn: x reactivas, mapToItem no)
        x: Math.max(8, Math.min(win.width - width - 8, tools.x + appBtn.x + appBtn.width - width))
        y: bar.height + 6
        width: 168
        height: col.height + 12
        radius: Theme.corner(18)
        color: Theme.s1
        border { width: 1; color: Theme.s3 }
        Column {
            id: col
            x: 6
            y: 6
            width: parent.width - 12
            spacing: 2
            Repeater {
                model: Object.keys(win.apps)
                Rectangle {
                    id: row
                    required property string modelData
                    readonly property bool cur: modelData === win.app
                    width: col.width
                    height: 40
                    radius: Theme.corner(14)
                    color: cur ? Theme.fg : rma.containsMouse ? Theme.s2 : "transparent"
                    Btn {
                        x: 4
                        anchors.verticalCenter: parent.verticalCenter
                        icon: win.apps[row.modelData].icon
                        on: row.cur
                        enabled: false
                    }
                    Text {
                        x: 44
                        anchors.verticalCenter: parent.verticalCenter
                        text: win.apps[row.modelData].name
                        font { family: Theme.ui; pixelSize: 15; weight: Font.Medium }
                        color: row.cur ? Theme.ink : Theme.fg
                    }
                    MouseArea {
                        id: rma
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: win.setApp(row.modelData)
                    }
                }
            }
        }
    }

    WebEngineProfile {
        id: prof
        storageName: "glyph-tok"
        offTheRecord: false
        persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
        httpCacheType: WebEngineProfile.DiskHttpCache
        // ad blocker (main.cpp / adblock.cpp, Brave's engine): every request of this profile goes through it. The
        // profiles' sites (and Dailymotion's player frame) get their cosmetic rules before their first page loads
        Component.onCompleted: {
            adblock.attach(prof);
            adblock.prime(Object.keys(win.apps).map(a => win.apps[a].site + win.apps[a].home)
                .concat(["https://geo.dailymotion.com/", "https://www.youtube.com/"]));
        }
    }

    WebEngineView {
        id: web
        anchors { top: bar.bottom; left: parent.left; right: parent.right; bottom: parent.bottom }
        profile: prof
        backgroundColor: Theme.s1
        settings.playbackRequiresUserGesture: false
        settings.showScrollBars: false
        settings.focusOnNavigationEnabled: true

        // inject.js (glyph-tok's own page tweaks) + the ad blocker's hide rules and scriptlets, in every frame and in
        // the page's own world (scriptlets patch the page's JS), before any of the page's scripts run
        userScripts.collection: [{
            name: "tok",
            sourceUrl: Qt.resolvedUrl("inject.js"),
            injectionPoint: WebEngineScript.DocumentCreation,
            worldId: WebEngineScript.MainWorld,
            runsOnSubFrames: false
        }].concat(adblock.script ? [{
            name: "adblock",
            sourceCode: adblock.script,
            injectionPoint: WebEngineScript.DocumentCreation,
            worldId: WebEngineScript.MainWorld,
            runsOnSubFrames: true
        }] : [])

        Component.onCompleted: {
            // sin "QtWebEngine/x.y" en el user agent: TikTok lo trata como Chrome normal
            profile.httpUserAgent = profile.httpUserAgent.replace(/\s*QtWebEngine\/\S+/, "");
        }

        // colores de glyph dentro de la página (inject.js los usa en su CSS)
        function paint() {
            runJavaScript(`window.__tok && __tok.theme(${JSON.stringify({
                light: Theme.light, bg: String(Theme.bg), s1: String(Theme.s1), s2: String(Theme.s2), s3: String(Theme.s3),
                grey: String(Theme.grey), fg: String(Theme.fg), ink: String(Theme.ink), accent: String(Theme.accent)
            })})`);
        }
        onLoadingChanged: r => { if (r.status === WebEngineView.LoadSucceededStatus) paint(); }
        Connections { target: Theme; function onPalChanged() { web.paint(); } }

        // ventanas nuevas: popups de login (Google, Facebook…) en su propia ventana; el resto, aquí mismo
        onNewWindowRequested: req => {
            if (req.destination === WebEngineNewWindowRequest.InNewDialog) {
                const w = popup.createObject(win, { title: "Tok · login" });
                req.openIn(w.view);
            } else {
                web.url = req.requestedUrl;
            }
        }
        onFullScreenRequested: req => {
            req.accept();
            bar.visible = !req.toggleOn;
            win.fullscreen(req.toggleOn);
        }
        // sin notificaciones, cámara ni micro; el resto como venga
        onPermissionRequested: perm => perm.deny()
    }

    Component {
        id: popup
        Window {
            id: pw
            property alias view: pv
            width: 480
            height: 720
            visible: true
            color: Theme.s1
            WebEngineView {
                id: pv
                anchors.fill: parent
                profile: prof
                onWindowCloseRequested: pw.destroy()
            }
        }
    }
}
