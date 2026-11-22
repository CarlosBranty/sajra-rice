import QtQuick
import qs
import qs.components

// spending by account: a ring cut in arcs (glyph greys, the biggest brightest), the period's spending in its middle and
// each account with its share beside it. accounts: [{source, label, spending}] (cents)
Item {
    id: root

    property var accounts: []
    property real total: 0
    property var fmt: c => String(c)

    readonly property var parts: accounts.filter(a => a.spending > 0).sort((a, b) => b.spending - a.spending)
    readonly property real sum: parts.reduce((s, a) => s + a.spending, 0)
    readonly property var shades: [Theme.fg, Theme.grey, Theme.mute, Theme.s3]

    height: Math.max(ring.height, legend.height)
    onPartsChanged: ring.requestPaint()

    Canvas {
        id: ring
        width: 132
        height: 132
        onPaint: {
            const ctx = getContext("2d");
            ctx.reset();
            const c = width / 2, r = c - 9, gap = root.parts.length > 1 ? 0.06 : 0;
            ctx.lineWidth = 12;
            ctx.lineCap = "butt";
            if (!root.sum) return;
            let a = -Math.PI / 2;
            root.parts.forEach((p, i) => {
                const span = p.spending / root.sum * Math.PI * 2;
                ctx.beginPath();
                ctx.arc(c, c, r, a + gap / 2, a + Math.max(span - gap / 2, gap / 2 + 0.01));
                ctx.strokeStyle = root.shades[Math.min(i, root.shades.length - 1)];
                ctx.stroke();
                a += span;
            });
        }
        Column {
            anchors.centerIn: parent
            spacing: 2
            Lb { anchors.horizontalCenter: parent.horizontalCenter; text: "Gastos"; px: 9 }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: root.fmt(root.total || root.sum)
                textFormat: Text.PlainText
                font { family: Theme.mono; pixelSize: 12 }
                color: Theme.fg
            }
        }
    }
    Column {
        id: legend
        anchors { left: ring.right; leftMargin: 24; right: parent.right; verticalCenter: ring.verticalCenter }
        spacing: 10
        Lb { text: "Por cuenta" }
        Repeater {
            model: root.parts
            Item {
                id: leg
                required property var modelData
                required property int index
                width: legend.width
                height: 20
                Rectangle {
                    id: sw
                    anchors.verticalCenter: parent.verticalCenter
                    width: 8
                    height: 8
                    radius: 4
                    color: root.shades[Math.min(leg.index, root.shades.length - 1)]
                    border { width: 1; color: Theme.s3 }
                }
                Text {
                    anchors { left: sw.right; leftMargin: 10; right: val.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
                    text: leg.modelData.label ?? leg.modelData.source
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    font { family: Theme.ui; pixelSize: 14 }
                    color: Theme.fg
                }
                Text {
                    id: val
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    text: `${root.fmt(leg.modelData.spending)}  ${Math.round(leg.modelData.spending / root.sum * 100)}%`
                    textFormat: Text.PlainText
                    font { family: Theme.mono; pixelSize: 12 }
                    color: Theme.grey
                }
            }
        }
    }
}
