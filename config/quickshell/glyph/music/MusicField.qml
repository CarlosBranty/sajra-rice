import QtQuick
import qs
import qs.components

// поле ввода в настройках музыки: подпись сверху, строка как у поиска. Отдельным файлом: inline component ломает горячую перезагрузку
Column {
    id: root

    property string label
    property string hint
    property alias text: input.text
    property bool secret: false
    signal accepted
    function take() { input.forceActiveFocus(); }

    spacing: 6

    Lb { x: 6; px: 10; text: root.label }
    Rectangle {
        width: root.width
        height: 44
        radius: Theme.corner(22)
        color: Theme.s2
        TextInput {
            id: input
            anchors { left: parent.left; leftMargin: 16; right: parent.right; rightMargin: 16; verticalCenter: parent.verticalCenter }
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.fg
            selectionColor: Theme.s3
            clip: true
            echoMode: root.secret ? TextInput.Password : TextInput.Normal
            onAccepted: root.accepted()
            Text { visible: !input.text; text: root.hint; font: input.font; color: Theme.mute; width: parent.width; elide: Text.ElideRight }
        }
        TapHandler { onTapped: input.forceActiveFocus() }
        HoverHandler { cursorShape: Qt.IBeamCursor }
    }
}
