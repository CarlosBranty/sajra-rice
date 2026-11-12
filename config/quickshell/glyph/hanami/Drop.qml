import QtQuick
import qs
import qs.components

// a dropdown drawn in the panel, not a popup window (a popup would take the keyboard from the panel). Its list opens
// under it, in the page; one open at a time (Hanami.dd). ↑↓ walk the list, ↵ picks, Esc closes.
// groups: [{ label?, items: [[value, text, disabled?]] }]
Column {
    id: root

    property string label
    property var groups: []
    property var value
    property string k
    property string placeholder: "Pick one"
    signal picked(var v)

    readonly property bool open: Hanami.dd === k
    readonly property var all: [].concat(...groups.map(g => g.items))
    readonly property var cur: all.find(o => String(o[0]) === String(value)) ?? null
    // the rows of the list: group headings and options, in order
    readonly property var rows: [].concat(...groups.map(g => (g.label ? [{ head: g.label }] : []).concat(g.items.map(o => ({ v: o[0], text: o[1], off: !!o[2] })))))
    property int hi: -1 // the option under the keyboard

    width: parent?.width ?? 0
    spacing: 6

    function toggle() {
        Hanami.dd = open ? "" : k;
        hi = rows.findIndex(r => !r.head && String(r.v) === String(value));
        btn.forceActiveFocus();
    }
    function choose(r) {
        Hanami.dd = "";
        btn.forceActiveFocus();
        if (r && !r.head && !r.off && String(r.v) !== String(value)) root.picked(r.v);
    }
    function step(d) {
        let i = hi;
        for (let n = 0; n < rows.length; n++) {
            i = Math.max(0, Math.min(rows.length - 1, i + d));
            if (!rows[i].head && !rows[i].off) break;
        }
        if (!rows[i].head && !rows[i].off) hi = i;
        list.positionViewAtIndex(hi, ListView.Contain);
    }

    Rectangle {
        id: btn
        width: parent.width
        height: 44
        radius: Theme.corner(22)
        color: hov.hovered ? Theme.s3 : Theme.s2
        border { width: activeFocus || root.open ? 1 : 0; color: Theme.fg }
        activeFocusOnTab: true
        Accessible.role: Accessible.ComboBox
        Accessible.name: `${root.label}: ${root.cur?.[1] ?? root.placeholder}`
        Keys.onPressed: e => {
            if (e.key === Qt.Key_Escape && root.open) Hanami.dd = "";
            else if (e.key === Qt.Key_Down || e.key === Qt.Key_Up) { if (!root.open) root.toggle(); else root.step(e.key === Qt.Key_Down ? 1 : -1); }
            else if ((e.key === Qt.Key_Return || e.key === Qt.Key_Enter || e.key === Qt.Key_Space) && root.open && root.hi >= 0) root.choose(root.rows[root.hi]);
            else if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter || e.key === Qt.Key_Space) root.toggle();
            else return;
            e.accepted = true;
        }
        Text {
            anchors { left: parent.left; leftMargin: 20; right: chev.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
            text: root.cur?.[1] ?? root.placeholder
            textFormat: Text.PlainText
            elide: Text.ElideRight
            font { family: Theme.ui; pixelSize: 15 }
            color: root.cur ? Theme.fg : Theme.mute
        }
        Icon {
            id: chev
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            text: root.open ? "\u{F0143}" : "\u{F0140}"
            font.pixelSize: 18
            color: Theme.grey
        }
        TapHandler { onTapped: root.toggle() }
        HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
    }

    Rectangle {
        visible: root.open
        width: parent.width
        height: Math.min(list.contentHeight + 12, 280)
        radius: Theme.corner(22)
        color: Theme.s2
        border { width: 1; color: Theme.s3 }
        ListView {
            id: list
            anchors { fill: parent; margins: 6 }
            clip: true
            model: root.rows
            boundsBehavior: Flickable.StopAtBounds
            delegate: Rectangle {
                id: opt
                required property var modelData
                required property int index
                readonly property bool sel: !modelData.head && String(modelData.v) === String(root.value)
                width: list.width
                height: modelData.head ? 30 : 38
                radius: Theme.corner(19)
                color: modelData.head ? "transparent" : sel ? Theme.fg : root.hi === index || oh.hovered && !modelData.off ? Theme.s3 : "transparent"
                Lb {
                    visible: !!opt.modelData.head
                    x: 14
                    anchors.verticalCenter: parent.verticalCenter
                    text: opt.modelData.head ?? ""
                    px: 10
                }
                Text {
                    visible: !opt.modelData.head
                    anchors { left: parent.left; leftMargin: 14; right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter }
                    text: opt.modelData.text ?? ""
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    font { family: Theme.ui; pixelSize: 14 }
                    color: opt.sel ? Theme.ink : opt.modelData.off ? Theme.mute : Theme.fg
                }
                HoverHandler { id: oh; enabled: !opt.modelData.head; cursorShape: Qt.PointingHandCursor }
                TapHandler { enabled: !opt.modelData.head && !opt.modelData.off; onTapped: root.choose(opt.modelData) }
            }
        }
    }
}
