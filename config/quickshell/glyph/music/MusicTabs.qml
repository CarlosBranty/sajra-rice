import QtQuick
import qs
import qs.components

// сегментный переключатель панели музыки: белая заливка переезжает, как у режимов питания.
// opts — [[значение, подпись], ...]. Отдельным файлом: inline component ломает горячую перезагрузку
Rectangle {
    id: root

    required property var opts
    property string value
    signal picked(string v)

    readonly property real cell: (width - 10) / opts.length
    readonly property int at: Math.max(0, opts.findIndex(o => o[0] === value))

    height: 44
    radius: Theme.corner(22)
    color: Theme.s2

    Rectangle {
        x: 5 + root.cell * root.at
        y: 5
        width: root.cell
        height: parent.height - 10
        radius: height / 2
        color: Theme.fg
        Behavior on x { NumberAnimation { duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide } }
    }
    Repeater {
        model: root.opts
        Item {
            required property var modelData
            required property int index
            x: 5 + root.cell * index
            width: root.cell
            height: root.height
            Lb { anchors.centerIn: parent; text: parent.modelData[1]; color: root.value === parent.modelData[0] ? Theme.ink : Theme.grey }
            TapHandler { onTapped: root.picked(parent.modelData[0]) }
            HoverHandler { cursorShape: Qt.PointingHandCursor }
        }
    }
}
