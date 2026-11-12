import QtQuick
import qs
import qs.components

// Appearance: two tabs, the looks and the rest (size and colors)
Column {
    id: root

    readonly property var s: Hanami.state

    width: parent?.width ?? 0
    spacing: 26

    Tabs {
        model: [["look", "Look"], ["style", "Size and colors"]]
        current: Hanami.atab
        onPicked: id => Hanami.atab = id
    }
    Group {
        visible: Hanami.atab === "look"
        title: "Look"
        desc: "Each look has its own name and voice."
        Picks {
            label: "Look"
            model: root.s?.looks ?? []
            value: root.s?.look ?? ""
            onPicked: v => Hanami.act(`look:${v}`)
        }
    }
    Group {
        visible: Hanami.atab === "style"
        title: "Size"
        desc: "How big I am on your screen."
        Picks { label: "Size"; model: root.s?.sizes ?? []; value: root.s?.size ?? ""; onPicked: v => Hanami.act(`size:${v}`) }
    }
    Group {
        visible: Hanami.atab === "style"
        title: "Colors"
        desc: "Mine, or your desktop's: light or dark, as it is."
        Picks { label: "Colors"; model: root.s?.themes ?? []; value: root.s?.theme ?? ""; onPicked: v => Hanami.act(`theme:${v}`) }
    }
}
