import QtQuick
import qs
import qs.components

// Money's overview (contract S12): the periods from one salary to the next, the period's balance with what it carried in,
// its income and spending, the balance over time, spending by account and the movements by week. A movement opens the
// edit sheet in its place (MoneyEdit); Esc closes it first (Hanami.back)
Column {
    id: root
    objectName: "moneyOverview"

    readonly property var o: Hanami.oview
    readonly property var p: o?.period ?? null
    readonly property string main: o?.currency ?? "PEN"
    readonly property var others: (p?.by_currency ?? []).filter(c => c.currency !== main && (c.income || c.spending || c.carry_in || c.balance))
    readonly property var labels: Hanami.dict((o?.accounts ?? []).map(a => [a.source, a.label]))
    readonly property bool empty: !!o && !(o.weeks ?? []).some(w => (w.items ?? []).length)

    width: parent?.width ?? 0
    spacing: 16

    // ---- what the page does (the controls call these) ----
    function pickPeriod(start) {
        if (start === (p?.start ?? "")) return;
        Hanami.operiod = start;
        Hanami.oedit = null;
        Hanami.overviewAsk();
    }
    function pickRange(r) {
        if (r === Hanami.orange) return;
        Hanami.orange = r;
        Hanami.overviewAsk();
    }
    function open(it) {
        Hanami.dd = "";
        Hanami.oedit = it;
        // the sheet takes the movements' place: back to the top of the page so it's in view
        for (let f = root.parent; f; f = f.parent)
            if (f.contentY !== undefined) { f.contentY = 0; break; }
    }

    // S/ 1,234.50 (cents in; − before it when negative)
    function fmt(c, cur) {
        const sym = ({ PEN: "S/", USD: "US$", EUR: "€" })[cur] ?? cur ?? "";
        const n = (Math.abs(c ?? 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return `${c < 0 ? "−" : ""}${sym} ${n}`;
    }
    readonly property var mon: ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"]
    function day(d) { return d ? `${Number(d.slice(8, 10))} ${mon[Number(d.slice(5, 7)) - 1]}` : ""; }
    function isIncome(it) { return it?.kind === "income"; }

    Text {
        visible: !root.o
        text: Hanami.linked ? "Cargando…" : ""
        font { family: Theme.ui; pixelSize: 14 }
        color: Theme.mute
    }

    // ================================================================ the edit sheet, in place of the rest
    MoneyEdit {
        objectName: "moneyEdit"
        visible: !!root.o && !!Hanami.oedit
        cats: root.o?.categories ?? []
        labels: root.labels
        page: root
    }

    Column {
        visible: !!root.o && !Hanami.oedit
        width: parent.width
        spacing: 16

        // ---- the periods: from one salary to the day before the next ----
        ListView {
            id: strip
            width: parent.width
            height: 36
            orientation: ListView.Horizontal
            spacing: 6
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            model: root.o?.periods ?? []
            readonly property int cur: (root.o?.periods ?? []).findIndex(x => x.start === root.p?.start)
            onCurChanged: if (cur >= 0) positionViewAtIndex(cur, ListView.Contain)
            onCountChanged: if (cur >= 0) positionViewAtIndex(cur, ListView.Contain)
            delegate: Rectangle {
                id: chip
                required property var modelData
                required property int index
                readonly property bool on: index === strip.cur
                width: chipRow.implicitWidth + 28
                height: 36
                radius: Theme.corner(18)
                color: on ? Theme.fg : ch.hovered ? Theme.s3 : Theme.s2
                Behavior on color { ColorAnimation { duration: Theme.t / 2 } }
                Accessible.role: Accessible.RadioButton
                Accessible.name: `Periodo del ${root.day(modelData.start)} al ${root.day(modelData.end)}${modelData.salary ? ", desde un sueldo" : ""}`
                Accessible.checked: on
                Row {
                    id: chipRow
                    anchors.centerIn: parent
                    spacing: 8
                    // started by a salary marked as such (not the assumed 26th)
                    Rectangle {
                        visible: !!chip.modelData.salary
                        anchors.verticalCenter: parent.verticalCenter
                        width: 6
                        height: 6
                        radius: 3
                        color: chip.on ? Theme.ink : Theme.fg
                    }
                    Lb { text: `${root.day(chip.modelData.start)} – ${root.day(chip.modelData.end)}`; px: 11; color: chip.on ? Theme.ink : Theme.fg }
                }
                HoverHandler { id: ch; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: root.pickPeriod(chip.modelData.start) }
            }
        }

        // ---- the balance ----
        Rectangle {
            width: parent.width
            height: bal.height + 40
            radius: Theme.corner(28)
            color: Theme.s1
            border { width: 1; color: Theme.s2 }
            Column {
                id: bal
                x: 24
                y: 20
                width: parent.width - 48
                spacing: 10
                Row {
                    width: parent.width
                    Lb { text: "Saldo"; width: parent.width - endLb.width }
                    Lb { id: endLb; text: root.p ? `hasta ${root.day(root.p.end)}` : ""; color: Theme.mute }
                }
                Num {
                    width: parent.width
                    text: root.fmt(root.p?.balance ?? 0, root.main)
                    font.pixelSize: 52
                    fontSizeMode: Text.HorizontalFit
                    minimumPixelSize: 28
                    color: (root.p?.balance ?? 0) < 0 ? Theme.red : Theme.fg
                    Accessible.name: `Saldo ${text}`
                }
                Text {
                    width: parent.width
                    text: `${root.fmt(root.p?.carry_in ?? 0, root.main)} del periodo anterior`
                    textFormat: Text.PlainText
                    font { family: Theme.ui; pixelSize: 13 }
                    color: Theme.grey
                }
                Text {
                    visible: root.others.length > 0
                    width: parent.width
                    wrapMode: Text.Wrap
                    text: root.others.map(c => `${root.fmt(c.balance, c.currency)} (entra ${root.fmt(c.income, c.currency)}, sale ${root.fmt(c.spending, c.currency)})`).join(" · ")
                    textFormat: Text.PlainText
                    font { family: Theme.mono; pixelSize: 12 }
                    color: Theme.grey
                }
            }
        }

        // ---- income and spending ----
        Row {
            width: parent.width
            spacing: 12
            Repeater {
                model: [["Ingresos", root.p?.income ?? 0, true], ["Gastos", root.p?.spending ?? 0, false]]
                Rectangle {
                    id: card
                    required property var modelData
                    width: (parent.width - 12) / 2
                    height: 104
                    radius: Theme.corner(24)
                    color: Theme.s1
                    border { width: 1; color: Theme.s2 }
                    Column {
                        x: 20
                        y: 18
                        width: parent.width - 40
                        spacing: 12
                        Row {
                            spacing: 8
                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width: 6
                                height: 6
                                radius: 3
                                color: card.modelData[2] ? Theme.fg : Theme.mute
                            }
                            Lb { text: card.modelData[0] }
                        }
                        Num {
                            width: parent.width
                            text: root.fmt(card.modelData[1], root.main)
                            font.pixelSize: 30
                            fontSizeMode: Text.HorizontalFit
                            minimumPixelSize: 26
                            Accessible.name: `${card.modelData[0]} ${text}`
                        }
                    }
                }
            }
        }

        // ---- the balance over time ----
        Rectangle {
            width: parent.width
            height: chartCol.height + 36
            radius: Theme.corner(24)
            color: Theme.s1
            border { width: 1; color: Theme.s2 }
            Column {
                id: chartCol
                x: 20
                y: 18
                width: parent.width - 40
                spacing: 12
                Item {
                    width: parent.width
                    height: 30
                    Lb { anchors.verticalCenter: parent.verticalCenter; text: "Saldo en el tiempo" }
                    Row {
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        spacing: 4
                        Repeater {
                            model: [["1m", "1M"], ["3m", "3M"], ["6m", "6M"], ["1y", "1A"]]
                            Rectangle {
                                id: rc
                                required property var modelData
                                readonly property bool on: Hanami.orange === modelData[0]
                                width: 40
                                height: 28
                                radius: Theme.corner(14)
                                color: on ? Theme.fg : rh.hovered ? Theme.s3 : Theme.s2
                                Accessible.role: Accessible.RadioButton
                                Accessible.name: `Rango ${modelData[1]}`
                                Accessible.checked: on
                                Lb { anchors.centerIn: parent; text: rc.modelData[1]; px: 10; color: rc.on ? Theme.ink : Theme.fg }
                                HoverHandler { id: rh; cursorShape: Qt.PointingHandCursor }
                                TapHandler { onTapped: root.pickRange(rc.modelData[0]) }
                            }
                        }
                    }
                }
                BalanceChart {
                    width: parent.width
                    height: 150
                    points: root.o?.series?.points ?? []
                    fmt: c => root.fmt(c, root.main)
                    day: d => root.day(d)
                }
            }
        }

        // ---- spending by account ----
        Rectangle {
            visible: (root.o?.accounts ?? []).some(a => a.spending > 0)
            width: parent.width
            height: ringRow.height + 36
            radius: Theme.corner(24)
            color: Theme.s1
            border { width: 1; color: Theme.s2 }
            SpendRing {
                id: ringRow
                x: 20
                y: 18
                width: parent.width - 40
                accounts: root.o?.accounts ?? []
                total: root.p?.spending ?? 0
                fmt: c => root.fmt(c, root.main)
            }
        }

        // ---- the movements, by week ----
        Text {
            visible: root.empty
            width: parent.width
            wrapMode: Text.Wrap
            text: "Sin movimientos en este periodo: llegan de los correos de tu banco, o agrégalos a mano."
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Repeater {
            model: root.o?.weeks ?? []
            Column {
                id: week
                required property var modelData
                visible: (modelData.items ?? []).length > 0
                width: root.width
                spacing: 2
                Lb {
                    text: `${root.day(week.modelData.from)} – ${root.day(week.modelData.to)}`
                    topPadding: 8
                    bottomPadding: 4
                }
                Repeater {
                    model: week.modelData.items ?? []
                    Rectangle {
                        id: row
                        required property var modelData
                        readonly property var it: modelData
                        readonly property bool inc: root.isIncome(it)
                        width: week.width
                        height: row.it.note ? 76 : 62
                        radius: Theme.corner(16)
                        color: rowHov.hovered || activeFocus ? Theme.s2 : "transparent"
                        activeFocusOnTab: true
                        Accessible.role: Accessible.Button
                        Accessible.name: `${it.description}, ${inc ? "ingreso" : "gasto"} de ${root.fmt(it.amount, it.currency)}, ${root.day(it.date)}. Editar`
                        Keys.onPressed: e => {
                            if (e.key !== Qt.Key_Space && e.key !== Qt.Key_Return && e.key !== Qt.Key_Enter) return;
                            root.open(row.it);
                            e.accepted = true;
                        }
                        Lb {
                            id: dateLb
                            x: 12
                            width: 58
                            anchors.verticalCenter: parent.verticalCenter
                            text: root.day(row.it.date)
                            px: 10
                        }
                        Column {
                            anchors { left: dateLb.right; leftMargin: 8; right: amt.left; rightMargin: 12; verticalCenter: parent.verticalCenter }
                            spacing: 3
                            Text {
                                width: parent.width
                                text: row.it.description || "Sin descripción"
                                textFormat: Text.PlainText
                                elide: Text.ElideRight
                                font { family: Theme.ui; pixelSize: 15 }
                                color: Theme.fg
                            }
                            Text {
                                visible: !!row.it.note
                                width: parent.width
                                text: row.it.note ?? ""
                                textFormat: Text.PlainText
                                elide: Text.ElideRight
                                font { family: Theme.ui; pixelSize: 12; italic: true }
                                color: Theme.grey
                            }
                            Text {
                                width: parent.width
                                text: [row.inc ? "Ingreso" : row.it.kind === "other" ? "No cuenta" : row.it.category ?? "Sin categoría", root.labels[row.it.source] ?? (row.it.source === "manual" ? "A mano" : row.it.source)].join(" · ")
                                textFormat: Text.PlainText
                                elide: Text.ElideRight
                                font { family: Theme.ui; pixelSize: 12 }
                                color: row.it.kind === "expense" && !row.it.category ? Theme.mute : Theme.grey
                            }
                        }
                        Column {
                            id: amt
                            anchors { right: parent.right; rightMargin: 12; verticalCenter: parent.verticalCenter }
                            spacing: 4
                            Text {
                                anchors.right: parent.right
                                text: `${row.inc ? "+" : ""}${root.fmt(row.it.amount, row.it.currency)}`
                                textFormat: Text.PlainText
                                font { family: Theme.mono; pixelSize: 14; weight: row.inc ? Font.Bold : Font.Normal }
                                color: row.it.kind === "other" ? Theme.grey : Theme.fg // income stands out by its "+" and weight: the accent (red in glyph) means alarm
                            }
                            Row {
                                anchors.right: parent.right
                                spacing: 6
                                visible: !!row.it.salary || !!row.it.edited
                                Tag { visible: !!row.it.salary; text: "Sueldo"; strong: true }
                                Tag { visible: !!row.it.edited; text: "Editado" }
                            }
                        }
                        HoverHandler { id: rowHov; cursorShape: Qt.PointingHandCursor }
                        TapHandler { onTapped: root.open(row.it) }
                    }
                }
            }
        }
    }
}
