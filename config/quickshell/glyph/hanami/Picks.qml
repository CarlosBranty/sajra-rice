import QtQuick
import qs
import qs.components

// one of a few: chips in a row, the chosen one white. ←→ move the choice. tips: { value: text } — what an option is, in a
// line under the chips while it's hovered or focused (in place of a tooltip window)
Column {
    id: root

    property string label
    property var model: []  // [[value, text]]
    property var value
    property var tips: null
    signal picked(var v)

    property var hot: undefined
    readonly property string tip: tips ? tips[String(hot !== undefined ? hot : value)] ?? "" : ""
    readonly property int cur: model.findIndex(o => String(o[0]) === String(value))

    width: parent?.width ?? 0
    spacing: 8

    Flow {
        id: flow
        width: parent.width
        spacing: 6
        activeFocusOnTab: true
        Accessible.role: Accessible.RadioButton
        Accessible.name: root.label
        Keys.onPressed: e => {
            const n = root.model.length;
            if (!n) return;
            let i;
            if (e.key === Qt.Key_Left || e.key === Qt.Key_Up) i = (Math.max(root.cur, 0) + n - 1) % n;
            else if (e.key === Qt.Key_Right || e.key === Qt.Key_Down) i = (root.cur + 1) % n;
            else return;
            e.accepted = true;
            if (String(root.model[i][0]) !== String(root.value)) root.picked(root.model[i][0]);
        }
        Repeater {
            model: root.model
            Rectangle {
                id: chip
                required property var modelData
                required property int index
                readonly property bool on: index === root.cur
                width: lab.implicitWidth + 30
                height: 36
                radius: Theme.corner(18)
                color: on ? Theme.fg : hov.hovered ? Theme.s3 : Theme.s2
                border { width: flow.activeFocus && on ? 1 : 0; color: Theme.accent }
                Behavior on color { ColorAnimation { duration: Theme.t / 2 } }
                Text {
                    id: lab
                    anchors.centerIn: parent
                    text: chip.modelData[1]
                    textFormat: Text.PlainText
                    font { family: Theme.ui; pixelSize: 14; weight: Font.Medium }
                    color: chip.on ? Theme.ink : Theme.fg
                }
                TapHandler { onTapped: if (!chip.on) root.picked(chip.modelData[0]) }
                HoverHandler {
                    id: hov
                    cursorShape: Qt.PointingHandCursor
                    onHoveredChanged: root.hot = hovered ? chip.modelData[0] : undefined
                }
            }
        }
    }
    Text {
        width: parent.width
        visible: !!root.tip
        text: root.tip
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        font { family: Theme.ui; pixelSize: 12 }
        color: Theme.grey
    }
}
