import QtQuick
import qs
import qs.components
import qs.services

// группа в панели музыки: шапка (обложка точками, альбом или папка, исполнитель, число песен, play) и под ней треки.
// Играющий трек — белая пилюля, как «вкл.» у плиток. Отдельным файлом: inline component ломает горячую перезагрузку.
// + under the pointer adds the song (or, on the header, the whole group) to a list; in a list (g.list) it is − instead,
// and the header's bin deletes the list on a second tap
Column {
    id: root

    required property var g      // группа: key, name, sub, art, tracks, dur
    required property var hits   // её треки, прошедшие поиск
    property bool open
    property string now          // путь играющего трека
    property var listed: ({})    // paths some list holds: a tick on their row
    signal toggled
    signal picked(int i)         // индекс в g.tracks
    signal add(var paths, string what) // to a list: the picker opens
    signal drop(int i)           // in a list: take its i-th song out
    signal remove                // in a list: delete it

    readonly property bool isList: g.list !== undefined
    property bool sure: false    // the bin was tapped once
    onSureChanged: if (sure) unsure.restart()
    Timer { id: unsure; interval: 2500; onTriggered: root.sure = false }

    readonly property bool live: g.tracks.some(t => t.path === now)

    spacing: 2

    function fileUrl(p) {
        if (!p) return "";
        return /^https?:\/\//.test(p) ? p : "file://" + p.split("/").map(encodeURIComponent).join("/");
    }

    Rectangle {
        width: root.width
        height: 64
        radius: Theme.corner(22)
        color: hov.hovered ? Theme.s2 : "transparent"
        Behavior on color { ColorAnimation { duration: Theme.t / 2 } }

        Art { id: art; x: 8; anchors.verticalCenter: parent.verticalCenter; width: 48; height: 48; step: 3; url: root.fileUrl(root.g.art) }
        Column {
            anchors { left: art.right; leftMargin: 12; right: more.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
            spacing: 2
            Text {
                width: parent.width
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: root.g.name
                font { family: Theme.ui; pixelSize: 15; weight: Font.DemiBold }
                color: root.live ? Theme.accent : Theme.fg
            }
            Lb {
                width: parent.width
                elide: Text.ElideRight
                px: 10
                text: `${root.g.sub ? root.g.sub + " · " : ""}${root.hits.length < root.g.tracks.length ? root.hits.length + "/" : ""}${root.g.tracks.length} songs`
            }
        }
        // + the whole group to a list; in a list, the bin: red on the first tap, the second deletes
        Rectangle {
            id: more
            anchors { right: go.left; rightMargin: 4; verticalCenter: parent.verticalCenter }
            width: 32
            height: 32
            radius: 16
            visible: hov.hovered || root.sure
            color: root.sure ? Theme.red : moreTap.pressed ? Theme.fg : moreHov.hovered ? Theme.s3 : "transparent"
            Icon {
                anchors.centerIn: parent
                text: root.isList ? "\u{F09E7}" : "\u{F0415}"
                font.pixelSize: 17
                color: root.sure ? Theme.bg : moreTap.pressed ? Theme.ink : Theme.grey
            }
            TapHandler {
                id: moreTap
                onTapped: {
                    if (!root.isList) return root.add(root.g.tracks.map(t => t.path), root.g.name);
                    if (root.sure) { root.sure = false; root.remove(); } else root.sure = true;
                }
            }
            HoverHandler { id: moreHov; cursorShape: Qt.PointingHandCursor }
        }
        Rectangle {
            id: go
            anchors { right: chev.left; rightMargin: 6; verticalCenter: parent.verticalCenter }
            width: 36
            height: 36
            radius: 18
            color: goTap.pressed ? Theme.fg : Theme.s3
            Icon { anchors.centerIn: parent; text: "\u{F040A}"; font.pixelSize: 18; color: goTap.pressed ? Theme.ink : Theme.fg }
            TapHandler { id: goTap; onTapped: root.picked(0) }
            HoverHandler { cursorShape: Qt.PointingHandCursor }
        }
        Icon {
            id: chev
            anchors { right: parent.right; rightMargin: 10; verticalCenter: parent.verticalCenter }
            text: "\u{F0140}"
            font.pixelSize: 18
            opacity: 0.5
            rotation: root.open ? 180 : 0
            Behavior on rotation { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }
        }
        // шапка целиком — свернуть/развернуть; a tap on + or play is theirs (the handlers here all see it)
        TapHandler {
            onTapped: e => {
                for (const b of [more, go]) if (b.visible && b.contains(b.mapFromItem(parent, e.position))) return;
                root.toggled();
            }
        }
        HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
    }

    Repeater {
        model: root.open ? root.hits : []
        Rectangle {
            id: row
            required property var modelData
            readonly property bool cur: modelData.path === root.now
            width: root.width
            height: 40
            radius: Theme.corner(20)
            color: cur ? Theme.fg : rh.hovered ? Theme.s2 : "transparent"

            Item {
                id: no
                x: 12
                width: 30
                height: parent.height
                Icon { anchors.centerIn: parent; visible: row.cur; text: Media.playing ? "\u{F057E}" : "\u{F03E4}"; font.pixelSize: 16; color: Theme.ink }
                Lb { anchors.centerIn: parent; visible: !row.cur; px: 11; text: root.isList ? String(root.g.tracks.findIndex(t => t.path === row.modelData.path) + 1).padStart(2, "0") // its place in the list
                    : row.modelData.track ? String(row.modelData.track).padStart(2, "0") : "·" }
            }
            Text {
                anchors { left: no.right; leftMargin: 8; right: pick.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: row.modelData.title
                font { family: Theme.ui; pixelSize: 14; weight: row.cur ? Font.DemiBold : Font.Normal }
                color: row.cur ? Theme.ink : Theme.fg
            }
            // + to a list, − out of this one; only under the pointer
            Item {
                id: pick
                anchors { right: len.left; rightMargin: 6; verticalCenter: parent.verticalCenter }
                width: 28
                height: 28
                Rectangle {
                    anchors.fill: parent
                    radius: 14
                    visible: rh.hovered
                    color: pickTap.pressed ? (row.cur ? Theme.ink : Theme.fg) : pickHov.hovered ? Theme.s3 : "transparent"
                    Icon {
                        anchors.centerIn: parent
                        text: root.isList ? "\u{F0374}" : "\u{F0415}"
                        font.pixelSize: 16
                        color: pickTap.pressed ? (row.cur ? Theme.fg : Theme.ink) : row.cur ? Theme.ink : Theme.grey
                    }
                }
                TapHandler {
                    id: pickTap
                    enabled: rh.hovered
                    onTapped: {
                        const i = Math.max(0, root.g.tracks.findIndex(t => t.path === row.modelData.path));
                        if (root.isList) root.drop(i);
                        else root.add([row.modelData.path], row.modelData.title);
                    }
                }
                // already in a list: a tick where the + shows under the pointer (not inside a list, all of them are)
                Icon {
                    anchors.centerIn: parent
                    visible: !rh.hovered && !root.isList && !!root.listed[row.modelData.path]
                    text: "\u{F012C}"
                    font.pixelSize: 16
                    color: row.cur ? Theme.ink : Theme.accent
                }
                HoverHandler { id: pickHov; cursorShape: Qt.PointingHandCursor }
            }
            Lb {
                id: len
                anchors { right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter }
                px: 10
                text: row.modelData.dur ? Media.time(row.modelData.dur) : ""
                color: row.cur ? Theme.ink : Theme.grey
            }
            // по пути, не indexOf: модель отдаёт копии объектов, indexOf всегда -1
            // a tap on + or − is theirs: every handler here sees it, and the song would play too
            TapHandler {
                onTapped: e => {
                    if (pick.contains(pick.mapFromItem(row, e.position))) return;
                    root.picked(Math.max(0, root.g.tracks.findIndex(t => t.path === row.modelData.path)));
                }
            }
            HoverHandler { id: rh; cursorShape: Qt.PointingHandCursor }
        }
    }
}
