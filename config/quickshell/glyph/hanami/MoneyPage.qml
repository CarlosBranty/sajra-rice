import QtQuick
import qs
import qs.components

// Money (in Spanish, the user's language): the overview from one salary to the next (MoneyOverview), the full table of
// movements read from bank mails or added by hand (the sidecar filters them and sends a page at a time), adding one by
// hand, the mail accounts bank notifications are read from (read-only) and adding one
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property var m: s?.money ?? null
    readonly property var v: Hanami.mview
    readonly property var cats: v?.categories ?? []
    readonly property bool named: Hanami.mcat !== "" && Hanami.mcat !== "null"
    readonly property string catName: named ? JSON.parse(Hanami.mcat) : ""
    readonly property var sel: (v?.rows ?? []).filter(r => Hanami.msel.includes(r.id))
    readonly property bool filtered: !!Hanami.mmonth || Hanami.mcat !== "" || Hanami.mgroup !== "all" || !!Hanami.mtext.trim()
    readonly property string sum: {
        if (!v?.total) return "";
        const sums = (v.totals ?? []).map(t => [`${t.spent} sale`, String(t.received).endsWith(" 0.00") ? null : `${t.received} entra`].filter(Boolean).join(", "));
        return `${v.total} movimiento${v.total === 1 ? "" : "s"} · ${sums.join(" · ")}`;
    }
    readonly property var mon: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
    function monthName(x) { return `${mon[Number(x.slice(5)) - 1]} ${x.slice(0, 4)}`; }
    readonly property string kept: ({ mac: "tu Llavero", win: "Windows, cifrada para tu cuenta", linux: "tu llavero del sistema" })[s?.os] ?? "este equipo"
    readonly property var help: ({
        gmail: "Gmail pide una contraseña de aplicación: activa la verificación en dos pasos en tu cuenta de Google y crea una en myaccount.google.com/apppasswords. Puedes revocarla allí cuando quieras; cambiar tu contraseña de Google también la revoca.",
        yahoo: "Yahoo pide una contraseña de aplicación: Información de la cuenta, Seguridad, Generar contraseña de aplicación. Puedes revocarla allí cuando quieras: sigue sirviendo aunque cambies tu contraseña de Yahoo, así que revócala si dejas de usar Hanami.",
        outlook: "Pronto: Outlook.com ya no acepta contraseñas de aplicación y pide iniciar sesión con Microsoft, que Hanami aún no tiene."
    })

    width: parent?.width ?? 0
    spacing: 22

    Tabs {
        model: [["over", "Resumen"], ["moves", "Tabla"], ["entry", "A mano"], ["accounts", "Correos"], ["add", "Añadir correo"]]
        current: Hanami.ytab
        onPicked: id => {
            Hanami.ytab = id; Hanami.arm = ""; Hanami.clearSel(); Hanami.mren = false; Hanami.dd = ""; Hanami.oedit = null;
            Hanami.moneyLoad();
        }
    }

    // ================================================================ Overview
    MoneyOverview { visible: Hanami.ytab === "over" }

    // ================================================================ Movements
    Column {
        visible: Hanami.ytab === "moves"
        width: parent.width
        spacing: 16

        Text {
            visible: !root.v
            text: Hanami.linked ? "Cargando…" : ""
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }

        // ---- the filters (with no rows selected) ----
        Column {
            visible: !!root.v && !root.sel.length
            width: parent.width
            spacing: 10
            Row {
                width: parent.width
                spacing: 8
                Drop {
                    width: (parent.width - 16) / 3
                    label: "Mes"
                    k: "mmonth"
                    groups: [{ items: [["", "Todos los meses"]].concat((root.v?.months ?? []).map(x => [x, root.monthName(x)])) }]
                    value: Hanami.mmonth
                    onPicked: x => Hanami.filter({ month: x })
                }
                Drop {
                    width: (parent.width - 16) / 3
                    label: "Category"
                    k: "mcatf"
                    groups: [{ items: [["", "Todas las categorías"], ["null", "Sin clasificar"]].concat(root.cats.map(c => [JSON.stringify(c), c])) }]
                    value: Hanami.mcat
                    onPicked: x => Hanami.filter({ cat: x })
                }
                Drop {
                    width: (parent.width - 16) / 3
                    label: "Tipo"
                    k: "mgroup"
                    groups: [{ items: [["all", "Todo"], ["spending", "Gastos"], ["income", "Ingresos"], ["other", "No cuenta"]] }]
                    value: Hanami.mgroup
                    onPicked: x => Hanami.filter({ group: x })
                }
            }
            // renaming the category the table is filtered by: the table follows it under its new name
            Row {
                visible: root.named && Hanami.mren
                width: parent.width
                spacing: 10
                onVisibleChanged: if (visible) { rename.text = root.catName; rename.focus_(); }
                function save() {
                    const to = rename.text.trim();
                    if (!to || to === root.catName) return rename.focus_();
                    const from = root.catName;
                    Hanami.askFirst();
                    Hanami.mren = false;
                    Hanami.mcat = JSON.stringify(to);
                    Hanami.moneyDo("rename_category", { from: from, to: to });
                }
                Field {
                    id: rename
                    width: parent.width - renameBtn.width - 10
                    maxLength: 40
                    placeholder: `Nuevo nombre para ${root.catName}`
                    catchEsc: true
                    onAccepted: parent.save()
                    onEscaped: Hanami.mren = false
                }
                Btn { id: renameBtn; text: "Renombrar"; onClicked: parent.save() }
            }
            Row {
                visible: !(root.named && Hanami.mren)
                width: parent.width
                spacing: 16
                Field {
                    id: find
                    width: parent.width - (catLinks.visible ? catLinks.width + 16 : 0)
                    placeholder: "Buscar"
                    text: Hanami.mtext
                    catchEsc: !!Hanami.mtext
                    onEdited: { Hanami.mtext = text; Hanami.mpage = 0; findTimer.restart(); }
                    onEscaped: { text = ""; Hanami.filter({ text: "" }); }
                    Timer { id: findTimer; interval: 200; onTriggered: Hanami.moneyAsk() }
                }
                Row {
                    id: catLinks
                    visible: root.named
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 14
                    Lnk { text: "Renombrar"; Accessible.name: `Renombrar la categoría ${root.catName}`; onClicked: Hanami.mren = true }
                    Lnk {
                        text: "Delete"
                        danger: true
                        Accessible.name: `Eliminar la categoría ${root.catName}`
                        onClicked: { Hanami.askFirst(); Hanami.moneyDo("delete_category", { name: root.catName }); }
                    }
                }
            }
        }

        // ---- what to do with the rows selected ----
        Column {
            id: selBar
            objectName: "selBar"
            visible: !!root.v && root.sel.length > 0
            width: parent.width
            spacing: 10
            readonly property var cls: root.sel.filter(r => r.classifiable)
            readonly property var withCat: cls.filter(r => r.category)
            function put() {
                const name = Hanami.mnew ? newCat.text.trim() : Hanami.mput;
                if (!name) return Hanami.mnew ? newCat.focus_() : undefined;
                if (root.sel.some(r => r.category && r.category.toLowerCase() !== name.toLowerCase())) Hanami.askFirst();
                const note = noteF.text.trim();
                Hanami.moneyDo("classify", { ids: root.sel.map(r => r.id), category: name, create: Hanami.mnew || undefined, note: note || undefined });
                Hanami.clearSel();
                newCat.text = "";
                noteF.text = "";
            }
            Text {
                visible: selBar.cls.length < root.sel.length
                text: "Los ingresos y lo que no cuenta no llevan categoría."
                font { family: Theme.ui; pixelSize: 13 }
                color: Theme.grey
            }
            Row {
                visible: selBar.cls.length === root.sel.length
                width: parent.width
                spacing: 10
                Field {
                    id: newCat
                    visible: Hanami.mnew
                    width: parent.width - putBtn.width - 10
                    maxLength: 40
                    placeholder: "Nueva categoría"
                    catchEsc: true
                    onVisibleChanged: if (visible) focus_()
                    onAccepted: selBar.put()
                    onEscaped: Hanami.mnew = false
                }
                Drop {
                    visible: !Hanami.mnew
                    width: parent.width - putBtn.width - 10
                    label: "Category"
                    k: "mcat"
                    placeholder: "Elige una categoría"
                    groups: [{ items: [["", "Elige una categoría", true]].concat(root.cats.map(c => [JSON.stringify(c), c]), [["new", "Nueva categoría…"]]) }]
                    value: Hanami.mput ? JSON.stringify(Hanami.mput) : ""
                    onPicked: x => { if (x === "new") Hanami.mnew = true; else Hanami.mput = JSON.parse(x); }
                }
                Btn { id: putBtn; text: "Poner"; onClicked: selBar.put() }
            }
            Field {
                id: noteF
                objectName: "classifyNote"
                visible: selBar.cls.length === root.sel.length
                placeholder: "Nota (opcional), como almuerzo con el equipo"
                maxLength: 200
                onAccepted: selBar.put()
            }
            Flow {
                width: parent.width
                spacing: 16
                Lb { text: `${root.sel.length} elegido${root.sel.length === 1 ? "" : "s"}` }
                Lnk {
                    visible: selBar.withCat.length > 0
                    text: "Quitar categoría"
                    onClicked: { Hanami.askFirst(); Hanami.moneyDo("unclassify", { ids: selBar.withCat.map(r => r.id) }); Hanami.clearSel(); }
                }
                Lnk {
                    visible: root.sel.length === 1 && !!root.sel[0].own
                    text: "Es mía"
                    Accessible.name: `Marcar ${root.sel[0]?.text ?? ""} como cuenta tuya: sus transferencias dejan de contar`
                    onClicked: { Hanami.moneyDo("own", { action: "mark", key: root.sel[0].own }); Hanami.clearSel(); }
                }
                Lnk {
                    visible: root.sel.length === 1 && !!root.sel[0].manual
                    text: "Delete"
                    danger: true
                    Accessible.name: `Eliminar ${root.sel[0]?.text ?? ""}, agregado a mano`
                    onClicked: { Hanami.askFirst(); Hanami.moneyDo("delete_entry", { id: root.sel[0].id }); Hanami.clearSel(); }
                }
                Lnk { text: "Soltar"; Accessible.name: "Soltar lo elegido"; onClicked: Hanami.clearSel() }
            }
        }

        // ---- the rows ----
        Text {
            visible: !!root.v && !root.v.rows.length
            width: parent.width
            wrapMode: Text.Wrap
            text: root.filtered ? "Nada coincide con estos filtros." : "Aún no hay movimientos: llegan de los correos de tu banco, o agrégalos a mano."
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Column {
            width: parent.width
            Repeater {
                model: root.v?.rows ?? []
                Item {
                    id: row
                    required property var modelData
                    readonly property var r: modelData
                    readonly property bool on: Hanami.msel.includes(r.id)
                    readonly property bool pickable: !!(r.classifiable || r.manual || r.own)
                    readonly property string sign: r.status === "Income" ? "+" : ""
                    width: parent.width
                    height: 58

                    Rectangle {
                        id: box
                        anchors.verticalCenter: parent.verticalCenter
                        width: row.pickable ? 24 : 8
                        height: width
                        x: row.pickable ? 0 : 8
                        radius: row.pickable ? Theme.corner(7) : 4
                        color: row.on ? Theme.fg : row.pickable ? "transparent" : Theme.mute
                        border { width: row.pickable ? 1 : 0; color: row.on ? Theme.fg : Theme.mute }
                        Icon { anchors.centerIn: parent; visible: row.on; text: "\u{F012C}"; font.pixelSize: 16; color: Theme.ink }
                        Accessible.role: Accessible.CheckBox
                        Accessible.name: `Elegir: ${row.r.text}, ${row.sign}${row.r.amount}, ${row.r.date}`
                        Accessible.checked: row.on
                    }
                    Column {
                        anchors { left: box.right; leftMargin: 16; right: amt.left; rightMargin: 12; verticalCenter: parent.verticalCenter }
                        spacing: 2
                        Text {
                            width: parent.width
                            text: row.r.text
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            font { family: Theme.ui; pixelSize: 15 }
                            color: Theme.fg
                        }
                        Text {
                            width: parent.width
                            text: `${row.r.date} · ${row.r.kind} · ${row.r.source}`
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            font { family: Theme.ui; pixelSize: 12 }
                            color: Theme.grey
                        }
                    }
                    Column {
                        id: amt
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        spacing: 2
                        Text {
                            anchors.right: parent.right
                            text: `${row.sign}${row.r.amount}`
                            textFormat: Text.PlainText
                            font { family: Theme.mono; pixelSize: 14 }
                            color: Theme.fg
                        }
                        Text {
                            anchors.right: parent.right
                            text: row.r.category ?? row.r.status
                            textFormat: Text.PlainText
                            font { family: Theme.ui; pixelSize: 12 }
                            color: row.r.status === "Needs review" ? Theme.red : Theme.grey
                        }
                    }
                    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.s2 }
                    TapHandler { enabled: row.pickable; onTapped: Hanami.toggleSel(row.r.id) }
                    HoverHandler { enabled: row.pickable; cursorShape: Qt.PointingHandCursor }
                }
            }
        }
        Item {
            width: parent.width
            height: Math.max(sumLb.height, pager.height)
            visible: !!root.sum || pager.visible
            Text {
                id: sumLb
                anchors { left: parent.left; right: pager.left; rightMargin: 12; verticalCenter: parent.verticalCenter }
                text: root.sum
                textFormat: Text.PlainText
                elide: Text.ElideRight
                font { family: Theme.mono; pixelSize: 12 }
                color: Theme.grey
            }
            Pager {
                id: pager
                anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                page: root.v?.page ?? 0
                pages: root.v?.pages ?? 1
                onGo: pg => { Hanami.mpage = pg; Hanami.clearSel(); Hanami.moneyAsk(); }
            }
        }
    }

    // ================================================================ Add by hand
    Group {
        id: entry
        visible: Hanami.ytab === "entry"
        readonly property var f: Hanami.mform
        readonly property string today: Qt.formatDate(new Date(), "yyyy-MM-dd")
        function set(patch) { Hanami.mform = Object.assign({}, Hanami.mform, patch); }
        function save() {
            const f = Hanami.mform, amount = amountF.text.trim(), description = descF.text.trim(), date = dateF.text.trim() || today;
            if (!/^\d{1,9}([.,]\d{1,2})?$/.test(amount) || !Number(amount.replace(",", "."))) {
                Hanami.note("Escribe el monto así: 20.50", true);
                return amountF.focus_();
            }
            if (!description) return descF.focus_();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return dateF.focus_();
            const args = { kind: f.kind, amount: amount, currency: f.currency, date: date, description: description };
            if (f.kind === "expense" && f.category) args.category = f.category;
            Hanami.moneyDo("add_entry", args);
            set({ amount: "", description: "" });
            amountF.text = "";
            descF.text = "";
            amountF.focus_();
        }
        title: f.kind === "income" ? "Agregar un ingreso" : "Agregar un gasto"
        desc: "Lo que ningún correo del banco me cuenta: efectivo, otra tarjeta, tu sueldo."

        Picks { label: "Tipo"; model: [["expense", "Gasto"], ["income", "Ingreso"]]; value: entry.f.kind; onPicked: x => entry.set({ kind: x }) }
        Row {
            width: parent.width
            spacing: 10
            Field {
                id: amountF
                width: parent.width - cur.width - 10
                placeholder: "Monto, como 20.50"
                maxLength: 13
                text: entry.f.amount
                onEdited: Hanami.mform.amount = text
                onAccepted: entry.save()
            }
            Picks {
                id: cur
                width: 150
                anchors.verticalCenter: parent.verticalCenter
                label: "Moneda"
                model: [["PEN", "S/"], ["USD", "US$"]]
                value: entry.f.currency
                onPicked: x => entry.set({ currency: x })
            }
        }
        Field {
            id: descF
            placeholder: entry.f.kind === "income" ? "Qué, como Sueldo" : "Qué o dónde, como Taxi"
            text: entry.f.description
            onEdited: Hanami.mform.description = text
            onAccepted: entry.save()
        }
        Row {
            width: parent.width
            spacing: 10
            Field {
                id: dateF
                width: entry.f.kind === "expense" ? 180 : parent.width
                placeholder: "YYYY-MM-DD"
                maxLength: 10
                text: entry.f.date || entry.today
                onEdited: Hanami.mform.date = text
                onAccepted: entry.save()
            }
            Drop {
                visible: entry.f.kind === "expense"
                width: parent.width - 190
                label: "Categoría"
                k: "mentrycat"
                groups: [{ items: [["", "Sin categoría"]].concat(root.cats.map(c => [c, c])) }]
                value: entry.f.category
                onPicked: x => entry.set({ category: x })
            }
        }
        Btn { text: "Agregar"; onClicked: entry.save() }
    }

    // ================================================================ Accounts
    Group {
        visible: Hanami.ytab === "accounts"
        title: "Revisar cada"
        desc: "Cada cuánto busco correos nuevos del banco mientras corro."
        Picks {
            label: "Revisar cada"
            model: (root.m?.everys ?? []).map(n => [n, `${n} min`])
            value: root.m?.every ?? 0
            onPicked: x => Hanami.act(`mailevery:${x}`)
        }
    }
    Group {
        visible: Hanami.ytab === "accounts"
        title: "Cuentas de correo"
        desc: "Solo lectura: nada se mueve, marca ni borra."
        Text {
            visible: !(root.m?.accounts?.length)
            text: "Aún no hay cuentas: añade una para leer los correos de tu banco."
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Column {
            width: parent.width
            Repeater {
                model: root.m?.accounts ?? []
                Entry {
                    id: acct
                    required property var modelData
                    readonly property var a: modelData
                    text: `${a.label} · ${a.email}`
                    sub: a.status ? `${a.status.text}${a.status.at ? ` · ${Hanami.ago(a.status.at)}` : ""}` : "Sin revisar aún"
                    subLate: a.status?.state === "error"
                    Lnk { text: "Probar"; Accessible.name: `Probar la conexión con ${acct.a.email}`; onClicked: Hanami.act(`mail_test:${acct.a.id}`) }
                    Arm { label: "Quitar"; k: `mail-remove:${acct.a.id}`; action: `mail_remove:${acct.a.id}`; Accessible.name: `Quitar ${acct.a.email} y su contraseña de aplicación` }
                }
            }
        }
    }
    Group {
        visible: Hanami.ytab === "accounts"
        title: "Tus propias cuentas"
        desc: "Las transferencias a ellas no son gasto ni ingreso."
        Text {
            visible: !(root.v?.own?.length)
            width: parent.width
            wrapMode: Text.Wrap
            text: "Ninguna aún: elige una transferencia en Tabla y márcala como tuya."
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Column {
            width: parent.width
            Repeater {
                model: root.v?.own ?? []
                Entry {
                    id: own
                    required property var modelData
                    text: modelData.name
                    sub: `${modelData.count} transferencia${modelData.count === 1 ? "" : "s"}, no cuenta${modelData.count === 1 ? "" : "n"}`
                    Lnk {
                        text: "Desmarcar"
                        Accessible.name: `Desmarcar ${own.modelData.name} como cuenta tuya`
                        onClicked: { Hanami.askFirst(); Hanami.moneyDo("own", { action: "unmark", key: own.modelData.key }); }
                    }
                }
            }
        }
    }

    // ================================================================ Add account
    Group {
        id: add
        visible: Hanami.ytab === "add"
        title: "Añadir una cuenta"
        function save() {
            const email = addr.text.trim(), password = pass.text.trim();
            if (!email) return addr.focus_();
            if (!password) return pass.focus_();
            Hanami.send({ type: "panel_mail_add", provider: Hanami.mprov, email: email, password: password });
            pass.text = "";
            addr.text = "";
            Hanami.ytab = "accounts";
        }
        Picks {
            label: "Proveedor"
            model: [["gmail", "Gmail"], ["yahoo", "Yahoo"], ["outlook", "Outlook (pronto)"]]
            value: Hanami.mprov
            onPicked: x => Hanami.mprov = x
        }
        Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: root.help[Hanami.mprov] ?? ""
            font { family: Theme.ui; pixelSize: 13 }
            color: Theme.grey
        }
        Field { id: addr; visible: Hanami.mprov !== "outlook"; placeholder: "Correo"; maxLength: 200; onAccepted: add.save() }
        Row {
            visible: Hanami.mprov !== "outlook"
            width: parent.width
            spacing: 10
            Field { id: pass; width: parent.width - mailSave.width - 10; password: true; placeholder: "Contraseña de aplicación"; maxLength: 200; onAccepted: add.save() }
            Btn { id: mailSave; text: "Guardar"; onClicked: add.save() }
        }
        Text {
            visible: Hanami.mprov !== "outlook"
            width: parent.width
            wrapMode: Text.Wrap
            text: `La contraseña de aplicación se guarda en ${root.kept}. Solo leo los correos de tus bancos y nunca muevo, marco ni borro nada.`
            font { family: Theme.ui; pixelSize: 13 }
            color: Theme.grey
        }
    }
}
