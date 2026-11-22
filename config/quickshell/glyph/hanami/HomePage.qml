import QtQuick
import qs
import qs.components

// Home: the actions, what went on lately, and today's usage
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property bool mac: s?.os === "mac"

    width: parent?.width ?? 0
    spacing: 26

    Flow {
        width: parent.width
        spacing: 8
        Btn {
            text: "Ask"
            primary: !root.s?.update?.available
            enabled: !root.s?.busy
            Accessible.name: `Ask ${root.s?.name ?? ""}`
            onClicked: Hanami.act("ask", true)
        }
        Btn { text: "Show list"; onClicked: Hanami.act("list", true) }
        Btn { visible: root.s?.snap ?? root.mac; text: "Ask about an area"; onClicked: Hanami.act("snap", true) }
        Btn { visible: !!root.s?.busy; text: "Stop"; onClicked: Hanami.act("stop") }
        Btn {
            visible: !root.s?.busy
            text: "New chat"
            enabled: !!root.s?.canNew
            Accessible.name: "Start a new conversation"
            onClicked: Hanami.act("new")
        }
        Btn { visible: !root.mac; text: `Show ${root.s?.name ?? ""}`; onClicked: Hanami.act("show", true) }
    }

    Group {
        title: "Recent"
        Text {
            visible: !(root.s?.recent?.length)
            text: "Nothing yet…"
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
        Column {
            width: parent.width
            Repeater {
                model: root.s?.recent ?? []
                Entry {
                    id: r
                    required property var modelData
                    kind: modelData.kind
                    text: modelData.kind === "ask" ? `“${modelData.text}”` : modelData.text
                    Lb { text: Hanami.ago(r.modelData.at) }
                }
            }
        }
    }

    Lb {
        visible: !!root.s?.usage
        text: root.s?.usage ? `Today: ${root.s.usage.requests} request${root.s.usage.requests === 1 ? "" : "s"} · ${Hanami.tokens(root.s.usage.tokens)} tokens` : ""
    }
}
