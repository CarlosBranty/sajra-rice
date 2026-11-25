import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import Quickshell.Wayland
import qs
import qs.components
import qs.services

// музыка: Super+Alt+M или клик по мини-плееру в быстрых настройках. Узкая плавающая панель у правого края, выезжает справа:
// плеер mpv (~/.local/bin/musica, он же в MPRIS) и библиотека ~/Music по альбомам или папкам, с поиском. Экран не гасит;
// клик мимо панели или Esc — закрыть. Индекс — ~/.local/bin/musica-index → ~/.cache/musica/library.json, его
// пересобираем при каждом открытии (неизменённые файлы берутся из кэша, это доли секунды).
// Local | Server: сервер Qodi Music (~/.local/bin/musica-remote login URL USER) → ~/.cache/musica/remote.json,
// синхронизируется при каждом открытии; песни — URL потока, mpv играет их напрямую.
// ⚙ в шапке — настройки (MusicSettings): папка библиотеки и вход на сервер, вместо поиска и списка
// Lists (the third tab): ~/.config/musica/playlists.json, { lists: [{ name, tracks: [path] }] }. A path is a file or a
// server URL, so one list mixes both libraries; a song no longer in either shows by its file name. + on a song or an
// album opens the picker (MusicPick); in a list, − takes a song out and the bin deletes the list
PanelWindow {
    id: root

    readonly property real w: 372 // ширина панели, px макета
    readonly property string bin: Quickshell.env("HOME") + "/.local/bin/"

    property bool open: false
    function toggle() { open = !open; }
    function close() { open = false; }
    property bool settings: false
    onSettingsChanged: if (!settings) search.forceActiveFocus(); else panel.forceActiveFocus()
    onOpenChanged: if (open) { settings = false; adding = null; indexer.running = true; remoteSync.running = true; listsFile.reload(); search.forceActiveFocus(); }

    property real t: open ? 1 : 0
    Behavior on t { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }

    visible: t > 0
    // на весь экран, но прозрачно: клик мимо панели — закрыть (как у быстрых настроек, только без затемнения)
    anchors { left: true; right: true; top: true; bottom: true }
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: open ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None // сразу печатать в поиск
    WlrLayershell.namespace: "glyph-music"

    // --- библиотека: локальная или с сервера
    readonly property string cache: (Quickshell.env("XDG_CACHE_HOME") || Quickshell.env("HOME") + "/.cache") + "/musica/"
    property string source: "local" // local | server
    property var localLib: []
    property string localRoot: ""   // какую папку проиндексировали
    property string musicDir: ""    // выбранная в настройках, "" — по умолчанию
    property var remote: ({ tracks: [] }) // server, user, error, tracks
    readonly property var lib: source === "server" ? (remote.tracks ?? []) : localLib
    FileView {
        path: root.cache + "library.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: try { const d = JSON.parse(text()); root.localLib = d.tracks ?? []; root.localRoot = d.root ?? ""; } catch (e) {}
    }
    FileView {
        path: (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/musica/music-dir"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: root.musicDir = text().split("\n")[0].trim()
    }
    FileView {
        path: root.cache + "remote.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: try { root.remote = JSON.parse(text()); } catch (e) {}
    }
    Process { id: indexer; command: [root.bin + "musica-index"] }
    Process { id: remoteSync; command: [root.bin + "musica-remote", "sync"] }
    readonly property string remoteNote: {
        const e = remote.error;
        if (e === "not_logged_in" || (!remote.server && !e)) return "not connected · musica-remote login URL USER";
        if (e === "login_expired") return "session expired · musica-remote login URL USER";
        if (e) return `server unreachable · ${e}`;
        return "";
    }

    // --- lists
    readonly property string conf: (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/musica/"
    property var lists: []
    FileView {
        id: listsFile
        path: root.conf + "playlists.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: try { const d = JSON.parse(text()); root.lists = (d.lists ?? []).filter(l => l && typeof l.name === "string" && Array.isArray(l.tracks)); } catch (e) {}
    }
    // written through a temp file and mv, so a half-written file is never read back; the folder may not exist yet
    function saveLists(a) {
        lists = a;
        Quickshell.execDetached(["bash", "-c", 'mkdir -p "$1" && printf "%s\\n" "$2" > "$1/playlists.json.tmp" && mv -f "$1/playlists.json.tmp" "$1/playlists.json"',
            "bash", conf, JSON.stringify({ lists: a }, null, 2)]);
    }
    function copyLists() { return lists.map(l => ({ name: l.name, tracks: l.tracks.slice() })); }
    function addTo(i, paths) {
        const a = copyLists();
        for (const p of paths) if (!a[i].tracks.includes(p)) a[i].tracks.push(p);
        saveLists(a);
    }
    function newList(name, paths) {
        const at = lists.findIndex(l => l.name.toLowerCase() === name.toLowerCase());
        if (at >= 0) return addTo(at, paths); // the same name: into that one
        saveLists(copyLists().concat([{ name, tracks: Array.from(new Set(paths)) }]));
    }
    function dropFrom(i, k) { const a = copyLists(); a[i].tracks.splice(k, 1); saveLists(a); }
    function removeList(i) { const a = copyLists(); a.splice(i, 1); saveLists(a); }
    // what the picker is adding: { paths, what }, null while it is closed
    property var adding: null
    onAddingChanged: if (!adding && !settings) search.forceActiveFocus()

    // every song either library knows, by path: a list's tracks are looked up here
    readonly property var known: {
        const m = {};
        for (const t of localLib) m[t.path] = t;
        for (const t of remote.tracks ?? []) m[t.path] = t;
        return m;
    }
    function stub(p) {
        const f = decodeURIComponent(String(p).split("?")[0].split("/").pop() || p);
        return { path: p, title: f.replace(/\.[^.]+$/, ""), artist: "", album: "", folder: "", dur: 0, track: 0, disc: 0 };
    }

    property string mode: "album" // album | folder | list
    property string q: ""
    property var fold: ({})       // ключ группы → развёрнута ли (если трогали руками)

    function norm(s) { return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

    readonly property var groups: {
        if (mode === "list") return lists.map((l, i) => {
            const tracks = l.tracks.map(p => known[p] ?? stub(p));
            const art = tracks.find(t => t.art)?.art ?? "";
            return { key: "list\n" + l.name, name: l.name, sub: "", art, tracks, dur: tracks.reduce((s, t) => s + (t.dur || 0), 0), list: i };
        });
        const m = new Map();
        for (const t of lib) {
            const byAlbum = mode === "album" && !!t.album;
            const key = byAlbum ? `${t.albumArtist || t.artist}\n${t.album}` : `/${t.folder}`;
            let g = m.get(key);
            if (!g) {
                const parts = t.folder ? t.folder.split("/") : [];
                g = { key, name: byAlbum ? t.album : (parts.pop() || "music"), sub: byAlbum ? (t.albumArtist || t.artist) : parts.join(" / "), art: t.art, tracks: [], dur: 0 };
                m.set(key, g);
            }
            g.tracks.push(t);
            g.dur += t.dur || 0;
            if (!g.art && t.art) g.art = t.art;
        }
        const out = Array.from(m.values());
        for (const g of out)
            g.tracks.sort((a, b) => (a.disc - b.disc) || (a.track - b.track) || a.path.localeCompare(b.path));
        out.sort((a, b) => a.sub.localeCompare(b.sub) || a.name.localeCompare(b.name));
        return out;
    }
    // поиск: все слова, без регистра и ударений, по треку, исполнителю, альбому и папке
    readonly property var shown: {
        const words = norm(q).split(/\s+/).filter(w => w);
        if (!words.length) return groups.map(g => ({ g, hits: g.tracks }));
        const out = [];
        for (const g of groups) {
            const head = norm(`${g.name} ${g.sub}`);
            const hits = g.tracks.filter(t => {
                const s = `${head} ${norm(`${t.title} ${t.artist} ${t.folder}`)}`;
                return words.every(w => s.includes(w));
            });
            if (hits.length) out.push({ g, hits });
        }
        return out;
    }
    readonly property int count: shown.reduce((s, x) => s + x.hits.length, 0)

    function opened(g) {
        if (q) return true;
        if (fold[g.key] !== undefined) return fold[g.key];
        return groups.length <= 3 || g.tracks.some(t => t.path === now);
    }
    function flip(g) { const f = Object.assign({}, fold); f[g.key] = !opened(g); fold = f; }

    // песни группы по порядку, с i-й — mpv перезапускается (musica lista), MPRIS-плеер приходит заново
    function play(g, i) {
        Quickshell.execDetached(["env", "MUSICA_QUIET=1", bin + "musica", "lista", String(i)].concat(g.tracks.map(t => t.path)));
    }
    function shuffleAll() {
        if (source === "local") return Quickshell.execDetached(["env", "MUSICA_QUIET=1", bin + "musica", "aleatorio"]);
        const a = lib.map(t => t.path);
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        if (a.length) Quickshell.execDetached(["env", "MUSICA_QUIET=1", bin + "musica", "lista", "0"].concat(a));
    }

    // --- плеер: свой mpv, иначе любой играющий
    readonly property MprisPlayer pl: Media.players.find(p => p.identity === "mpv") ?? Media.player
    readonly property bool mine: pl?.identity === "mpv"
    readonly property string now: {
        const u = mine ? String(pl.metadata?.["xesam:url"] ?? "") : "";
        if (u.startsWith("file://")) return decodeURIComponent(u.slice(7));
        return /^https?:\/\//.test(u) ? u.split("?")[0] : ""; // поток с сервера: path в remote.json без токена
    }
    property real pos: 0
    Timer {
        running: root.open && !!root.pl
        interval: 500
        repeat: true
        triggeredOnStart: true
        onTriggered: root.pos = root.pl?.position ?? 0
    }
    onNowChanged: pos = pl?.position ?? 0

    MouseArea { anchors.fill: parent; enabled: root.open; onPressed: root.close() }

    Stage {
        Rectangle {
            id: panel
            anchors { right: parent.right; rightMargin: 14 - 24 * (1 - root.t); top: parent.top; topMargin: 14 + (Theme.state.barAt === "top" ? Theme.barOff : 0); bottom: parent.bottom; bottomMargin: 14 }
            width: root.w
            opacity: root.t
            radius: Theme.corner(36)
            color: Theme.s1
            border { width: 1; color: Theme.s2 }
            focus: true
            Keys.onEscapePressed: root.adding ? root.adding = null : root.settings ? root.settings = false : root.close() // из настроек — назад к списку
            MouseArea { anchors.fill: parent; onClicked: if (!root.settings && !root.adding) search.forceActiveFocus() }

            Column {
                id: head
                x: 18
                y: 18
                width: parent.width - 36
                spacing: 14

                // шапка: заголовок, всё вперемешку, закрыть
                Item {
                    width: parent.width
                    height: 40
                    Column {
                        x: 6
                        anchors.verticalCenter: parent.verticalCenter
                        Text { text: "Music"; font { family: Theme.ui; pixelSize: 20; weight: Font.DemiBold } color: Theme.fg }
                        Lb { px: 10; text: root.settings ? "settings" : root.q ? `${root.count} found` : root.mode === "list" ? `${root.lists.length} ${root.lists.length === 1 ? "list" : "lists"}` : `${root.lib.length} songs · ${root.groups.length} ${root.mode === "album" ? "albums" : "folders"}` }
                    }
                    Row {
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        spacing: 10
                        MusicBtn { icon: "\u{F049D}"; onClicked: root.shuffleAll() }
                        MusicBtn { icon: "\u{F0493}"; on: root.settings; onClicked: root.settings = !root.settings }
                        MusicBtn { icon: "\u{F0156}"; onClicked: root.close() }
                    }
                }

                // сейчас играет: обложка, трек, шкала Glyph (тап — перемотка), кнопки
                Rectangle {
                    visible: !!root.pl
                    width: parent.width
                    height: 178
                    radius: Theme.corner(30)
                    color: Theme.s2

                    Art { id: nart; x: 14; y: 14; width: 64; height: 64; step: 3; url: root.pl?.trackArtUrl ?? "" }
                    Column {
                        anchors { left: nart.right; leftMargin: 14; right: parent.right; rightMargin: 16; verticalCenter: nart.verticalCenter }
                        spacing: 2
                        Text { width: parent.width; elide: Text.ElideRight; textFormat: Text.PlainText; text: root.pl?.trackTitle || "Nothing on"; font { family: Theme.ui; pixelSize: 16; weight: Font.DemiBold } color: Theme.fg }
                        Text { width: parent.width; elide: Text.ElideRight; textFormat: Text.PlainText; text: root.pl?.trackArtist ?? ""; font { family: Theme.ui; pixelSize: 13 } color: Theme.grey }
                        Lb { width: parent.width; elide: Text.ElideRight; px: 10; visible: !root.mine; text: root.pl?.identity ?? "" }
                    }

                    Item {
                        id: bar
                        x: 16
                        y: 92
                        width: parent.width - 32
                        height: 26
                        readonly property real len: root.pl?.length ?? 0
                        Seg {
                            anchors { left: parent.left; right: parent.right; top: parent.top }
                            height: 5
                            n: 28
                            f: bar.len > 0 ? root.pos / bar.len : 0
                        }
                        Lb { anchors.bottom: parent.bottom; px: 10; text: Media.time(root.pos) }
                        Lb { anchors { right: parent.right; bottom: parent.bottom } px: 10; text: bar.len > 0 ? Media.time(bar.len) : "" }
                        TapHandler {
                            enabled: root.pl?.canSeek ?? false
                            onTapped: e => { root.pl.position = e.position.x / bar.width * bar.len; root.pos = root.pl.position; }
                        }
                        HoverHandler { cursorShape: root.pl?.canSeek ? Qt.PointingHandCursor : Qt.ArrowCursor }
                    }

                    Item {
                        x: 16
                        y: 124
                        width: parent.width - 32
                        height: 44
                        MusicBtn {
                            anchors.verticalCenter: parent.verticalCenter
                            visible: root.pl?.shuffleSupported ?? false
                            size: 36
                            icon: "\u{F049D}"
                            on: root.pl?.shuffle ?? false
                            onClicked: root.pl.shuffle = !root.pl.shuffle
                        }
                        Controls { anchors.centerIn: parent; size: 20; play: 44 }
                        MusicBtn {
                            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                            visible: root.pl?.loopSupported ?? false
                            size: 36
                            readonly property int st: root.pl?.loopState ?? MprisLoopState.None
                            icon: st === MprisLoopState.Track ? "\u{F0458}" : "\u{F0456}"
                            on: st !== MprisLoopState.None
                            // нет → весь список → один трек → нет
                            onClicked: root.pl.loopState = st === MprisLoopState.None ? MprisLoopState.Playlist : st === MprisLoopState.Playlist ? MprisLoopState.Track : MprisLoopState.None
                        }
                    }
                }

                // поиск
                Rectangle {
                    visible: !root.settings
                    width: parent.width
                    height: 48
                    radius: Theme.corner(24)
                    color: Theme.s2
                    Icon { id: lens; x: 16; anchors.verticalCenter: parent.verticalCenter; text: "\u{F0349}"; color: Theme.grey; font.pixelSize: 19 }
                    TextInput {
                        id: search
                        anchors { left: lens.right; leftMargin: 12; right: clear.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
                        font { family: Theme.ui; pixelSize: 16 }
                        color: Theme.fg
                        selectionColor: Theme.s3
                        clip: true
                        onTextChanged: root.q = text
                        cursorDelegate: Rectangle {
                            width: 2
                            color: Theme.accent
                            Timer { running: search.activeFocus; interval: 500; repeat: true; onTriggered: parent.opacity = 1 - parent.opacity }
                        }
                        Text { visible: !search.text; x: 4; text: "Search songs, artists, albums"; font: search.font; color: Theme.mute }
                        Keys.onPressed: e => {
                            if (e.key === Qt.Key_Escape) {
                                if (search.text) search.text = ""; else root.close();
                                e.accepted = true;
                            } else if ((e.key === Qt.Key_Return || e.key === Qt.Key_Enter) && root.shown.length) {
                                // Enter — первая найденная песня, дальше её альбом/папка по порядку
                                const x = root.shown[0];
                                root.play(x.g, Math.max(0, x.g.tracks.findIndex(t => t.path === x.hits[0].path)));
                                e.accepted = true;
                            } else if (e.key === Qt.Key_Tab) {
                                root.mode = root.mode === "album" ? "folder" : root.mode === "folder" ? "list" : "album";
                                e.accepted = true;
                            }
                        }
                    }
                    Icon {
                        id: clear
                        anchors { right: parent.right; rightMargin: 16; verticalCenter: parent.verticalCenter }
                        visible: !!search.text
                        text: "\u{F0156}"
                        font.pixelSize: 17
                        color: Theme.grey
                        TapHandler { onTapped: search.text = "" }
                    }
                }

                // своя библиотека или сервер Qodi Music; a list mixes both, so not over the lists
                MusicTabs {
                    visible: !root.settings && root.mode !== "list"
                    width: parent.width
                    opts: [["local", "local"], ["server", "server"]]
                    value: root.source
                    onPicked: v => { root.source = v; root.fold = {}; }
                }

                // по альбомам / по папкам (Tab в поиске)
                MusicTabs {
                    visible: !root.settings
                    width: parent.width
                    opts: [["album", "albums"], ["folder", "folders"], ["list", "lists"]]
                    value: root.mode
                    onPicked: v => root.mode = v
                }
            }

            // библиотека
            Flickable {
                id: list
                visible: !root.settings
                anchors { left: parent.left; leftMargin: 12; right: parent.right; rightMargin: 12; top: head.bottom; topMargin: 12; bottom: parent.bottom; bottomMargin: 14 }
                clip: true
                contentHeight: groupsCol.height
                boundsBehavior: Flickable.StopAtBounds

                Column {
                    id: groupsCol
                    width: list.width
                    spacing: 4
                    Repeater {
                        model: root.shown
                        MusicGroup {
                            required property var modelData
                            width: groupsCol.width
                            g: modelData.g
                            hits: modelData.hits
                            now: root.now
                            open: root.opened(modelData.g)
                            onToggled: root.flip(modelData.g)
                            onPicked: i => root.play(modelData.g, i)
                            onAdd: (paths, what) => { root.adding = { paths, what }; pick.focusField(); }
                            onDrop: i => root.dropFrom(modelData.g.list, i)
                            onRemove: root.removeList(modelData.g.list)
                        }
                    }
                    Lb {
                        visible: root.shown.length === 0
                        width: groupsCol.width
                        topPadding: 30
                        horizontalAlignment: Text.AlignHCenter
                        text: root.mode === "list" && !root.lists.length ? "no lists yet · + on a song or an album"
                            : root.source === "server" && root.remoteNote && root.mode !== "list" ? root.remoteNote
                            : root.lib.length ? "nothing found"
                            : root.source === "server" ? "no music on the server" : "no music in ~/Music"
                    }
                }
            }

            // the picker: over the list, at the bottom; a tap on the dimmed list closes it
            Rectangle {
                anchors { fill: list }
                visible: !!root.adding
                radius: Theme.corner(24)
                color: Theme.fade(Theme.s1, 0.7)
                TapHandler { onTapped: root.adding = null }
            }
            MusicPick {
                id: pick
                visible: !!root.adding
                anchors { left: parent.left; leftMargin: 12; right: parent.right; rightMargin: 12; bottom: parent.bottom; bottomMargin: 14 }
                what: root.adding?.what ?? ""
                paths: root.adding?.paths ?? []
                lists: root.lists
                onPicked: i => { root.addTo(i, paths); root.adding = null; }
                onCreated: name => { root.newList(name, paths); root.adding = null; }
                onDismissed: root.adding = null
            }

            // настройки: вместо поиска и списка, своя прокрутка (форма входа длиннее, чем помещается)
            Flickable {
                id: prefs
                visible: root.settings
                anchors { left: parent.left; leftMargin: 18; right: parent.right; rightMargin: 18; top: head.bottom; topMargin: 4; bottom: parent.bottom; bottomMargin: 14 }
                clip: true
                contentHeight: form.height
                boundsBehavior: Flickable.StopAtBounds
                MusicSettings {
                    id: form
                    width: prefs.width
                    bin: root.bin
                    dir: root.musicDir
                    indexed: root.localRoot
                    localCount: root.localLib.length
                    remote: root.remote
                    remoteNote: root.remoteNote
                    onDirSaved: indexer.running = true
                }
            }
        }
    }
}
