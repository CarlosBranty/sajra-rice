import QtQuick
import qs

// a text field: a pill with a red caret, as the launcher's search. Enter → accepted, Esc → escaped (when someone listens;
// otherwise Esc goes on up to the panel)
Rectangle {
    id: root

    property alias text: input.text
    property alias input: input
    property string placeholder
    property bool password: false
    property int maxLength: 200
    property bool catchEsc: false
    signal accepted
    signal escaped
    signal edited

    width: parent?.width ?? 200
    implicitHeight: 44
    radius: Theme.corner(22)
    color: Theme.s2
    border { width: input.activeFocus ? 1 : 0; color: Theme.s3 }

    function focus_() { input.forceActiveFocus(); }

    TextInput {
        id: input
        anchors { left: parent.left; leftMargin: 20; right: parent.right; rightMargin: 20; verticalCenter: parent.verticalCenter }
        font { family: Theme.ui; pixelSize: 15 }
        color: Theme.fg
        selectionColor: Theme.s3
        selectByMouse: true
        clip: true
        maximumLength: root.maxLength
        echoMode: root.password ? TextInput.Password : TextInput.Normal
        activeFocusOnTab: true
        Accessible.role: Accessible.EditableText
        Accessible.name: root.placeholder
        onTextEdited: root.edited()
        cursorDelegate: Rectangle {
            width: 2
            color: Theme.accent
            visible: input.activeFocus
            Timer { running: input.activeFocus; interval: 500; repeat: true; onTriggered: parent.opacity = 1 - parent.opacity }
        }
        Keys.onPressed: e => {
            if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter) { root.accepted(); e.accepted = true; }
            else if (e.key === Qt.Key_Escape && root.catchEsc) { root.escaped(); e.accepted = true; }
        }
        Text {
            visible: !input.text
            anchors.verticalCenter: parent.verticalCenter
            text: root.placeholder
            textFormat: Text.PlainText
            font: input.font
            color: Theme.mute
        }
    }
}
