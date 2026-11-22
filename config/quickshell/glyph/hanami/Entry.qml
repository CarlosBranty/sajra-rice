import QtQuick
import qs

// a row of a list: a dot (white: done, red: went wrong, hollow: asked), the text and a line under it, and what to do on
// the right
Item {
    id: root

    property string kind: ""   // ask | did | bad
    property string text
    property string sub
    property bool subLate: false
    property bool dot: true
    default property alias tail: slot.data

    width: parent?.width ?? 0
    implicitHeight: Math.max(col.height, slot.childrenRect.height) + 16

    Rectangle {
        id: mark
        visible: root.dot
        x: 2
        anchors.verticalCenter: col.verticalCenter
        width: 8
        height: 8
        radius: 4
        color: root.kind === "bad" ? Theme.red : root.kind === "ask" ? "transparent" : Theme.fg
        border { width: root.kind === "ask" ? 1 : 0; color: Theme.grey }
    }
    Column {
        id: col
        anchors { left: parent.left; leftMargin: root.dot ? 22 : 0; right: slot.left; rightMargin: 14; verticalCenter: parent.verticalCenter }
        spacing: 2
        Text {
            width: parent.width
            text: root.text
            textFormat: Text.PlainText
            elide: Text.ElideRight
            font { family: Theme.ui; pixelSize: 15 }
            color: Theme.fg
        }
        Text {
            width: parent.width
            visible: !!root.sub
            text: root.sub
            textFormat: Text.PlainText
            elide: Text.ElideRight
            font { family: Theme.ui; pixelSize: 12 }
            color: root.subLate ? Theme.red : Theme.grey
        }
    }
    Row {
        id: slot
        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
        spacing: 14
    }
    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.s2 }
}
