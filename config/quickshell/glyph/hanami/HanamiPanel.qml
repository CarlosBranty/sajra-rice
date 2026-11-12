import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs
import qs.components

// Hanami's settings as a glyph side panel: the same pages as its web panel, which other desktops keep. Opens with the
// shell:hanami shortcut (hanami.lua binds it), `qs ipc call hanami toggle`, or when Hanami asks ({kind:"open"}: its tray,
// `hanami --panel`). Slides in from the right, over a dimmed screen; a click beside it or Esc closes it
PanelWindow {
    id: root

    function open() { Hanami.open(); }
    function close() { Hanami.close(); }
    function toggle() { Hanami.toggle(); }

    property real t: Hanami.shown ? 1 : 0
    Behavior on t { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }
    onVisibleChanged: if (visible) view.forceActiveFocus()
    Connections {
        target: Hanami
        function onShownChanged() { if (Hanami.shown) view.forceActiveFocus(); }
    }

    IpcHandler {
        target: "hanami"
        function toggle(): void { Hanami.toggle(); }
        function open(): void { Hanami.open(); }
        function close(): void { Hanami.close(); }
    }

    visible: t > 0
    anchors { left: true; right: true; top: true; bottom: true }
    exclusionMode: ExclusionMode.Ignore
    color: "transparent"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: Hanami.shown ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    WlrLayershell.namespace: "glyph-hanami"

    Rectangle {
        anchors.fill: parent
        color: "#000000"
        opacity: 0.35 * root.t
        MouseArea { anchors.fill: parent; onClicked: Hanami.close() }
    }

    Stage {
        id: stage
        Rectangle {
            id: panel
            anchors { right: parent.right; rightMargin: 14 - 40 * (1 - root.t); top: parent.top; topMargin: 14; bottom: parent.bottom; bottomMargin: 14 }
            width: 780
            opacity: root.t
            radius: Theme.corner(36)
            color: Theme.s1
            border { width: 1; color: Theme.s2 }
            MouseArea {
                anchors.fill: parent
                // a click on the panel itself (not a field) closes an open dropdown and takes the keys back
                onClicked: { Hanami.dd = ""; view.forceActiveFocus(); }
            }
            HanamiView {
                id: view
                anchors.fill: parent
                focus: true
            }
        }
    }
}
