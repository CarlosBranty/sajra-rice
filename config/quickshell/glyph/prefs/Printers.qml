import QtQuick
import Quickshell
import Quickshell.Io
import qs
import qs.components

// PRINT page of prefs: the printers CUPS knows, through ~/.local/bin/glyph-print (JSON; lpadmin needs no password for
// the wheel group). Left, every printer added: the white pill is the one picked (←→ or click), the dot goes red when it
// is unplugged or paused. Right, what to do with it — default, pause, a test print, drop its jobs, remove — and, for a
// ticket printer (ESC/POS, zj-58 driver), its roll: 58 or 80 mm, cut at the end, open the cash drawer. Below, printers
// found and not added yet: one click adds them (USB always; the network on "scan network", it takes seconds)
Column {
    id: root

    property bool live: true // asks CUPS only while the page is on screen
    property var st: ({ ok: false, printers: [], found: [], jobs: [] })
    property var net: [] // found on the network by the last scan
    property string pick // the printer picked, by name: the list may reorder under it
    property string msg // what the last action answered
    property bool bad // …and whether it failed
    property string armed // the printer whose "remove" was clicked once: a second click removes it

    readonly property string bin: Quickshell.env("HOME") + "/.local/bin/glyph-print"
    readonly property var list: st.printers ?? []
    readonly property int cur: list.length ? Math.max(0, list.findIndex(p => p.name === pick)) : -1
    readonly property var sel: list[cur] ?? null
    readonly property var found: (st.found ?? []).concat(net.filter(n => !(st.found ?? []).some(f => f.uri === n.uri) && !list.some(p => p.uri === n.uri)))
    readonly property string caption: !st.ok ? `print · ${st.error ?? "asking cups"}`
        : `print · cups · ${list.length} printer${list.length === 1 ? "" : "s"}${st.default ? " · default " + st.default : ""}${st.jobs?.length ? ` · ${st.jobs.length} waiting` : ""}`

    function parse(text) { try { return JSON.parse(text); } catch (e) { return { ok: false, error: "glyph-print gave no answer" }; } }
    function refresh() { if (!lister.running) lister.running = true; }
    function run(args) {
        if (act.running) return;
        msg = args[0] + "…";
        bad = false;
        act.command = [bin].concat(args);
        act.running = true;
    }
    function go(i) { if (list.length) pick = list[(i + list.length) % list.length].name; }
    function word(p) { return p.connected === false ? "unplugged" : p.state === "paused" ? "paused" : p.state === "printing" ? "printing" : "ready"; }
    function wrong(p) { return p.connected === false || p.state === "paused"; }

    spacing: 26

    Process {
        id: lister
        command: [root.bin, "list"]
        stdout: StdioCollector { onStreamFinished: root.st = root.parse(text) }
    }
    Timer { interval: 3000; repeat: true; running: root.live; triggeredOnStart: true; onTriggered: root.refresh() }
    Process {
        id: act
        stdout: StdioCollector {
            onStreamFinished: {
                const o = root.parse(text);
                root.msg = o.ok ? o.msg ?? "" : o.error ?? "";
                root.bad = !o.ok;
                if (o.ok && o.name) root.pick = o.name; // a printer just added is the one picked
                root.refresh();
            }
        }
    }
    Process {
        id: scan
        command: [root.bin, "list", "--net"]
        stdout: StdioCollector {
            onStreamFinished: {
                const o = root.parse(text);
                root.net = (o.found ?? []).filter(f => !f.uri.startsWith("usb://"));
                root.msg = o.ok ? `network · ${root.net.length} found` : o.error ?? "";
                root.bad = !o.ok;
            }
        }
    }
    Timer { id: disarm; interval: 3000; onTriggered: root.armed = "" }

    // a pill that does one thing: click, space or ↵
    component Btn: Rectangle {
        id: btn
        property string text
        property bool hot // red: it removes something
        signal tap

        width: btnLb.implicitWidth + 48
        height: 52
        radius: Theme.corner(26)
        color: btnTap.pressed ? Theme.fg : btnTap.containsMouse ? Theme.s3 : Theme.s2
        border { width: activeFocus ? 1 : 0; color: Theme.fg }
        activeFocusOnTab: true
        Behavior on color { ColorAnimation { duration: 150 } }
        Keys.onPressed: e => {
            if (e.key !== Qt.Key_Space && e.key !== Qt.Key_Return && e.key !== Qt.Key_Enter) return;
            tap();
            e.accepted = true;
        }
        Lb { id: btnLb; anchors.centerIn: parent; text: btn.text; px: 10; color: btnTap.pressed ? Theme.ink : btn.hot ? Theme.red : Theme.fg }
        MouseArea { id: btnTap; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: btn.tap() }
    }

    Row {
        spacing: 40

        // the printers added: a vertical pick, as the devices of AUDIO. Five rows fit; more scroll
        Rectangle {
            id: box
            width: 470
            height: Math.min(5, Math.max(1, root.list.length)) * 56 + 12
            radius: Theme.corner(34)
            color: Theme.s1
            border { width: 1; color: box.activeFocus ? Theme.fg : Theme.s2 }
            activeFocusOnTab: true
            Keys.onPressed: e => {
                if (e.key === Qt.Key_Left) root.go(root.cur - 1);
                else if (e.key === Qt.Key_Right || e.key === Qt.Key_Space) root.go(root.cur + 1);
                else if ((e.key === Qt.Key_Return || e.key === Qt.Key_Enter) && root.sel) root.run(["default", root.sel.name]);
                else return;
                e.accepted = true;
            }

            Lb { visible: !root.list.length; anchors.centerIn: parent; text: root.st.ok ? "no printers added" : "cups is not answering"; px: 10 }
            Flickable {
                anchors { fill: parent; topMargin: 6; bottomMargin: 6 }
                clip: true
                contentHeight: root.list.length * 56
                boundsBehavior: Flickable.StopAtBounds
                readonly property int cur: root.cur
                onCurChanged: if (cur >= 0) contentY = Math.max(Math.min(contentY, cur * 56), (cur + 1) * 56 - height)
                Rectangle {
                    visible: root.cur >= 0
                    x: 6
                    y: Math.max(root.cur, 0) * 56
                    width: box.width - 12
                    height: 56
                    radius: Theme.corner(28)
                    color: Theme.fg
                    Behavior on y { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }
                }
                Repeater {
                    model: root.list
                    Item {
                        id: pr
                        required property var modelData
                        required property int index
                        readonly property bool on: index === root.cur
                        x: 6
                        y: index * 56
                        width: box.width - 12
                        height: 56

                        Rectangle {
                            x: 24
                            anchors.verticalCenter: parent.verticalCenter
                            width: 8
                            height: 8
                            radius: 4
                            color: root.wrong(pr.modelData) ? Theme.red : pr.on ? Theme.ink : Theme.s3
                        }
                        Text {
                            anchors { left: parent.left; leftMargin: 50; right: how.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
                            elide: Text.ElideRight
                            text: pr.modelData.name
                            textFormat: Text.PlainText
                            font { family: Theme.ui; pixelSize: 19 }
                            color: pr.on ? Theme.ink : Theme.grey
                            Behavior on color { ColorAnimation { duration: Theme.t } }
                        }
                        Lb {
                            id: how
                            anchors { right: parent.right; rightMargin: 24; verticalCenter: parent.verticalCenter }
                            text: (pr.modelData.name === root.st.default ? "default · " : "") + root.word(pr.modelData)
                            px: 10
                            color: pr.on ? Theme.ink : Theme.mute
                        }
                        TapHandler {
                            onTapped: {
                                box.forceActiveFocus();
                                root.pick = pr.modelData.name;
                            }
                        }
                        HoverHandler { cursorShape: Qt.PointingHandCursor }
                    }
                }
            }
        }

        // the printer picked: what it is, what to do with it
        Column {
            visible: !!root.sel
            width: 415
            spacing: 18

            Lb {
                width: parent.width
                wrapMode: Text.Wrap
                px: 10
                text: root.sel ? `${root.sel.uri.split(":")[0]} · ${root.sel.ticket ? root.sel.ticket.paper + " mm ticket" : "pages"}${root.sel.note ? " · " + root.sel.note : ""}${root.sel.jobs ? ` · ${root.sel.jobs} waiting` : ""}` : ""
            }
            Flow {
                width: parent.width
                spacing: 10
                Btn { visible: root.sel?.name !== root.st.default; text: "make default"; onTap: root.run(["default", root.sel.name]) }
                Btn { text: root.sel?.state === "paused" ? "resume" : "pause"; onTap: root.run([root.sel.state === "paused" ? "resume" : "pause", root.sel.name]) }
                Btn { text: root.sel?.ticket ? "test ticket" : "test page"; onTap: root.run(["test", root.sel.name]) }
                Btn { visible: (root.sel?.jobs ?? 0) > 0; text: `drop ${root.sel?.jobs ?? 0} job${root.sel?.jobs === 1 ? "" : "s"}`; onTap: root.run(["cancel", root.sel.name]) }
                Btn {
                    hot: true
                    text: root.armed && root.armed === root.sel?.name ? "sure? remove" : "remove"
                    onTap: {
                        if (root.armed === root.sel.name) {
                            root.armed = "";
                            root.run(["remove", root.sel.name]);
                        } else {
                            root.armed = root.sel.name;
                            disarm.restart();
                        }
                    }
                }
            }
            // a ticket printer's roll
            Column {
                visible: !!root.sel?.ticket
                spacing: 12
                Pick {
                    label: "paper"
                    seg: 84
                    opts: ["58", "80"]
                    cur: opts.indexOf(root.sel?.ticket?.paper ?? "")
                    onPicked: i => { if (opts[i] !== root.sel.ticket.paper) root.run(["set", root.sel.name, "paper=" + opts[i]]); }
                }
                Row {
                    spacing: 12
                    Toggle { text: "cut"; on: root.sel?.ticket?.cut ?? false; onFlip: root.run(["set", root.sel.name, "cut=" + (on ? "off" : "on")]) }
                    Toggle { text: "drawer"; on: root.sel?.ticket?.drawer ?? false; onFlip: root.run(["set", root.sel.name, "drawer=" + (on ? "off" : "on")]) }
                }
            }
        }
    }

    // found and not added: a chip each. The network is asked only on demand
    Flow {
        width: 925
        spacing: 10
        Lb { height: 52; verticalAlignment: Text.AlignVCenter; rightPadding: 8; text: root.found.length ? "found" : "found · nothing new plugged in" }
        Repeater {
            model: root.found
            Btn {
                required property var modelData
                text: `add · ${modelData.name}${modelData.ticket ? " · ticket" : ""}`
                onTap: root.run(["add", modelData.uri, modelData.name])
            }
        }
        Btn { text: scan.running ? "scanning…" : "scan network"; onTap: if (!scan.running) scan.running = true }
    }

    Lb { visible: !!text; text: root.msg; px: 10; color: root.bad ? Theme.red : Theme.grey }
}
