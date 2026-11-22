import QtQuick
import qs
import qs.components

// Behavior: what it may do and when it starts; on Wayland, the commands to bind to keys
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property var b: s?.bind ?? null
    readonly property var rows: [["talk", "Talk to me"], ["summon", "Show or hide me"], ["ask", "Ask me"], ["list", "Your list"], ["panel", "This panel"], ["snap", "Ask about an area"]]

    width: parent?.width ?? 0
    spacing: 30

    Group {
        title: "Behavior"
        desc: "What I may do, and when I start."
        Sw { label: "Sound effects"; on: !!root.s?.sound; onFlip: Hanami.act("sound") }
        Sw { label: "Allow file edits and commands"; hint: "Change files and run commands"; on: !!root.s?.actions; onFlip: Hanami.act("actions") }
        Sw {
            visible: !!root.s?.voice
            label: "Auto-listen"
            hint: root.s?.voice?.on ? "Open the mic when I end on a question" : "Needs Voice control on"
            on: !!root.s?.voice?.autoListen
            onFlip: Hanami.act("autolisten")
        }
        Sw { visible: !!root.s?.login; label: "Open at login"; on: !!root.s?.login?.on; onFlip: Hanami.act("login") }
    }
    Group {
        visible: !!root.b
        title: "Shortcuts"
        desc: "Add these as custom shortcuts in your keyboard settings, with any keys you like."
        Repeater {
            model: root.rows.filter(r => root.b?.[r[0]])
            Setting {
                id: row
                required property var modelData
                label: modelData[1]
                hint: Hanami.bindShown.includes(modelData[0]) ? root.b[modelData[0]] : ""
                mono: true
                Lnk {
                    text: "Copy"
                    Accessible.name: `Copy the command for ${row.modelData[1].toLowerCase()}`
                    onClicked: Hanami.send({ type: "copy_bind", which: row.modelData[0] })
                }
            }
        }
    }
}
