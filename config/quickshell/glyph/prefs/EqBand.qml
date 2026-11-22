import QtQuick
import qs
import qs.components

// one band of the SPEAKERS EQ: a column of 13 dots (−6…+6 dB), lit from the centre to the value, the value in Doto on
// top, the frequency in a chip below (white while focused). Drag, wheel or ↑↓; put(x) on every step
Column {
    id: band

    property string label
    property real value
    property real v: value
    signal put(real x)

    onValueChanged: if (!drag.pressed) v = value
    function set(x) {
        x = Math.max(-6, Math.min(6, Math.round(x)));
        if (x === v) return;
        v = x;
        put(x);
    }
    function db(x) { const r = Math.round(x); return (r > 0 ? "+" : "") + r; }

    spacing: 8
    activeFocusOnTab: true
    Keys.onPressed: e => {
        if (e.key === Qt.Key_Up || e.key === Qt.Key_Right) set(v + 1);
        else if (e.key === Qt.Key_Down || e.key === Qt.Key_Left) set(v - 1);
        else return;
        e.accepted = true;
    }

    Num { anchors.horizontalCenter: parent.horizontalCenter; text: band.db(band.v); font.pixelSize: 26 }
    Item {
        anchors.horizontalCenter: parent.horizontalCenter
        width: 44
        height: 13 * 14
        Repeater {
            model: 13
            Rectangle {
                required property int index
                readonly property int db: 6 - index
                readonly property bool lit: db === 0 || (band.v > 0 ? db > 0 && db <= band.v : db < 0 && db >= band.v)
                x: (44 - width) / 2
                y: index * 14 + (14 - height) / 2
                width: db === band.v ? 14 : 8
                height: width
                radius: width / 2
                color: lit ? Theme.fg : Theme.s3
            }
        }
        MouseArea {
            id: drag
            anchors.fill: parent
            preventStealing: true
            property real acc: 0
            function at(y) { band.set(6 - Math.floor(y / 14)); }
            onPressed: e => { band.forceActiveFocus(); at(e.y); }
            onPositionChanged: e => at(e.y)
            onWheel: w => {
                acc += w.angleDelta.y;
                while (Math.abs(acc) >= 120) { band.set(band.v + Math.sign(acc)); acc -= Math.sign(acc) * 120; }
            }
        }
    }
    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        width: lab.implicitWidth + 16
        height: lab.implicitHeight + 10
        radius: height / 2
        color: band.activeFocus ? Theme.fg : "transparent"
        Lb { id: lab; anchors.centerIn: parent; text: band.label; px: 10; color: band.activeFocus ? Theme.ink : Theme.grey }
    }
}
