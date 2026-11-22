import QtQuick
import qs

// one row: what it is (and a line under it) on the left, what to do on the right
Item {
    id: root

    property string label
    property string hint
    property bool hintLate: false // the line under it in red (an error, overdue)
    property bool mono: false     // the line under it is a command
    default property alias tail: slot.data

    width: parent?.width ?? 0
    implicitHeight: Math.max(left.height, slot.childrenRect.height) + 14

    Column {
        id: left
        anchors { left: parent.left; right: slot.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
        spacing: 2
        Text {
            width: parent.width
            text: root.label
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font { family: Theme.ui; pixelSize: 15; weight: Font.Medium }
            color: Theme.fg
        }
        Text {
            width: parent.width
            visible: !!root.hint
            text: root.hint
            textFormat: Text.PlainText
            wrapMode: root.mono ? Text.WrapAnywhere : Text.Wrap
            font { family: root.mono ? Theme.mono : Theme.ui; pixelSize: root.mono ? 12 : 13 }
            color: root.hintLate ? Theme.red : Theme.grey
        }
    }
    Row {
        id: slot
        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
        spacing: 14
    }
}
