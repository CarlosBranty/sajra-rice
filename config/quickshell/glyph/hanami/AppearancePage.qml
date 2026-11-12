import QtQuick
import qs
import qs.components

// Appearance: two tabs, the looks (drawn, playing) and the rest (size and colors)
Column {
    id: root

    readonly property var s: Hanami.state

    width: parent?.width ?? 0
    spacing: 26

    Tabs {
        model: [["look", "Look"], ["style", "Size and colors"]]
        current: Hanami.atab
        onPicked: id => Hanami.atab = id
    }
    Group {
        visible: Hanami.atab === "look"
        title: "Look"
        desc: "Each look has its own name and voice."
        // the looks as tiles, each its character playing at the size picked on the other tab (Hanami draws them);
        // the chosen one outlined. ←→ move the choice
        Flow {
            id: looks
            readonly property var model: root.s?.looks ?? []
            readonly property int cur: model.findIndex(l => l[0] === root.s?.look)
            width: parent.width
            spacing: 10
            activeFocusOnTab: true
            Accessible.role: Accessible.RadioButton
            Accessible.name: "Look"
            Keys.onPressed: e => {
                const n = looks.model.length;
                if (!n) return;
                let i;
                if (e.key === Qt.Key_Left || e.key === Qt.Key_Up) i = (Math.max(looks.cur, 0) + n - 1) % n;
                else if (e.key === Qt.Key_Right || e.key === Qt.Key_Down) i = (looks.cur + 1) % n;
                else return;
                e.accepted = true;
                Hanami.act(`look:${looks.model[i][0]}`);
            }
            Repeater {
                model: looks.model
                Rectangle {
                    id: tile
                    required property var modelData
                    required property int index
                    readonly property bool on: index === looks.cur
                    objectName: `look:${modelData[0]}`
                    width: 124
                    height: 124
                    radius: Theme.corner(18)
                    color: hov.hovered && !on ? Theme.s3 : Theme.s2
                    border { width: on ? 2 : 0; color: looks.activeFocus ? Theme.accent : Theme.fg }
                    Behavior on color { ColorAnimation { duration: Theme.t / 2 } }
                    Accessible.role: Accessible.RadioButton
                    Accessible.name: modelData[1]
                    Accessible.checked: on
                    LookSprite {
                        anchors { horizontalCenter: parent.horizontalCenter; top: parent.top; topMargin: 10 }
                        look: tile.modelData[0]
                        form: root.s?.size || "default"
                        offset: tile.index * 17
                        fallback: tile.modelData[1]
                    }
                    Text {
                        anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: 10 }
                        width: parent.width - 16
                        horizontalAlignment: Text.AlignHCenter
                        elide: Text.ElideRight
                        text: tile.modelData[1]
                        textFormat: Text.PlainText
                        font { family: Theme.ui; pixelSize: 13; weight: Font.Medium }
                        color: tile.on ? Theme.fg : Theme.grey
                    }
                    function pick() { if (!on) Hanami.act(`look:${modelData[0]}`); }
                    TapHandler { onTapped: tile.pick() }
                    HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
                }
            }
        }
    }
    Group {
        visible: Hanami.atab === "style"
        title: "Size"
        desc: "How big I am on your screen."
        Picks { label: "Size"; model: root.s?.sizes ?? []; value: root.s?.size ?? ""; onPicked: v => Hanami.act(`size:${v}`) }
    }
    Group {
        visible: Hanami.atab === "style"
        title: "Colors"
        desc: "Mine, or your desktop's: light or dark, as it is."
        Picks { label: "Colors"; model: root.s?.themes ?? []; value: root.s?.theme ?? ""; onPicked: v => Hanami.act(`theme:${v}`) }
    }
}
