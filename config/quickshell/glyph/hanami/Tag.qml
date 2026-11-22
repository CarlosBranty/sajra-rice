import QtQuick
import qs
import qs.components

// a small mark on a row (SUELDO, EDITADO): a label in a thin pill, filled when strong
Rectangle {
    id: root

    property string text
    property bool strong: false

    width: lb.implicitWidth + 14
    height: 18
    radius: Theme.corner(9)
    color: strong ? Theme.fg : "transparent"
    border { width: strong ? 0 : 1; color: Theme.s3 }
    Lb {
        id: lb
        anchors.centerIn: parent
        text: root.text
        px: 9
        color: root.strong ? Theme.ink : Theme.grey
    }
}
