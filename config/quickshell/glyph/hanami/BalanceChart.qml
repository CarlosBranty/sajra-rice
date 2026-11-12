import QtQuick
import qs
import qs.components

// the balance over time: a line over a faint area down to zero, the zero line in dots (glyph's LEDs), the highest and
// lowest balance on the left, the first and last date under it. points: [{date, balance}] (cents)
Item {
    id: root

    property var points: []
    property var fmt: c => String(c)
    property var day: d => d

    readonly property var vals: points.map(x => x.balance)
    readonly property real hi: points.length ? Math.max(0, ...vals) : 0
    readonly property real lo: points.length ? Math.min(0, ...vals) : 0

    onPointsChanged: cv.requestPaint()

    Text {
        visible: root.points.length < 2
        anchors.centerIn: parent
        text: "Aún no hay suficientes días para una curva."
        font { family: Theme.ui; pixelSize: 13 }
        color: Theme.mute
    }

    Canvas {
        id: cv
        visible: root.points.length >= 2
        anchors { left: parent.left; right: parent.right; top: parent.top; bottom: axis.top; bottomMargin: 6 }
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            const ctx = getContext("2d");
            ctx.reset();
            const p = root.points;
            if (p.length < 2) return;
            const t0 = Date.parse(p[0].date), t1 = Date.parse(p[p.length - 1].date);
            const lo = root.lo, hi = root.hi === root.lo ? root.lo + 1 : root.hi;
            const pad = 6, w = width, h = height - pad * 2;
            const X = d => t1 === t0 ? w / 2 : (Date.parse(d) - t0) / (t1 - t0) * (w - 8) + 4;
            const Y = v => pad + (hi - v) / (hi - lo) * h;
            // zero, in dots
            ctx.fillStyle = Theme.s3;
            for (let x = 2; x < w; x += 8) ctx.fillRect(x, Math.round(Y(0)) - 1, 2, 2);
            // the area down to zero
            ctx.beginPath();
            ctx.moveTo(X(p[0].date), Y(0));
            for (const q of p) ctx.lineTo(X(q.date), Y(q.balance));
            ctx.lineTo(X(p[p.length - 1].date), Y(0));
            ctx.closePath();
            ctx.fillStyle = Qt.rgba(Theme.fg.r, Theme.fg.g, Theme.fg.b, 0.07);
            ctx.fill();
            // the line
            ctx.beginPath();
            p.forEach((q, i) => i ? ctx.lineTo(X(q.date), Y(q.balance)) : ctx.moveTo(X(q.date), Y(q.balance)));
            ctx.strokeStyle = Theme.fg;
            ctx.lineWidth = 2;
            ctx.lineJoin = "round";
            ctx.stroke();
            // today's end of it
            const l = p[p.length - 1];
            ctx.beginPath();
            ctx.arc(X(l.date), Y(l.balance), 4, 0, Math.PI * 2);
            ctx.fillStyle = l.balance < 0 ? Theme.red : Theme.fg;
            ctx.fill();
        }
    }
    Lb {
        visible: cv.visible
        anchors { left: parent.left; top: parent.top }
        text: root.fmt(root.hi)
        px: 9
        color: Theme.mute
    }
    Lb {
        visible: cv.visible && root.lo < 0
        anchors { left: parent.left; bottom: axis.top; bottomMargin: 8 }
        text: root.fmt(root.lo)
        px: 9
        color: Theme.mute
    }
    Item {
        id: axis
        visible: cv.visible
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
        height: 14
        Lb { anchors.left: parent.left; text: root.day(root.points[0]?.date ?? ""); px: 9 }
        Lb { anchors.right: parent.right; text: root.day(root.points[root.points.length - 1]?.date ?? ""); px: 9 }
    }
}
