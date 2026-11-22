import QtQuick
import qs

// a look of Hanami's, playing: one sheet of frames Hanami drew (Hanami.sheets) shown a frame at a time, at half its
// pixels (they're drawn at 2x). Plays only while the panel shows; until the sheet comes, the look's name instead
Item {
    id: root

    property string look
    property string form: "default"
    property string fallback: ""
    property int offset: 0   // the frame it starts on, so a row of them doesn't move in step

    readonly property var sheet: Hanami.sheet(look, form)
    readonly property bool ready: !!sheet && img.status === Image.Ready
    property int frame: 0

    implicitWidth: sheet ? sheet.width / 2 : 104
    implicitHeight: sheet ? sheet.height / 2 : 76
    width: implicitWidth
    height: implicitHeight
    clip: true

    onSheetChanged: frame = sheet ? offset % sheet.frames : 0

    Image {
        id: img
        source: root.sheet ? "file://" + root.sheet.file : ""
        asynchronous: true
        cache: false
        smooth: true
        width: root.sheet ? root.sheet.width * root.sheet.columns / 2 : 0
        height: root.sheet ? root.sheet.height * Math.ceil(root.sheet.frames / root.sheet.columns) / 2 : 0
        x: root.sheet ? -(root.frame % root.sheet.columns) * root.width : 0
        y: root.sheet ? -Math.floor(root.frame / root.sheet.columns) * root.height : 0
        visible: root.ready
    }
    Timer {
        interval: root.sheet ? Math.round(1000 / root.sheet.fps) : 1000
        repeat: true
        running: root.ready && root.visible && Hanami.shown
        onTriggered: root.frame = (root.frame + 1) % root.sheet.frames
    }
    Text {
        anchors.centerIn: parent
        width: parent.width - 8
        visible: !root.ready && !!root.fallback
        horizontalAlignment: Text.AlignHCenter
        elide: Text.ElideRight
        text: root.fallback
        textFormat: Text.PlainText
        font { family: Theme.ui; pixelSize: 13 }
        color: Theme.mute
    }
}
