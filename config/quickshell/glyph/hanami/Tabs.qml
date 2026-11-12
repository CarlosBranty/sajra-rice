import QtQuick
import qs
import qs.components

// the tabs of a page: words in a row, the open one white with a red dot. ←→ move
Row {
    id: root

    property var model: []  // [[id, label]]
    property string current
    signal picked(string id)

    spacing: 22
    activeFocusOnTab: true
    Keys.onPressed: e => {
        const n = model.length, i = model.findIndex(t => t[0] === current);
        if (e.key === Qt.Key_Right) picked(model[(i + 1) % n][0]);
        else if (e.key === Qt.Key_Left) picked(model[(i + n - 1) % n][0]);
        else return;
        e.accepted = true;
    }
    Repeater {
        model: root.model
        Row {
            id: tab
            required property var modelData
            readonly property bool on: root.current === modelData[0]
            spacing: 8
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                visible: tab.on
                width: 8
                height: 8
                radius: 4
                color: root.activeFocus ? Theme.fg : Theme.accent
            }
            Lb {
                text: tab.modelData[1]
                px: 12
                color: tab.on ? Theme.fg : hov.hovered ? Theme.grey : Theme.mute
                HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: if (!tab.on) root.picked(tab.modelData[0]) }
            }
        }
    }
}
