import QtQuick
import qs

// a button: a pill, white when it's the one to press (primary). Click, space or ↵
Rectangle {
    id: root

    property string text
    property bool primary: false
    property bool small: false
    signal clicked

    implicitWidth: lab.implicitWidth + (small ? 28 : 40)
    implicitHeight: small ? 34 : 44
    radius: Theme.corner(height / 2)
    color: primary ? Theme.fg : hov.hovered && enabled ? Theme.s3 : Theme.s2
    opacity: enabled ? 1 : 0.4
    border { width: activeFocus ? 1 : 0; color: primary ? Theme.accent : Theme.fg }
    activeFocusOnTab: enabled
    Accessible.role: Accessible.Button
    Accessible.name: text
    Keys.onPressed: e => {
        if (e.key !== Qt.Key_Space && e.key !== Qt.Key_Return && e.key !== Qt.Key_Enter) return;
        root.clicked();
        e.accepted = true;
    }
    Behavior on color { ColorAnimation { duration: Theme.t / 2 } }

    Text {
        id: lab
        anchors.centerIn: parent
        text: root.text
        textFormat: Text.PlainText
        font { family: Theme.ui; pixelSize: root.small ? 13 : 15; weight: Font.Medium }
        color: root.primary ? Theme.ink : Theme.fg
    }
    TapHandler { onTapped: root.clicked() }
    HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
}
