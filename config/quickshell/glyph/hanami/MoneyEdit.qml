import QtQuick
import qs
import qs.components

// the edit sheet of one movement (Hanami.oedit, its row as the overview sent it), in the page where the movements were.
// Only what changed is sent (edit_entry); a movement read from a bank mail keeps its original and asks for the user's
// fingerprint or password first (the sidecar asks, the card shows by Hanami). Salary is set at once (set_salary); a
// corrected one goes back to its original (revert_entry); one added by hand can be deleted (delete_entry)
Rectangle {
    id: root

    property var cats: []
    property var labels: ({})
    property var page: null // MoneyOverview: fmt, day, isIncome

    readonly property var it: Hanami.oedit
    readonly property var f: Hanami.oform
    readonly property bool manual: it?.source === "manual"
    readonly property string kind0: it?.kind === "income" ? "income" : it?.kind === "other" ? "other" : "expense"
    readonly property bool wasIncome: !!page && page.isIncome(it)
    // editable: true (everything), false, a list of fields or { field: bool }
    function can(field) {
        const e = it?.editable;
        if (field === "kind") return manual && kind0 !== "other"; // only one added by hand switches income ↔ expense
        if (e === undefined || e === true) return true;
        if (Array.isArray(e)) return e.includes(field);
        return !!(e && typeof e === "object" && e[field]);
    }
    readonly property bool any: ["amount", "currency", "date", "description", "category", "kind", "note"].some(k => can(k))

    // whether saving these changes asks for the fingerprint: a protected movement (read from a bank mail) whose amount,
    // currency, date or description changes, or whose category changes from one it had; a note or a first category doesn't
    function asks(ch) {
        if (!it?.protected) return false;
        return ["amount", "currency", "date", "description", "kind"].some(k => k in ch) || ("category" in ch && !!it.category);
    }
    // the same, for what the form holds now (the line above the form says it)
    readonly property bool willAsk: {
        const x = f, i = it;
        if (!i?.protected || !x) return false;
        const c = cents(x.amount);
        return (c !== null && c !== Math.abs(i.amount ?? 0)) || x.currency !== i.currency || x.date !== i.date
            || String(x.description ?? "").trim() !== (i.description ?? "")
            || (x.kind === "expense" && !!i.category && (x.category || null) !== i.category);
    }

    width: parent?.width ?? 0
    height: col.height + 44
    radius: Theme.corner(28)
    color: Theme.s1
    border { width: 1; color: Theme.s2 }

    function set(patch) { Hanami.oform = Object.assign({}, Hanami.oform, patch); }
    // a fresh form for every movement opened
    property var shownId: null
    onItChanged: {
        if (!it) { shownId = null; return; }
        if (it.id === shownId) return; // the same one changed (its salary mark): the form stays as typed
        shownId = it.id;
        Hanami.oform = {
            kind: it.kind === "income" ? "income" : it.kind === "other" ? "other" : "expense",
            amount: (Math.abs(it.amount ?? 0) / 100).toFixed(2),
            currency: it.currency ?? "PEN",
            date: it.date ?? "",
            description: it.description ?? "",
            category: it.category ?? "",
            note: it.note ?? ""
        };
        enter.restart();
    }
    // "20,5" → 2050; null when it isn't an amount
    function cents(s) {
        s = String(s ?? "").trim();
        if (!/^\d{1,9}([.,]\d{1,2})?$/.test(s)) return null;
        const c = Math.round(Number(s.replace(",", ".")) * 100);
        return c > 0 ? c : null;
    }
    function validDate(d) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        const t = new Date(`${d}T12:00:00`);
        return !isNaN(t) && Qt.formatDate(t, "yyyy-MM-dd") === d;
    }
    function shift(n) {
        const d = validDate(f.date) ? new Date(`${f.date}T12:00:00`) : new Date();
        d.setDate(d.getDate() + n);
        set({ date: Qt.formatDate(d, "yyyy-MM-dd") });
    }
    // the fields that changed, as edit_entry takes them; null when one isn't valid (and focus goes to it)
    function changes() {
        const out = {}, c = cents(f.amount);
        if (can("amount")) {
            if (c === null) { Hanami.note("Escribe el monto así: 20.50", true); amountF.focus_(); return null; }
            if (c !== Math.abs(it.amount)) out.amount = (c / 100).toFixed(2);
        }
        if (can("currency") && f.currency !== it.currency) out.currency = f.currency;
        if (can("date") && f.date !== it.date) {
            if (!validDate(f.date)) { Hanami.note("La fecha va así: 2026-11-12", true); dateF.focus_(); return null; }
            out.date = f.date;
        }
        const desc = String(f.description ?? "").trim();
        if (can("description") && desc !== (it.description ?? "")) {
            if (!desc) { descF.focus_(); return null; }
            out.description = desc;
        }
        const note = String(f.note ?? "").trim();
        if (can("note") && note !== (it.note ?? "")) out.note = note || null;
        if (can("kind") && f.kind !== kind0) out.kind = f.kind;
        if (can("category") && f.kind === "expense" && (f.category || null) !== (it.category ?? null)) out.category = f.category || null;
        return out;
    }
    function save() {
        const ch = changes();
        if (!ch) return;
        if (!Object.keys(ch).length) return close();
        // a note alone is never protected
        if (asks(ch)) Hanami.askFirst();
        Hanami.overviewDo("edit_entry", Object.assign({ id: it.id }, ch));
        close();
    }
    function revert() {
        Hanami.askFirst();
        Hanami.overviewDo("revert_entry", { id: it.id });
        close();
    }
    function remove() {
        Hanami.askFirst();
        Hanami.overviewDo("delete_entry", { id: it.id });
        close();
    }
    function salary(on) {
        Hanami.overviewDo("set_salary", { id: it.id, on: on });
        Hanami.oedit = Object.assign({}, it, { salary: on });
    }
    function close() { Hanami.oedit = null; }

    // it comes in from a little below, as a page does
    ParallelAnimation {
        id: enter
        NumberAnimation { target: col; property: "opacity"; from: 0; to: 1; duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide }
        NumberAnimation { target: col; property: "y"; from: 38; to: 22; duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide }
    }

    Column {
        id: col
        x: 24
        y: 22
        width: parent.width - 48
        spacing: 14

        Item {
            width: parent.width
            height: 22
            Lb { anchors.verticalCenter: parent.verticalCenter; text: root.wasIncome ? "Editar ingreso" : root.kind0 === "other" ? "Editar movimiento" : "Editar gasto"; color: Theme.fg }
            Lnk {
                anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                text: "Cerrar"
                Accessible.name: "Cerrar sin guardar"
                onClicked: root.close()
            }
        }
        Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: root.manual ? "Agregado a mano: se guarda tal cual."
                : `Leído de un correo de ${root.labels[root.it?.source] ?? root.it?.source ?? "tu banco"}. ${root.willAsk ? "Pedirá tu huella antes de guardar; el original se conserva." : "La nota y una primera categoría no piden tu huella."}`
            textFormat: Text.PlainText
            font { family: Theme.ui; pixelSize: 13 }
            color: Theme.grey
        }
        Text {
            visible: !root.any
            width: parent.width
            wrapMode: Text.Wrap
            text: "Este movimiento no se puede editar."
            font { family: Theme.ui; pixelSize: 13 }
            color: Theme.mute
        }

        Picks {
            visible: root.can("kind")
            label: "Tipo"
            model: [["expense", "Gasto"], ["income", "Ingreso"]]
            value: root.f.kind
            onPicked: x => root.set({ kind: x })
        }
        Row {
            visible: root.can("amount") || root.can("currency")
            width: parent.width
            spacing: 10
            Field {
                id: amountF
                visible: root.can("amount")
                width: parent.width - (cur.visible ? cur.width + 10 : 0)
                placeholder: "Monto, como 20.50"
                maxLength: 13
                text: root.f.amount ?? ""
                onEdited: root.set({ amount: text })
                onAccepted: root.save()
            }
            Picks {
                id: cur
                visible: root.can("currency")
                width: 150
                anchors.verticalCenter: parent.verticalCenter
                label: "Moneda"
                model: [["PEN", "S/"], ["USD", "US$"]].concat(["PEN", "USD"].includes(root.it?.currency ?? "PEN") ? [] : [[root.it.currency, root.it.currency]])
                value: root.f.currency
                onPicked: x => root.set({ currency: x })
            }
        }
        Field {
            id: descF
            visible: root.can("description")
            placeholder: root.f.kind === "income" ? "Qué, como Sueldo" : "Qué o dónde, como Taxi"
            text: root.f.description ?? ""
            onEdited: root.set({ description: text })
            onAccepted: root.save()
        }
        Field {
            id: noteF
            visible: root.can("note")
            placeholder: "Nota (opcional), como almuerzo con el equipo"
            maxLength: 200
            text: root.f.note ?? ""
            onEdited: root.set({ note: text })
            onAccepted: root.save()
        }
        Row {
            visible: root.can("date")
            width: parent.width
            spacing: 8
            Btn { small: true; anchors.verticalCenter: parent.verticalCenter; text: "←"; Accessible.name: "Un día antes"; onClicked: root.shift(-1) }
            Field {
                id: dateF
                width: 150
                placeholder: "AAAA-MM-DD"
                maxLength: 10
                text: root.f.date ?? ""
                onEdited: root.set({ date: text })
                onAccepted: root.save()
            }
            Btn { small: true; anchors.verticalCenter: parent.verticalCenter; text: "→"; Accessible.name: "Un día después"; onClicked: root.shift(1) }
            Lb {
                anchors.verticalCenter: parent.verticalCenter
                leftPadding: 6
                visible: root.validDate(root.f.date ?? "") && !!root.page
                text: root.page ? root.page.day(root.f.date ?? "") : ""
                color: Theme.mute
            }
        }
        Drop {
            visible: root.can("category") && root.f.kind === "expense"
            label: "Categoría"
            k: "oedit-cat"
            groups: [{ items: [["", "Sin categoría"]].concat(root.cats.map(c => [c, c])) }]
            value: root.f.category ?? ""
            onPicked: x => root.set({ category: x })
        }
        Sw {
            visible: root.wasIncome
            label: "Es mi sueldo"
            hint: "Un periodo empieza en cada sueldo y dura hasta el día antes del siguiente."
            on: !!root.it?.salary
            onFlip: root.salary(!root.it?.salary)
        }

        Item {
            width: parent.width
            height: 44
            Btn {
                id: saveBtn
                visible: root.any
                primary: true
                text: "Guardar"
                onClicked: root.save()
            }
            Row {
                anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                spacing: 18
                Lnk {
                    visible: !!root.it?.revertible
                    text: "Volver al original"
                    Accessible.name: "Volver a lo que decía el correo"
                    onClicked: root.revert()
                }
                Lnk {
                    visible: root.manual
                    text: "Eliminar"
                    danger: true
                    Accessible.name: `Eliminar ${root.it?.description ?? ""}, agregado a mano`
                    onClicked: root.remove()
                }
            }
        }
    }
}
