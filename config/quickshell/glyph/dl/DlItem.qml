import QtQuick
import qs
import qs.components
import "../music"

// one download row: name, Glyph segment bar, size / speed / ETA line and its actions
Rectangle {
    id: root

    required property var d // item from `glyph-dl status`
    signal act(string cmd)

    readonly property bool done: d.status === "complete"
    readonly property bool failed: d.status === "error"
    readonly property bool paused: d.status === "paused" || d.status === "waiting"
    readonly property real f: d.total > 0 ? d.done / d.total : 0

    function size(b) {
        const u = ["B", "KB", "MB", "GB", "TB"];
        let i = 0;
        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
    }
    function eta(s) {
        s = Math.round(s);
        const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
        return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
    }
    readonly property string info: {
        if (failed) return d.error || "failed";
        if (d.status === "removed") return "removed";
        if (done) return size(d.total);
        const parts = [`${Math.floor(f * 100)}%`, d.total > 0 ? `${size(d.done)} / ${size(d.total)}` : size(d.done)];
        if (d.status === "active") {
            parts.push(`${size(d.speed)}/s`);
            if (d.speed > 0 && d.total > 0) parts.push(eta((d.total - d.done) / d.speed));
        } else {
            parts.push(d.status);
        }
        return parts.join(" · ");
    }

    height: 92
    radius: Theme.corner(24)
    color: Theme.s2

    Column {
        anchors { left: parent.left; leftMargin: 16; right: btns.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
        spacing: 8
        Text {
            width: parent.width
            elide: Text.ElideMiddle
            textFormat: Text.PlainText
            text: root.d.name
            font { family: Theme.ui; pixelSize: 15; weight: Font.DemiBold }
            color: root.done || root.d.status === "active" ? Theme.fg : Theme.grey
        }
        Seg {
            width: parent.width
            height: 5
            n: 24
            f: root.done ? 1 : root.f
            on: root.failed ? Theme.red : root.d.status === "active" ? Theme.accent : Theme.fg
        }
        Lb { width: parent.width; elide: Text.ElideRight; px: 10; text: root.info; color: root.failed ? Theme.red : Theme.grey }
    }

    Row {
        id: btns
        anchors { right: parent.right; rightMargin: 12; verticalCenter: parent.verticalCenter }
        spacing: 6
        MusicBtn {
            visible: !root.done && !root.failed && root.d.status !== "removed"
            size: 34
            icon: root.paused ? "\u{F040A}" : "\u{F03E4}"
            onClicked: root.act(root.paused ? "resume" : "pause")
        }
        MusicBtn {
            visible: root.done
            size: 34
            icon: "\u{F0770}"
            onClicked: root.act("open")
        }
        MusicBtn { size: 34; icon: "\u{F0156}"; onClicked: root.act("remove") }
    }
}
