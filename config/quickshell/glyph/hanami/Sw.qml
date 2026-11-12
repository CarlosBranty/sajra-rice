import QtQuick
import qs

// a setting that is on or off: a small pill switch, as the tumblers in the prefs (white slides over when on)
Setting {
    id: root

    property bool on
    signal flip

    Rectangle {
        id: sw
        width: 58
        height: 32
        radius: Theme.corner(16)
        color: Theme.s2
        border { width: activeFocus ? 1 : 0; color: Theme.fg }
        activeFocusOnTab: true
        Accessible.role: Accessible.CheckBox
        Accessible.name: root.label
        Accessible.checked: root.on
        Keys.onPressed: e => {
            if (e.key === Qt.Key_Space || e.key === Qt.Key_Return || e.key === Qt.Key_Enter) root.flip();
            else if (e.key === Qt.Key_Left || e.key === Qt.Key_Right) { if (root.on !== (e.key === Qt.Key_Right)) root.flip(); }
            else return;
            e.accepted = true;
        }
        Rectangle {
            x: 4
            y: 4
            width: root.on ? sw.width - 8 : height
            height: sw.height - 8
            radius: Theme.corner(height / 2)
            color: root.on ? Theme.fg : Theme.mute
            Behavior on width { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }
            Behavior on color { ColorAnimation { duration: Theme.t } }
            Rectangle {
                anchors { right: parent.right; rightMargin: 9; verticalCenter: parent.verticalCenter }
                width: 6
                height: 6
                radius: 3
                color: root.on ? Theme.accent : Theme.s2
            }
        }
        TapHandler { onTapped: root.flip() }
        HoverHandler { cursorShape: Qt.PointingHandCursor }
    }
}
