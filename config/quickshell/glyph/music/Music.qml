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
// пересобираем при каждом открытии (неизменённые файлы берутся из кэша, это доли секунды)
PanelWindow {
    id: root

    readonly property real w: 372 // ширина панели, px макета
    readonly property string bin: Quickshell.env("HOME") + "/.local/bin/"

    property bool open: false
    function toggle() { open = !open; }
    function close() { open = false; }
    onOpenChanged: if (open) { indexer.running = true; search.forceActiveFocus(); }

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

    // --- библиотека
    property var lib: []
    FileView {
        path: (Quickshell.env("XDG_CACHE_HOME") || Quickshell.env("HOME") + "/.cache") + "/musica/library.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: try { root.lib = JSON.parse(text()).tracks ?? []; } catch (e) {}
    }
    Process { id: indexer; command: [root.bin + "musica-index"] }

    property string mode: "album" // album | folder
    property string q: ""
    property var fold: ({})       // ключ группы → развёрнута ли (если трогали руками)

    function norm(s) { return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

    readonly property var groups: {
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
    function shuffleAll() { Quickshell.execDetached(["env", "MUSICA_QUIET=1", bin + "musica", "aleatorio"]); }

    // --- плеер: свой mpv, иначе любой играющий
    readonly property MprisPlayer pl: Media.players.find(p => p.identity === "mpv") ?? Media.player
    readonly property bool mine: pl?.identity === "mpv"
    readonly property string now: {
        const u = mine ? String(pl.metadata?.["xesam:url"] ?? "") : "";
        return u.startsWith("file://") ? decodeURIComponent(u.slice(7)) : "";
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
            Keys.onEscapePressed: root.close()
            MouseArea { anchors.fill: parent; onClicked: search.forceActiveFocus() }

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
                        Lb { px: 10; text: root.q ? `${root.count} found` : `${root.lib.length} songs · ${root.groups.length} ${root.mode === "album" ? "albums" : "folders"}` }
                    }
                    Row {
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        spacing: 10
                        MusicBtn { icon: "\u{F049D}"; onClicked: root.shuffleAll() }
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
                                root.mode = root.mode === "album" ? "folder" : "album";
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

                // по альбомам / по папкам (Tab в поиске): белая заливка переезжает, как у режимов питания
                Rectangle {
                    id: modes
                    width: parent.width
                    height: 44
                    radius: Theme.corner(22)
                    color: Theme.s2
                    readonly property var opts: [["album", "albums"], ["folder", "folders"]]
                    readonly property real cell: (width - 10) / opts.length
                    Rectangle {
                        x: 5 + modes.cell * (root.mode === "album" ? 0 : 1)
                        y: 5
                        width: modes.cell
                        height: parent.height - 10
                        radius: height / 2
                        color: Theme.fg
                        Behavior on x { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }
                    }
                    Repeater {
                        model: modes.opts
                        Item {
                            required property var modelData
                            required property int index
                            x: 5 + modes.cell * index
                            width: modes.cell
                            height: modes.height
                            Lb { anchors.centerIn: parent; text: parent.modelData[1]; color: root.mode === parent.modelData[0] ? Theme.ink : Theme.grey }
                            TapHandler { onTapped: root.mode = parent.modelData[0] }
                            HoverHandler { cursorShape: Qt.PointingHandCursor }
                        }
                    }
                }
            }

            // библиотека
            Flickable {
                id: list
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
                        }
                    }
                    Lb {
                        visible: root.shown.length === 0
                        width: groupsCol.width
                        topPadding: 30
                        horizontalAlignment: Text.AlignHCenter
                        text: root.lib.length ? "nothing found" : "no music in ~/Music"
                    }
                }
            }
        }
    }
}
