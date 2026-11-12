import QtQuick
import qs
import qs.components

// круглая кнопка панели музыки: on — белая, как плитки быстрых настроек
Rectangle {
    id: root

    property string icon
    property bool on: false
    property real size: 40
    signal clicked

    width: size
    height: size
    radius: size / 2
    color: on || tap.pressed ? Theme.fg : Theme.s2
    Behavior on color { ColorAnimation { duration: Theme.t / 2 } }
    Icon { anchors.centerIn: parent; text: root.icon; font.pixelSize: root.size * 0.45; color: root.on || tap.pressed ? Theme.ink : Theme.fg }
    TapHandler { id: tap; onTapped: root.clicked() }
    HoverHandler { cursorShape: Qt.PointingHandCursor }
}
