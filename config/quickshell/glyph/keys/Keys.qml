import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs

// keys: keystroke overlay in the spirit of keyviz, drawn as glyph keycaps. Super+Alt+K (global shell:keys) toggles it.
// Input comes from showmethekey-cli (pacman: showmethekey): it reads libinput as root, so it starts through pkexec and
// prints one JSON line per key. pkexec makes it root, so we can't kill it — "stop\n" on stdin ends it, as the GTK app does.
// The window takes no input (empty mask) and sits on the overlay layer at the bottom centre.
PanelWindow {
    id: root

    property bool on: false
    function toggle() { on = !on; }

    readonly property string cli: "/usr/bin/showmethekey-cli"
    readonly property int idle: 2200    // ms without keys → the row fades out
    readonly property int maxGroups: 3  // combos kept on screen, oldest drops first
    readonly property int maxRun: 4     // plain keys typed in a row merge into one group; past this the oldest scroll out
    readonly property int maxCaps: 6    // caps on screen in total, so the row never spreads across the screen
    readonly property real u: Theme.s * 0.55 // size unit: smaller than the shell's own panels

    // --- backend
    Process {
        id: backend
        command: ["pkexec", root.cli]
        stdinEnabled: true
        running: false
        stdout: SplitParser {
            onRead: line => {
                try { root.feed(JSON.parse(line)); } catch (e) {}
            }
        }
        onExited: (code, status) => {
            // pkexec cancelled (126/127) or backend gone: switch off so the shortcut starts it again cleanly
            if (root.on) root.on = false;
            root.reset();
        }
    }
    onOnChanged: {
        if (on) backend.running = true;
        else if (backend.running) backend.write("stop\n");
    }

    // --- model: groups of caps. A group is { caps: [label…], count, mods } — a combo (Super+Alt+M) or a run of plain keys
    property var held: ({})   // key_name → true while pressed (modifiers and the last keys, for the pressed look)
    property var groups: []
    property bool shown: false

    function reset() { held = {}; groups = []; shown = false; }

    readonly property var modOrder: ["SUPER", "CTRL", "ALT", "SHIFT"]
    function modOf(name) {
        if (name === "KEY_LEFTMETA" || name === "KEY_RIGHTMETA") return "SUPER";
        if (name === "KEY_LEFTCTRL" || name === "KEY_RIGHTCTRL") return "CTRL";
        if (name === "KEY_LEFTALT" || name === "KEY_RIGHTALT") return "ALT";
        if (name === "KEY_LEFTSHIFT" || name === "KEY_RIGHTSHIFT") return "SHIFT";
        return "";
    }
    readonly property var names: ({
        KEY_SPACE: "Space", KEY_ENTER: "⏎", KEY_KPENTER: "⏎", KEY_BACKSPACE: "⌫", KEY_TAB: "Tab", KEY_ESC: "Esc",
        KEY_DELETE: "Del", KEY_INSERT: "Ins", KEY_HOME: "Home", KEY_END: "End", KEY_PAGEUP: "PgUp", KEY_PAGEDOWN: "PgDn",
        KEY_UP: "↑", KEY_DOWN: "↓", KEY_LEFT: "←", KEY_RIGHT: "→", KEY_CAPSLOCK: "Caps", KEY_PRINT: "Print",
        KEY_MINUS: "-", KEY_EQUAL: "=", KEY_LEFTBRACE: "[", KEY_RIGHTBRACE: "]", KEY_SEMICOLON: ";", KEY_APOSTROPHE: "'",
        KEY_GRAVE: "`", KEY_BACKSLASH: "\\", KEY_COMMA: ",", KEY_DOT: ".", KEY_SLASH: "/",
        KEY_KPPLUS: "+", KEY_KPMINUS: "-", KEY_KPASTERISK: "*", KEY_KPSLASH: "/", KEY_KPDOT: ".",
        KEY_VOLUMEUP: "vol+", KEY_VOLUMEDOWN: "vol−", KEY_MUTE: "Mute", KEY_PLAYPAUSE: "⏯", KEY_NEXTSONG: "⏭",
        KEY_PREVIOUSSONG: "⏮", KEY_BRIGHTNESSUP: "☀+", KEY_BRIGHTNESSDOWN: "☀−"
    })
    readonly property var modLabel: ({ SUPER: "Super", CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift" })
    function label(name) {
        if (names[name] !== undefined) return names[name];
        let n = name.replace(/^KEY_/, "");
        if (n.startsWith("KP") && n.length === 3) n = n.slice(2); // keypad digits
        return n.length === 1 ? n : n.charAt(0) + n.slice(1).toLowerCase(); // F5, Esc-style
    }

    function activeMods() { return modOrder.filter(m => Object.keys(held).some(k => held[k] && modOf(k) === m)); }

    function feed(ev) {
        if (ev.event_name !== "KEYBOARD_KEY") return;
        const name = ev.key_name, down = ev.state_code === 1;
        const h = Object.assign({}, held);
        if (down) h[name] = true; else delete h[name];
        held = h;
        if (!down) { fade.restart(); return; }

        const mod = modOf(name);
        const mods = activeMods();
        let g = groups.slice();
        const last = g.length ? g[g.length - 1] : null;

        if (mod) {
            // a modifier alone shows as a pending combo; it becomes real when a key joins it
            const caps = mods.map(m => modLabel[m]);
            if (last && last.pending) g[g.length - 1] = { caps, count: 1, pending: true, mods: mods.join("+") };
            else g.push({ caps, count: 1, pending: true, mods: mods.join("+") });
        } else {
            const key = label(name);
            // shift + a printable key is still typing, not a shortcut
            const combo = mods.length && !(mods.length === 1 && mods[0] === "SHIFT" && key.length === 1);
            if (last && last.pending) g.pop();
            const tail = g.length ? g[g.length - 1] : null;
            if (combo) {
                const caps = mods.map(m => modLabel[m]).concat([key]);
                const id = caps.join("+");
                if (tail && tail.id === id) g[g.length - 1] = Object.assign({}, tail, { count: tail.count + 1 });
                else g.push({ caps, count: 1, id });
            } else {
                const cap = key.length === 1 ? key.toUpperCase() : key;
                if (tail && tail.run)
                    g[g.length - 1] = Object.assign({}, tail, { caps: tail.caps.concat([cap]).slice(-maxRun) });
                else g.push({ caps: [cap], count: 1, run: true });
            }
        }
        while (g.length > maxGroups) g.shift();
        const total = () => g.reduce((n, x) => n + x.caps.length, 0);
        while (g.length > 1 && total() > maxCaps) g.shift();
        groups = g;
        shown = true;
        fade.restart();
    }
    Timer {
        id: fade
        interval: root.idle
        onTriggered: {
            if (Object.keys(root.held).length) { restart(); return; }
            root.shown = false;
        }
    }
    // after the fade-out the history is dropped, so the next key starts a fresh row
    Timer { id: clear; interval: Theme.t + 50; onTriggered: if (!root.shown) root.groups = [] }
    onShownChanged: if (!shown) clear.restart()

    // --- window
    visible: on || stack.opacity > 0
    anchors { left: true; right: true; bottom: true }
    implicitHeight: 340 * u
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    mask: Region {}
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    WlrLayershell.namespace: "glyph-keys"

    // one translucent chip per group, stacked upwards: the newest sits at the bottom, older ones dim above it
    Column {
        id: stack
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 40 * u
        spacing: 10 * u

        opacity: root.on && root.shown && root.groups.length ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }

        Repeater {
            model: root.groups
            delegate: Rectangle {
                id: grp
                required property var modelData
                required property int index
                readonly property bool newest: index === root.groups.length - 1
                readonly property bool combo: !grp.modelData.run
                anchors.horizontalCenter: parent.horizontalCenter
                width: caps.width + 20 * u
                height: caps.height + 20 * u
                radius: Theme.corner(34 * u)
                // light: a faint black veil behind white caps; dark: the opposite, a faint white veil behind black caps
                color: Theme.light ? Qt.rgba(0, 0, 0, 0.12) : Qt.rgba(1, 1, 1, 0.09)

                // glyph dot matrix over the veil, kept inside the rounded shape
                Canvas {
                    id: dots
                    anchors.fill: parent
                    readonly property real pitch: 7 * u
                    readonly property real dot: 1.6 * u
                    readonly property color ink: Theme.light ? Qt.rgba(0, 0, 0, 0.22) : Qt.rgba(1, 1, 1, 0.2)
                    onWidthChanged: requestPaint()
                    onHeightChanged: requestPaint()
                    onInkChanged: requestPaint()
                    onPaint: {
                        const c = getContext("2d"), w = width, h = height, rad = grp.radius;
                        c.reset();
                        c.fillStyle = ink;
                        const inside = (x, y) => {
                            const cx = Math.min(Math.max(x, rad), w - rad), cy = Math.min(Math.max(y, rad), h - rad);
                            return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= (rad - pitch / 2) * (rad - pitch / 2);
                        };
                        for (let y = pitch / 2; y < h; y += pitch)
                            for (let x = pitch / 2; x < w; x += pitch)
                                if (inside(x, y)) { c.beginPath(); c.arc(x, y, dot, 0, 2 * Math.PI); c.fill(); }
                    }
                }
                opacity: newest ? 1 : 0.6
                Behavior on opacity { NumberAnimation { duration: 200 } }
                Behavior on width { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

                Row {
                    id: caps
                    anchors.centerIn: parent
                    spacing: 8 * u
                    Repeater {
                        model: grp.modelData.caps
                        delegate: Row {
                            required property string modelData
                            required property int index
                            spacing: 8 * u
                            Text { // "+" between the keys of a combo, as in keyviz
                                visible: grp.combo && index > 0
                                anchors.verticalCenter: parent.verticalCenter
                                text: "+"
                                color: Theme.fade(Theme.fg, 0.7)
                                font.family: Theme.ui
                                font.pixelSize: 22 * u
                            }
                            Cap {
                                text: modelData
                                pop: grp.newest && index === grp.modelData.caps.length - 1
                                pending: !!grp.modelData.pending
                                live: grp.newest
                            }
                        }
                    }
                    Text {
                        visible: grp.modelData.count > 1
                        anchors.verticalCenter: parent.verticalCenter
                        text: "×" + grp.modelData.count
                        color: Theme.accent
                        font.family: Theme.mono
                        font.pixelSize: 22 * u
                        font.bold: true
                    }
                }
            }
        }
    }

    // keycap: a translucent rounded square, brighter on the newest group. Pops in when it appears
    component Cap: Rectangle {
        id: cap
        property string text
        property bool pending: false
        property bool live: false
        property bool pop: false
        readonly property real u: Theme.s * 0.55
        readonly property bool wide: text === "Space"
        width: Math.max(66 * u, label.implicitWidth + 30 * u) + (wide ? 40 * u : 0)
        height: 66 * u
        radius: Theme.corner(24 * u)
        // white caps on light, black caps on dark, both see-through; no border
        readonly property color tone: Theme.light ? "#FFFFFF" : "#000000"
        color: Theme.fade(tone, pending ? 0.4 : live ? 0.78 : 0.6)

        Text {
            id: label
            anchors.centerIn: parent
            text: cap.text
            readonly property color ink: Theme.light ? "#111111" : "#F2F2F2"
            color: cap.pending ? Theme.fade(ink, 0.55) : ink
            // Doto with round dots, like the bar clock (components/Num.qml)
            font.family: Theme.dot
            font.pixelSize: (cap.text.length > 2 ? 30 : 32) * cap.u
            font.weight: Font.Black
            font.variableAxes: ({ "ROND": 100, "wght": 900 })
        }
        scale: pop ? 0.6 : 1
        Component.onCompleted: scale = 1
        Behavior on scale { NumberAnimation { duration: 180; easing.type: Easing.OutBack } }
    }
}
