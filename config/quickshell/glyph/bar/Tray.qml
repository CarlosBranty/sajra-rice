import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Services.SystemTray
import Quickshell.Widgets
import qs
import qs.components

// apps in the tray (StatusNotifierItem: Hanami, Telegram, Steam…): a capsule with a dot and how many there are. A click
// opens it in place — the icons slide out inside the bar, grey like the rest of it; another click on the dot folds it.
// Icon: click opens the app, right click its menu, middle click its second action, wheel its own scroll. An app that only
// has a menu opens it on a click too. The menu is drawn here, as a glyph card (the app's own platform menu needs qs in
// QApplication mode): its entries, ticks, submenus with a way back. It closes once the pointer has left it and the
// capsule for 0.7 s, as the battery card does (Hyprland's focus grab never cleared here, on any click). Nothing in the tray — the
// capsule is not drawn. Its own file, not an inline component in Bar.qml: a new inline component breaks hot reload
// there («is not a type») until qs restarts
Rectangle {
    id: root

    required property var window // the bar: menus open next to it
    readonly property bool vert: Theme.state.barAt !== "top"
    // what an app asks to hide (Passive) stays out; one that needs attention (NeedsAttention) is drawn first
    readonly property var items: SystemTray.items.values.filter(i => i.status !== Status.Passive)
        .sort((a, b) => (b.status === Status.NeedsAttention) - (a.status === Status.NeedsAttention))
    readonly property bool alert: items.some(i => i.status === Status.NeedsAttention)
    property bool open: false
    property real t: open ? 1 : 0
    Behavior on t { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }

    visible: items.length > 0
    onItemsChanged: if (!items.length) open = false
    onOpenChanged: if (!open) closeMenu()
    // the capsule grows along the bar: the dot's 44 plus the icons as they slide out
    readonly property real run: 44 + t * items.length * 40
    width: vert ? 44 : run
    height: vert ? run : 44
    radius: Theme.corner(22)
    color: open ? Theme.s2 : "transparent"
    border { width: 1; color: open ? Theme.s3 : Theme.s2 }
    Behavior on color { ColorAnimation { duration: Theme.t } }
    clip: true

    // the dot: the count, or the fold once open. Red while an app asks for attention
    Item {
        id: dot
        width: 44
        height: 44
        Rectangle {
            anchors.centerIn: parent
            visible: root.open
            width: 8
            height: 8
            radius: 4
            color: Theme.fg
        }
        Num {
            anchors.centerIn: parent
            visible: !root.open
            text: root.items.length
            font.pixelSize: 26
            color: root.alert ? Theme.red : Theme.fg
        }
        TapHandler { onTapped: root.open = !root.open }
        HoverHandler { cursorShape: Qt.PointingHandCursor }
    }

    Pile {
        x: root.vert ? 0 : 44
        y: root.vert ? 44 : 0
        opacity: root.t
        spacing: 0
        Repeater {
            model: root.items
            Item {
                id: app
                required property var modelData
                width: root.vert ? 44 : 40
                height: root.vert ? 40 : 44
                // grey like the bar's own icons, full colour under the pointer
                IconImage {
                    id: ico
                    anchors.centerIn: parent
                    implicitSize: 22
                    source: app.modelData.icon
                    layer.enabled: !hov.hovered
                    layer.effect: MultiEffect { saturation: -1; brightness: Theme.light ? -0.15 : 0.1 }
                }
                // an app that needs attention: a red dot under it
                Rectangle {
                    visible: app.modelData.status === Status.NeedsAttention
                    anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: 3 }
                    width: 5
                    height: 5
                    radius: 2.5
                    color: Theme.red
                }
                HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
                MouseArea {
                    anchors.fill: parent
                    acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
                    onClicked: e => {
                        const it = app.modelData;
                        if (e.button === Qt.MiddleButton) it.secondaryActivate();
                        else if (e.button === Qt.RightButton || it.onlyMenu) root.menu(it, app);
                        else it.activate();
                    }
                    onWheel: e => app.modelData.scroll(e.angleDelta.y || e.angleDelta.x, e.angleDelta.y === 0)
                }
            }
        }
    }

    // ---- the app's menu: a card next to the icon; the path is the submenus opened, the last one shown ----
    property var menuOf: null // the tray item whose menu is open
    property var path: []
    property point menuAt
    function menu(it, at) {
        if (!it.hasMenu) return;
        if (menuOf === it) return closeMenu();
        menuAt = at.mapToItem(root, root.vert ? at.width : 0, root.vert ? 0 : at.height);
        path = [];
        menuOf = it;
    }
    function closeMenu() { menuOf = null; path = []; }
    readonly property real k: Theme.barK(window.screen)

    QsMenuOpener { id: opener; menu: root.path.length ? root.path[root.path.length - 1] : root.menuOf?.menu ?? null }
    HoverHandler { id: capHov }
    Timer { running: !!root.menuOf && !capHov.hovered && !cardHov.hovered; interval: 700; onTriggered: root.closeMenu() }

    PopupWindow {
        id: pop
        visible: !!root.menuOf
        anchor.item: root
        anchor.rect: root.vert ? Qt.rect(root.menuAt.x + 14, root.menuAt.y, 1, 1) : Qt.rect(root.menuAt.x, root.menuAt.y + 14, 1, 1)
        anchor.edges: Edges.Top | Edges.Left
        anchor.gravity: Edges.Bottom | Edges.Right
        implicitWidth: Math.ceil(card.width * root.k)
        implicitHeight: Math.ceil(card.height * root.k)
        color: "transparent"

        Stage {
            k: root.k
            Rectangle {
                id: card
                width: 380
                height: list.height + 24
                radius: Theme.corner(28)
                color: Theme.s1
                border { width: 1; color: Theme.s2 }
                HoverHandler { id: cardHov }

                Column {
                    id: list
                    x: 12
                    y: 12
                    width: parent.width - 24

                    // the app's name; inside a submenu, the way back
                    Item {
                        width: parent.width
                        height: 44
                        Lb {
                            anchors { left: parent.left; leftMargin: 14; verticalCenter: parent.verticalCenter }
                            text: root.path.length ? "‹ back" : (root.menuOf?.tooltipTitle || root.menuOf?.title || root.menuOf?.id || "")
                            px: 10
                            color: root.path.length && backHov.hovered ? Theme.fg : Theme.grey
                        }
                        HoverHandler { id: backHov; enabled: root.path.length > 0; cursorShape: Qt.PointingHandCursor }
                        TapHandler { enabled: root.path.length > 0; onTapped: root.path = root.path.slice(0, -1) }
                    }

                    Repeater {
                        model: opener.children
                        Item {
                            id: row
                            required property var modelData
                            readonly property var e: modelData
                            width: list.width
                            height: e.isSeparator ? 13 : 46
                            opacity: e.enabled ? 1 : 0.4

                            Rectangle {
                                visible: row.e.isSeparator
                                anchors.centerIn: parent
                                width: parent.width - 28
                                height: 1
                                color: Theme.s3
                            }
                            Rectangle {
                                visible: !row.e.isSeparator
                                anchors.fill: parent
                                radius: Theme.corner(23)
                                color: tap.pressed ? Theme.fg : rowHov.hovered && row.e.enabled ? Theme.s2 : "transparent"
                            }
                            // a tick or a radio: a dot that fills when on
                            Rectangle {
                                visible: !row.e.isSeparator && row.e.buttonType !== QsMenuButtonType.None
                                x: 16
                                anchors.verticalCenter: parent.verticalCenter
                                width: 10
                                height: 10
                                radius: row.e.buttonType === QsMenuButtonType.RadioButton ? 5 : 2
                                color: row.e.checkState === Qt.Checked ? (tap.pressed ? Theme.ink : Theme.fg) : "transparent"
                                border { width: 1; color: tap.pressed ? Theme.ink : Theme.grey }
                            }
                            Text {
                                visible: !row.e.isSeparator
                                anchors { left: parent.left; leftMargin: row.e.buttonType !== QsMenuButtonType.None ? 40 : 16; right: more.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
                                elide: Text.ElideRight
                                text: row.e.text.replace(/_(?=\S)/, "") // a mnemonic's underscore
                                textFormat: Text.PlainText
                                font { family: Theme.ui; pixelSize: 17 }
                                color: tap.pressed ? Theme.ink : Theme.fg
                            }
                            Lb {
                                id: more
                                visible: row.e.hasChildren
                                anchors { right: parent.right; rightMargin: 16; verticalCenter: parent.verticalCenter }
                                text: "›"
                                px: 14
                                color: tap.pressed ? Theme.ink : Theme.grey
                            }
                            HoverHandler { id: rowHov; enabled: !row.e.isSeparator; cursorShape: Qt.PointingHandCursor }
                            TapHandler {
                                id: tap
                                enabled: !row.e.isSeparator && row.e.enabled
                                onTapped: {
                                    if (row.e.hasChildren) { root.path = root.path.concat([row.e]); return; }
                                    row.e.triggered();
                                    root.closeMenu();
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
