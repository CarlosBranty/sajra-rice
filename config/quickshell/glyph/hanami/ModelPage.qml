import QtQuick
import qs
import qs.components

// Model: which AI answers, and the accounts to sign in to (or their API keys)
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property var on: (s?.providers ?? []).filter(p => p.on)
    readonly property var accounts: (s?.providers ?? []).filter(p => p.on || p.method)
    readonly property var keyFor: accounts.find(p => p.id === Hanami.key && !p.on && (p.method === "key" || p.key)) ?? null

    width: parent?.width ?? 0
    spacing: 30

    Group {
        title: "Model"
        desc: "Which AI answers you."
        Drop {
            visible: root.on.length > 0
            label: "Model"
            k: "model"
            placeholder: "Pick a model"
            groups: root.on.map(p => ({ label: p.label, items: p.models.map(m => [`${p.id}:${m.id}`, m.name]) }))
            value: root.s?.model ? `${root.s.model.provider}:${root.s.model.id}` : ""
            onPicked: v => Hanami.act(`model:${v}`)
        }
        Text {
            visible: !root.on.length
            text: "Sign in to an account below first."
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.mute
        }
    }

    Group {
        title: "Accounts"
        desc: "Sign in to use their models."
        // the key field of the account whose Add key is open, above the list so it stays put while state updates
        KeyForm {
            id_: root.keyFor?.id ?? "-"
            label: root.keyFor?.label ?? ""
            kinds: root.keyFor?.kinds ?? null
            onSaved: (key, kind) => Hanami.send({ type: "panel_key", provider: root.keyFor.id, kind: kind, key: key })
        }
        Column {
            width: parent.width
            Repeater {
                model: root.accounts
                Setting {
                    id: acct
                    required property var modelData
                    readonly property var p: modelData
                    label: p.label
                    // signed in
                    Row {
                        visible: acct.p.on
                        spacing: 8
                        Rectangle { anchors.verticalCenter: parent.verticalCenter; width: 8; height: 8; radius: 4; color: Theme.accent }
                        Text { text: "Signed in"; font.family: Theme.ui; font.pixelSize: 14; color: Theme.fg }
                    }
                    Text {
                        visible: !acct.p.on && Hanami.state?.loggingIn === acct.p.id
                        text: "Signing in…"
                        font { family: Theme.ui; pixelSize: 14 }
                        color: Theme.grey
                    }
                    Lnk {
                        visible: !acct.p.on && Hanami.state?.loggingIn !== acct.p.id && acct.p.method === "oauth"
                        text: "Sign in"
                        enabled: !Hanami.state?.loggingIn
                        Accessible.name: `Sign in to ${acct.p.label}`
                        onClicked: Hanami.act(`login:${acct.p.id}`)
                    }
                    Lnk {
                        visible: !acct.p.on && Hanami.state?.loggingIn !== acct.p.id && (acct.p.method !== "oauth" || !!acct.p.key)
                        text: Hanami.key === acct.p.id ? "Cancel" : "Add key"
                        Accessible.name: `Add ${acct.p.label} API key`
                        onClicked: Hanami.key = Hanami.key === acct.p.id ? "" : acct.p.id
                    }
                }
            }
        }
    }
}
