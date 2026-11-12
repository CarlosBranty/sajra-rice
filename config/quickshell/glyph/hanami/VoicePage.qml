import QtQuick
import qs
import qs.components

// Voice: what I say (Replies), how you talk to me (Talking), and on Linux the Devices (microphone, speaker, boost) and
// Other sounds
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property var v: s?.voice ?? null
    readonly property var a: s?.audio ?? null
    readonly property string tab: (Hanami.vtab === "sounds" && !s?.duck) || (Hanami.vtab === "devices" && !a) ? "replies" : Hanami.vtab
    readonly property bool local: s?.voiceEngine === "local"
    readonly property var lv: s?.localVoice ?? null
    readonly property string localLine: !lv ? "" : lv.status === "downloading" ? `Downloading the voice… ${lv.pct}%`
        : lv.status === "error" ? `The download failed. ${lv.error ?? ""}`.trim()
        : lv.status !== "ready" ? `Needs a ${lv.size} download`
        : s?.language === "es" ? "Spoken on this computer, offline and free."
        : "A Spanish voice: replies in other languages sound Spanish-accented. Pick Español below for the best result."
    readonly property var why: ({ "drama-3": "More emotion. Slower, and costs more.", "s2.1-pro": "Natural pace. Less emotion, costs less." })
    readonly property var whyLong: ({
        "drama-3": "The most expressive: whispers, laughs and real excitement. It talks slower, with pauses between sentences.",
        "s2.1-pro": "A natural, quicker pace. Feelings only come through lightly."
    })
    // a device list: the system's default, the devices, and the one picked if it isn't connected now
    function devs(list, cur) {
        return [{ items: [["", "System default"]].concat((list ?? []).map(d => [d.name, d.label]),
            cur && !(list ?? []).some(d => d.name === cur) ? [[cur, "Not connected now"]] : []) }];
    }

    width: parent?.width ?? 0
    spacing: 26

    Tabs {
        model: [["replies", "Replies"], ["talking", "Talking"]].concat(root.a ? [["devices", "Devices"]] : [], root.s?.duck ? [["sounds", "Other sounds"]] : [])
        current: root.tab
        onPicked: id => { Hanami.vtab = id; Hanami.key = ""; Hanami.arm = ""; }
    }

    // ---- Replies ----
    Group {
        visible: root.tab === "replies"
        title: "Spoken replies"
        desc: "Hear me as well as read me."
        Picks {
            label: "Replies"
            model: [["text", "Text only"], ["voice", "Voice and text"]]
            value: root.s?.replies ?? ""
            onPicked: x => {
                if (x === "voice" && !root.local && !root.s?.fishKey) {
                    Hanami.key = "fish";
                    Hanami.note("Add a Fish Audio key to hear me talk.");
                    return;
                }
                Hanami.act(`replies:${x}`);
            }
        }
        Column {
            visible: !!root.s?.engines
            width: parent.width
            spacing: 8
            Lb { text: "Voice" }
            Picks {
                label: "Voice"
                model: root.s?.engines ?? []
                value: root.s?.voiceEngine ?? ""
                tips: ({ fish: "Fish Audio, online: the most expressive voices, one per look. Needs your own Fish Audio key; billed to your account.",
                         local: "Made on this computer: offline, free and quick. One Spanish (Spain) voice for every look, downloaded once." })
                onPicked: x => Hanami.act(`voiceengine:${x}`)
            }
            Text {
                visible: root.local && !!root.localLine
                width: parent.width
                wrapMode: Text.Wrap
                text: root.localLine
                textFormat: Text.PlainText
                font { family: Theme.ui; pixelSize: 13 }
                color: root.lv?.status === "error" || (root.lv?.status === "ready" && root.s?.language !== "es") ? Theme.red : Theme.grey
            }
            Lnk {
                visible: root.local && !!root.lv && (root.lv.status === "missing" || root.lv.status === "error")
                text: root.lv?.status === "error" ? "Retry the download" : `Download (${root.lv?.size ?? ""})`
                onClicked: Hanami.act("localdl")
            }
        }
        Column {
            visible: !root.local && root.s?.replies === "voice" && (root.s?.fishModels?.length ?? 0) > 0
            width: parent.width
            spacing: 8
            Lb { text: "Voice model" }
            Picks {
                label: "Voice model"
                model: (root.s?.fishModels ?? []).map(c => [c.id, c.name])
                value: root.s?.fishModel ?? ""
                tips: Hanami.dict((root.s?.fishModels ?? []).map(c => [c.id, `${root.whyLong[c.id] ?? ""} ${Hanami.price(c)}`.trim()]))
                onPicked: x => Hanami.act(`fishmodel:${x}`)
            }
            Text {
                text: root.s?.fishFree ? "No credit left, so it's on Fish's free tier" : root.why[root.s?.fishModel] ?? ""
                textFormat: Text.PlainText
                font { family: Theme.ui; pixelSize: 13 }
                color: root.s?.fishFree ? Theme.red : Theme.grey
            }
        }
        Setting {
            visible: !root.local
            label: "Fish Audio key"
            hint: root.s?.fishKey ? `Saved in ${Hanami.where()}` : "Needed for spoken replies"
            Lnk {
                text: Hanami.key === "fish" ? "Cancel" : root.s?.fishKey ? "Change" : "Add"
                Accessible.name: root.s?.fishKey ? "Change the Fish Audio key" : "Add a Fish Audio key"
                onClicked: Hanami.key = Hanami.key === "fish" ? "" : "fish"
            }
            Arm { visible: !!root.s?.fishKey && Hanami.key !== "fish"; label: "Remove"; k: "fishkey-remove"; action: "fishkey_remove" }
        }
        KeyForm {
            visible: !root.local && Hanami.key === "fish"
            id_: "fish"
            label: "Fish Audio"
            onSaved: key => Hanami.send({ type: "panel_fishkey", key: key })
        }
    }
    Group {
        visible: root.tab === "replies" && (root.s?.languages?.length ?? 0) > 0
        title: "Language"
        desc: "What I reply in, spoken and written."
        Picks { label: "Language"; model: root.s?.languages ?? []; value: root.s?.language ?? ""; onPicked: x => Hanami.act(`language:${x}`) }
    }

    // ---- Talking ----
    Group {
        visible: root.tab === "talking" && !!root.v
        title: "Talking to me"
        desc: "Speak instead of typing."
        Sw {
            label: "Voice control"
            hint: root.v?.download
                ? (root.v.download.status === "downloading" ? `Downloading the voice model… ${root.v.download.pct}%`
                    : root.v.download.status === "error" ? "The download failed" : `Needs a ${root.v.download.size} download`)
                : root.v?.keys ? `Hold ${root.v.keys} to talk` : "Press your talk shortcut to talk"
            on: !!root.v?.on
            onFlip: Hanami.act("voice")
        }
        Lnk {
            visible: !!root.v?.download && root.v.download.status !== "downloading"
            text: root.v?.download?.status === "error" ? "Retry the download" : `Download (${root.v?.download?.size ?? ""})`
            onClicked: Hanami.act("voicedl")
        }
        Sw { visible: !!root.v?.mac; label: "Mute Mac while talking"; hint: "Other sounds go quiet while you talk"; on: !!root.v?.mute; onFlip: Hanami.act("mutetalk") }
        Sw {
            visible: !!root.s?.pen
            label: "Draw with the mouse while I listen"
            hint: "Drag round what you mean; a click without dragging stops it"
            on: !!root.s?.pen?.on
            onFlip: Hanami.act("pen")
        }
    }
    Group {
        visible: root.tab === "talking" && !!root.s?.wake
        title: "Wake word"
        desc: "Say a phrase and I listen, no key needed. The microphone stays on to hear it; nothing leaves this computer until you say it."
        Sw {
            label: "Wake word"
            hint: !root.v?.on ? "Needs Voice control on" : root.s?.wake?.phrase ? `Say "${root.s.wake.phrase}" to talk to me` : "Pick a phrase to call me with"
            on: !!root.s?.wake?.on
            onFlip: {
                if (!root.s?.wake?.phrase) {
                    Hanami.key = "wake";
                    Hanami.note("Type the phrase to call me with.");
                    return;
                }
                Hanami.act("wake");
            }
        }
        Setting {
            label: "Phrase"
            hint: root.s?.wake?.phrase || "Not set"
            Lnk {
                text: Hanami.key === "wake" ? "Cancel" : root.s?.wake?.phrase ? "Change" : "Set"
                Accessible.name: root.s?.wake?.phrase ? "Change the wake phrase" : "Set the wake phrase"
                onClicked: Hanami.key = Hanami.key === "wake" ? "" : "wake"
            }
        }
        Row {
            visible: Hanami.key === "wake"
            width: parent.width
            spacing: 10
            onVisibleChanged: if (visible) { phrase.text = root.s?.wake?.phrase ?? ""; phrase.focus_(); }
            function save() {
                const p = phrase.text.trim();
                if (!p) return phrase.focus_();
                Hanami.send({ type: "panel_wake", phrase: p });
                Hanami.key = "";
            }
            Field {
                id: phrase
                width: parent.width - savePhrase.width - 10
                maxLength: 40
                placeholder: "A word or two, like a name"
                catchEsc: true
                onAccepted: parent.save()
                onEscaped: Hanami.key = ""
            }
            Btn { id: savePhrase; text: "Save"; onClicked: parent.save() }
        }
    }

    // ---- Devices (Linux) ----
    Group {
        visible: root.tab === "devices" && !!root.a
        title: "Microphone"
        desc: "What I listen with."
        Drop { label: "Microphone"; k: "mic"; groups: root.devs(root.a?.mics, root.a?.mic); value: root.a?.mic ?? ""; onPicked: x => Hanami.act(`mic:${x}`) }
        Lb { visible: !!root.a?.gains; text: "Boost, if I hear you only up close" }
        Picks {
            visible: !!root.a?.gains
            label: "Microphone boost"
            model: (root.a?.gains ?? []).map(g => [g, g === 100 ? "Off" : `${g}%`])
            value: root.a?.gain ?? 100
            onPicked: x => Hanami.act(`micgain:${x}`)
        }
    }
    Group {
        visible: root.tab === "devices" && !!root.a
        title: "Speaker"
        desc: "Where my voice plays."
        Drop { label: "Speaker"; k: "speaker"; groups: root.devs(root.a?.speakers, root.a?.speaker); value: root.a?.speaker ?? ""; onPicked: x => Hanami.act(`speaker:${x}`) }
    }

    // ---- Other sounds (Linux) ----
    Group {
        visible: root.tab === "sounds" && !!root.s?.duck
        title: "Other sounds"
        desc: "Turn other apps down while I listen and while I talk."
        Sw { label: "Lower other sounds"; hint: "They come back when I stop"; on: !!root.s?.duck?.on; onFlip: Hanami.act("duck") }
        Lb { visible: !!root.s?.duck?.on; text: "Lower to" }
        Picks {
            visible: !!root.s?.duck?.on
            label: "Lower to"
            model: (root.s?.duck?.levels ?? []).map(l => [l, `${l}%`])
            value: root.s?.duck?.level ?? 0
            onPicked: x => Hanami.act(`ducklevel:${x}`)
        }
    }
}
