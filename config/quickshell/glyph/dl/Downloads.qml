import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs
import qs.components
import "../music"

// downloads: Super+Alt+D. Thin floating panel on the right, like the music one. Backend is aria2c through
// ~/.local/bin/glyph-dl (16 connections per file, session resumes after reboot). On open, a link in the
// clipboard is pasted into the URL field; Enter queues it. Click outside or Esc closes.
PanelWindow {
    id: root

    readonly property real w: 400
    readonly property string bin: Quickshell.env("HOME") + "/.local/bin/glyph-dl"

    property bool open: false
    function toggle() { open = !open; }
    function close() { open = false; }
    onOpenChanged: if (open) { clip.running = true; poll.running = true; url.forceActiveFocus(); } else { url.text = ""; }

    property real t: open ? 1 : 0
    Behavior on t { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }

    visible: t > 0
    anchors { left: true; right: true; top: true; bottom: true }
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: open ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    WlrLayershell.namespace: "glyph-dl"

    // --- state from `glyph-dl status`, polled every second while the panel is open
    property bool running: false
    property real speed: 0
    property var items: []
    property string err: ""
    readonly property int active: items.filter(d => d.status === "active").length
    readonly property int pending: items.filter(d => d.status === "active" || d.status === "waiting").length
    readonly property bool anyStopped: items.some(d => d.status === "complete" || d.status === "error" || d.status === "removed")

    Process {
        id: poll
        command: [root.bin, "status"]
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    const s = JSON.parse(this.text);
                    root.running = s.running;
                    root.speed = s.speed;
                    root.items = s.items;
                } catch (e) {}
            }
        }
    }
    Timer { running: root.open; interval: 1000; repeat: true; onTriggered: if (!poll.running) poll.running = true }

    function run(args) {
        cmd.command = [root.bin].concat(args);
        cmd.running = true;
    }
    Process {
        id: cmd
        stderr: StdioCollector { onStreamFinished: root.err = this.text.trim() }
        onExited: code => { if (code === 0) root.err = ""; poll.running = true; }
    }

    readonly property var linkRe: /^(https?|ftp|sftp):\/\/\S+$|^magnet:\?\S+$/i
    function add() {
        const links = url.text.split(/\s+/).filter(s => linkRe.test(s));
        if (!links.length) { err = "not a link"; return; }
        run(["add"].concat(links));
        url.text = "";
    }

    // clipboard: prefill the field with a link, once per distinct link
    property string lastClip: ""
    Process {
        id: clip
        command: ["wl-paste", "-n", "-t", "text"]
        stdout: StdioCollector {
            onStreamFinished: {
                const s = this.text.trim();
                if (s && s !== root.lastClip && root.linkRe.test(s) && !url.text) {
                    url.text = s;
                    url.selectAll();
                }
                root.lastClip = s;
            }
        }
    }

    function size(b) {
        const u = ["B", "KB", "MB", "GB"];
        let i = 0;
        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
    }

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
            Keys.onEscapePressed: root.close()
            MouseArea { anchors.fill: parent; onClicked: url.forceActiveFocus() }

            Column {
                id: head
                x: 18
                y: 18
                width: parent.width - 36
                spacing: 14

                Item {
                    width: parent.width
                    height: 40
                    Column {
                        x: 6
                        anchors.verticalCenter: parent.verticalCenter
                        Text { text: "Downloads"; font { family: Theme.ui; pixelSize: 20; weight: Font.DemiBold } color: Theme.fg }
                        Lb {
                            px: 10
                            text: !root.running ? "aria2 idle" : root.active ? `${root.active} active · ${root.size(root.speed)}/s` : `${root.items.length} items`
                            color: root.active ? Theme.accent : Theme.grey
                        }
                    }
                    Row {
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        spacing: 10
                        MusicBtn {
                            visible: root.running && root.items.some(d => d.status === "active" || d.status === "waiting" || d.status === "paused")
                            icon: root.pending ? "\u{F03E4}" : "\u{F040A}"
                            onClicked: root.run([root.pending ? "pause-all" : "resume-all"])
                        }
                        MusicBtn { visible: root.anyStopped; icon: "\u{F00E2}"; onClicked: root.run(["clear"]) }
                        MusicBtn { icon: "\u{F0770}"; onClicked: Quickshell.execDetached(["xdg-open", Quickshell.env("HOME") + "/Downloads"]) }
                        MusicBtn { icon: "\u{F0156}"; onClicked: root.close() }
                    }
                }

                // URL field: Enter or + queues every link in it
                Rectangle {
                    width: parent.width
                    height: 48
                    radius: Theme.corner(24)
                    color: Theme.s2
                    Icon { id: chain; x: 16; anchors.verticalCenter: parent.verticalCenter; text: "\u{F0337}"; color: Theme.grey; font.pixelSize: 19 }
                    TextInput {
                        id: url
                        anchors { left: chain.right; leftMargin: 12; right: plus.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
                        font { family: Theme.ui; pixelSize: 15 }
                        color: Theme.fg
                        selectionColor: Theme.s3
                        clip: true
                        onTextChanged: root.err = ""
                        cursorDelegate: Rectangle {
                            width: 2
                            color: Theme.accent
                            Timer { running: url.activeFocus; interval: 500; repeat: true; onTriggered: parent.opacity = 1 - parent.opacity }
                        }
                        Text { visible: !url.text; x: 4; text: "Paste a link, Enter to download"; font: url.font; color: Theme.mute }
                        Keys.onPressed: e => {
                            if (e.key === Qt.Key_Escape) {
                                if (url.text) url.text = ""; else root.close();
                                e.accepted = true;
                            } else if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter) {
                                root.add();
                                e.accepted = true;
                            }
                        }
                    }
                    MusicBtn {
                        id: plus
                        anchors { right: parent.right; rightMargin: 6; verticalCenter: parent.verticalCenter }
                        size: 36
                        icon: "\u{F01DA}"
                        on: !!url.text
                        onClicked: root.add()
                    }
                }

                Lb { visible: !!root.err; width: parent.width; wrapMode: Text.Wrap; px: 10; text: root.err; color: Theme.red }
            }

            Flickable {
                id: list
                anchors { left: parent.left; leftMargin: 12; right: parent.right; rightMargin: 12; top: head.bottom; topMargin: 12; bottom: parent.bottom; bottomMargin: 14 }
                clip: true
                contentHeight: col.height
                boundsBehavior: Flickable.StopAtBounds

                Column {
                    id: col
                    width: list.width
                    spacing: 6
                    Repeater {
                        model: root.items
                        DlItem {
                            required property var modelData
                            width: col.width
                            d: modelData
                            onAct: c => root.run([c, modelData.gid])
                        }
                    }
                    Lb {
                        visible: root.items.length === 0
                        width: col.width
                        topPadding: 30
                        horizontalAlignment: Text.AlignHCenter
                        text: "no downloads"
                    }
                }
            }
        }
    }
}
