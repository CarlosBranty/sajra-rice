import QtQuick
import qs
import qs.components

// кнопка-пилюля в настройках музыки: main — белая заливка, как выбранная вкладка
Rectangle {
    id: root

    property string text
    property bool main: false
    property bool busy: false
    signal clicked

    width: Math.max(96, lbl.implicitWidth + 32)
    height: 40
    radius: height / 2
    opacity: enabled ? 1 : 0.4
    color: tap.pressed ? Theme.s3 : main ? Theme.fg : Theme.s2
    Lb { id: lbl; anchors.centerIn: parent; text: root.busy ? "…" : root.text; color: root.main && !tap.pressed ? Theme.ink : Theme.fg }
    TapHandler { id: tap; enabled: root.enabled && !root.busy; onTapped: root.clicked() }
    HoverHandler { cursorShape: Qt.PointingHandCursor }
}
