import QtQuick
import qs

// a masked key field that opens in place (Hanami.key === id). kinds: the kinds of key it takes (Kimi and Xiaomi: a
// plan key or a pay-per-token key), picked above the field; saved(key, kind) gets the kind's id
Column {
    id: root

    property string id_
    property string label
    property var kinds: null
    signal saved(string key, var kind)

    readonly property var kind: kinds ? kinds.find(x => x.id === Hanami.kinds[id_]) ?? kinds[0] : null
    readonly property string name: kind?.label ?? label

    width: parent?.width ?? 0
    spacing: 8
    visible: Hanami.key === id_
    onVisibleChanged: if (visible) field.focus_()

    function save() {
        const v = field.text.trim();
        if (!v) return field.focus_();
        root.saved(v, kind?.id);
        field.text = "";
        Hanami.key = "";
    }

    Picks {
        visible: !!root.kinds
        label: `${root.label} key type`
        model: (root.kinds ?? []).map(x => [x.id, x.label])
        value: root.kind?.id ?? ""
        tips: Hanami.dict((root.kinds ?? []).map(x => [x.id, x.billing]))
        onPicked: v => Hanami.kinds = Object.assign({}, Hanami.kinds, { [root.id_]: v })
    }
    Row {
        width: parent.width
        spacing: 10
        Field {
            id: field
            width: parent.width - save.width - 10
            password: true
            maxLength: 1000
            placeholder: `${root.name} key`
            catchEsc: true
            onAccepted: root.save()
            onEscaped: Hanami.key = ""
        }
        Btn { id: save; text: "Save"; onClicked: root.save() }
    }
}
