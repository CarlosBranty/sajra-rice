import QtQuick
import qs
import qs.components
import qs.services

// группа в панели музыки: шапка (обложка точками, альбом или папка, исполнитель, число песен, play) и под ней треки.
// Играющий трек — белая пилюля, как «вкл.» у плиток. Отдельным файлом: inline component ломает горячую перезагрузку
Column {
    id: root

    required property var g      // группа: key, name, sub, art, tracks, dur
    required property var hits   // её треки, прошедшие поиск
    property bool open
    property string now          // путь играющего трека
    signal toggled
    signal picked(int i)         // индекс в g.tracks

    readonly property bool live: g.tracks.some(t => t.path === now)

    spacing: 2

    function fileUrl(p) { return p ? "file://" + p.split("/").map(encodeURIComponent).join("/") : ""; }

    Rectangle {
        width: root.width
        height: 64
        radius: Theme.corner(22)
        color: hov.hovered ? Theme.s2 : "transparent"
        Behavior on color { ColorAnimation { duration: Theme.t / 2 } }

        Art { id: art; x: 8; anchors.verticalCenter: parent.verticalCenter; width: 48; height: 48; step: 3; url: root.fileUrl(root.g.art) }
        Column {
            anchors { left: art.right; leftMargin: 12; right: go.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
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
        // шапка целиком — свернуть/развернуть; кнопка play сверху забирает свой тап
        TapHandler { onTapped: root.toggled() }
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
                Lb { anchors.centerIn: parent; visible: !row.cur; px: 11; text: row.modelData.track ? String(row.modelData.track).padStart(2, "0") : "·" }
            }
            Text {
                anchors { left: no.right; leftMargin: 8; right: len.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: row.modelData.title
                font { family: Theme.ui; pixelSize: 14; weight: row.cur ? Font.DemiBold : Font.Normal }
                color: row.cur ? Theme.ink : Theme.fg
            }
            Lb {
                id: len
                anchors { right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter }
                px: 10
                text: row.modelData.dur ? Media.time(row.modelData.dur) : ""
                color: row.cur ? Theme.ink : Theme.grey
            }
            // по пути, не indexOf: модель отдаёт копии объектов, indexOf всегда -1
            TapHandler { onTapped: root.picked(Math.max(0, root.g.tracks.findIndex(t => t.path === row.modelData.path))) }
            HoverHandler { id: rh; cursorShape: Qt.PointingHandCursor }
        }
    }
}
