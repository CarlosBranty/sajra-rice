import QtQuick
import qs
import qs.components

// the music panel's "add to list" card: what is being added, the lists (one that already holds all of it is ticked),
// and a field for a new one; Enter there makes it with these songs. Its own file: an inline component breaks hot reload
Rectangle {
    id: root

    property string what            // the song or album being added
    property var paths: []          // its tracks
    property var lists: []          // [{ name, tracks: [path] }]
    signal picked(int i)            // add to lists[i]
    signal created(string name)     // a new list with these songs
    signal dismissed

    height: col.height + 36
    radius: Theme.corner(30)
    color: Theme.s2
    border { width: 1; color: Theme.s3 }

    function focusField() { name.text = ""; name.take(); }
    function has(l) { return root.paths.length > 0 && root.paths.every(p => l.tracks.includes(p)); }

    // a tap on the card itself stays on it, the panel behind doesn't take it
    TapHandler {}

    Column {
        id: col
        x: 18
        y: 18
        width: parent.width - 36
        spacing: 6

        Item {
            width: parent.width
            height: 40
            Column {
                anchors { left: parent.left; leftMargin: 6; right: shut.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
                Lb { px: 10; text: "add to list" }
                Text {
                    width: parent.width
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: root.what
                    font { family: Theme.ui; pixelSize: 15; weight: Font.DemiBold }
                    color: Theme.fg
                }
            }
            MusicBtn { id: shut; anchors { right: parent.right; verticalCenter: parent.verticalCenter } size: 36; icon: "\u{F0156}"; onClicked: root.dismissed() }
        }

        Repeater {
            model: root.lists
            Rectangle {
                id: row
                required property var modelData
                required property int index
                readonly property bool done: root.has(modelData)
                width: col.width
                height: 44
                radius: Theme.corner(22)
                color: tap.pressed ? Theme.fg : hov.hovered && !done ? Theme.s3 : "transparent"
                Icon {
                    id: mark
                    x: 14
                    anchors.verticalCenter: parent.verticalCenter
                    text: row.done ? "\u{F012C}" : "\u{F0415}"
                    font.pixelSize: 18
                    color: tap.pressed ? Theme.ink : row.done ? Theme.accent : Theme.grey
                }
                Text {
                    anchors { left: mark.right; leftMargin: 12; right: n.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: row.modelData.name
                    font { family: Theme.ui; pixelSize: 14 }
                    color: tap.pressed ? Theme.ink : Theme.fg
                }
                Lb { id: n; anchors { right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter } px: 10; text: row.modelData.tracks.length; color: tap.pressed ? Theme.ink : Theme.grey }
                TapHandler { id: tap; enabled: !row.done; onTapped: root.picked(row.index) }
                HoverHandler { id: hov; cursorShape: row.done ? Qt.ArrowCursor : Qt.PointingHandCursor }
            }
        }

        Item { width: 1; height: 4 }
        MusicField {
            id: name
            width: col.width
            label: root.lists.length ? "or a new list" : "a new list"
            hint: "name · enter"
            onAccepted: if (text.trim()) root.created(text.trim())
            Keys.onEscapePressed: root.dismissed()
        }
    }
}
