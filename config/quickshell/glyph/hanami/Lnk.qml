import QtQuick
import qs

// a text button in a row: underlined on hover, red when it removes something
Text {
    id: root

    property bool danger: false
    signal clicked

    textFormat: Text.PlainText
    font { family: Theme.ui; pixelSize: 14; weight: Font.Medium; underline: hov.hovered && enabled || activeFocus }
    color: !enabled ? Theme.mute : danger ? Theme.red : Theme.fg
    activeFocusOnTab: enabled
    Accessible.role: Accessible.Button
    Accessible.name: text
    Keys.onPressed: e => {
        if (e.key !== Qt.Key_Space && e.key !== Qt.Key_Return && e.key !== Qt.Key_Enter) return;
        root.clicked();
        e.accepted = true;
    }
    TapHandler { onTapped: root.clicked() }
    HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
}
