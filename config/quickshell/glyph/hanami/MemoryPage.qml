import QtQuick
import qs
import qs.components

// Memory: two tabs, What I remember and Commitments; Get to know me at the end of the tab row
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property var facts: s?.facts ?? []
    readonly property string q: Hanami.q.trim().toLowerCase()
    readonly property var hits: q ? facts.filter(x => x.text.toLowerCase().includes(q)) : facts
    readonly property var commits: s?.commitments ?? []

    width: parent?.width ?? 0
    spacing: 22

    Item {
        width: parent.width
        height: tabs.height
        Tabs {
            id: tabs
            model: [["facts", "What I remember"], ["commits", "Commitments"]]
            current: Hanami.mtab
            onPicked: id => { Hanami.mtab = id; Hanami.arm = ""; }
        }
        Lnk {
            anchors { right: parent.right; verticalCenter: tabs.verticalCenter }
            text: "Get to know me"
            enabled: !root.s?.intro
            onClicked: Hanami.act("intro", true)
        }
    }

    // What I remember
    Column {
        width: parent.width
        spacing: 14
        visible: Hanami.mtab === "facts"
        Field {
            visible: root.facts.length > 8 || !!Hanami.q
            placeholder: `Search ${root.facts.length} memories`
            text: Hanami.q
            catchEsc: !!Hanami.q
            onEdited: Hanami.q = text
            onEscaped: { text = ""; Hanami.q = ""; }
        }
        Text {
            visible: !root.hits.length
            text: root.q ? `No match for "${Hanami.q.trim()}".` : "Nothing yet…"
            textFormat: Text.PlainText
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Column {
            width: parent.width
            Repeater {
                model: root.hits
                Entry {
                    id: fact
                    required property var modelData
                    text: modelData.text
                    Arm { label: "Forget"; k: `forget:${fact.modelData.id}`; action: `forget:${fact.modelData.id}` }
                }
            }
        }
        Arm {
            visible: root.facts.length > 0
            label: "Forget everything"
            yes: `Forget all ${root.facts.length}`
            k: "forget-all"
            action: "forgetall:yes"
        }
    }

    // Commitments
    Column {
        width: parent.width
        spacing: 14
        visible: Hanami.mtab === "commits"
        Text {
            visible: !root.commits.length
            text: "Nothing yet…"
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Column {
            width: parent.width
            Repeater {
                model: root.commits
                Entry {
                    id: c
                    required property var modelData
                    text: modelData.text
                    sub: modelData.when ? (modelData.overdue ? `Overdue · ${modelData.when}` : modelData.when) : ""
                    subLate: !!modelData.overdue
                    Lnk { text: "Done"; onClicked: Hanami.act(`done:${c.modelData.id}`) }
                    Arm { label: "Drop"; k: `drop:${c.modelData.id}`; action: `drop:${c.modelData.id}` }
                }
            }
        }
        Lb { visible: root.commits.length > 0; text: `${root.commits.length} open` }
    }
}
