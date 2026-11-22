import QtQuick
import Quickshell
import Quickshell.Io
import qs
import qs.components

// SPEAKERS page of prefs: the x1sound controller (~/Projects/x1sound). Reads and writes ~/.config/x1sound/config.json —
// the daemon picks every change up within 300 ms and ramps it in; the daemon's state (health, loudness in play) comes
// from $XDG_RUNTIME_DIR/x1sound/state.json. No daemon — the page still edits the config; `x1sound apply` uses it
Column {
    id: root

    readonly property string caption: `speakers · x1sound · ${st.health || "daemon off"}${st.routing ? " · " + st.routing : ""}${st.headphones ? " · headphones" : ""}`
    readonly property var profiles: ["dynamic", "music", "voice", "off"]
    readonly property var st: { try { return JSON.parse(stateText.trim() || "{}"); } catch (e) { return {}; } }
    property string stateText: ""

    spacing: 34

    FileView {
        id: cfgFile
        path: Quickshell.env("HOME") + "/.config/x1sound/config.json"
        blockLoading: true
        watchChanges: true
        onFileChanged: reload()
        onAdapterUpdated: Qt.callLater(cfgFile.writeAdapter)
        printErrors: false
        // the same defaults as config.rs; the daemon clamps whatever lands here
        JsonAdapter {
            id: cfg
            property bool enabled: true
            property string profile: "dynamic"
            property real bass_db: 6
            property real treble_db: 0
            property real boost_db: 10
            property bool loudness: false
            property real loudness_amount: 0.4
            property real tweeter: 87
            property real woofer: 87
            property var eq: [0, 0, 0, 0, 0, 0, 0, 0]
        }
    }
    FileView {
        path: Quickshell.env("XDG_RUNTIME_DIR") + "/x1sound/state.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: root.stateText = text()
        onLoadFailed: root.stateText = ""
    }

    // EQ presets: the list x1sound writes (and the user may extend) in ~/.config/x1sound/eq-presets.json
    property var presets: []
    FileView {
        path: Quickshell.env("HOME") + "/.config/x1sound/eq-presets.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: { try { root.presets = JSON.parse(text()).filter(p => p.name && p.eq?.length === 8); } catch (e) { root.presets = []; } }
    }
    readonly property string preset: {
        const e = cfg.eq ?? [];
        const m = presets.find(p => p.eq.every((x, i) => Math.abs(x - (e[i] ?? 0)) < 0.01));
        return m ? m.name : "custom";
    }

    function db(v) { const r = Math.round(v); return (r > 0 ? "+" : "") + r; }
    function dac(v) { return db((v - 87) * 0.75); } // DAC step: 0.75 dB, 87 = 0 dB

    // profile + switches
    Row {
        spacing: 24
        Pick {
            anchors.verticalCenter: parent.verticalCenter
            label: "profile"
            seg: 96
            opts: root.profiles
            cur: root.profiles.indexOf(cfg.profile)
            onPicked: i => cfg.profile = root.profiles[i]
        }
        Toggle { anchors.verticalCenter: parent.verticalCenter; text: "dolby"; on: cfg.enabled; onFlip: cfg.enabled = !cfg.enabled }
        Toggle { anchors.verticalCenter: parent.verticalCenter; text: "loudness"; on: cfg.loudness; onFlip: cfg.loudness = !cfg.loudness }
    }

    // what the profile actually plays (base settings + profile deltas + loudness), from the daemon
    Lb {
        text: st.health ? `now · bass ${root.db(st.bass ?? 0)} · treble ${root.db(st.treble ?? 0)} · voice ${root.db(st.voice ?? 0)} · gain ${root.db(st.gain_db ?? 0)} dB${st.dolby === false ? " · dolby correction off" : ""}${(st.loud_bass ?? 0) > 0 ? ` · loudness +${st.loud_bass.toFixed(1)}` : ""}`
            : "daemon off · systemctl --user start x1sound"
        px: 10
        color: st.health === "ok" ? Theme.fg : Theme.red
    }

    // base tone (the profile adds to it) and the two speaker pairs straight on the codec (0 dB = 87;
    // the headphones share the bottom DAC). Everything here sits before Dolby's regulator and limiter
    Row {
        spacing: 26
        Dial { size: 110; n: 36; label: "bass"; from: -6; to: 12; step: 1; value: cfg.bass_db; text: root.db(v); onMoved: v => cfg.bass_db = v; opacity: root.toneOn ? 1 : 0.4 }
        Dial { size: 110; n: 28; label: "treble"; from: -6; to: 8; step: 1; value: cfg.treble_db; text: root.db(v); onMoved: v => cfg.treble_db = v; opacity: root.toneOn ? 1 : 0.4 }
        Dial { size: 110; n: 40; label: "gain"; from: 0; to: 20; step: 1; value: cfg.boost_db; text: root.db(v); onMoved: v => cfg.boost_db = v }
        Dial {
            size: 110; n: 20; label: "loudness"; from: 0; to: 1; step: 0.05
            opacity: cfg.loudness ? 1 : 0.4
            value: cfg.loudness_amount; text: Math.round(v * 100) + "%"; onMoved: v => cfg.loudness_amount = v
        }
        Dial { size: 110; n: 24; label: "top"; from: 40; to: 87; step: 1; value: cfg.tweeter; text: root.dac(v); onMoved: v => cfg.tweeter = v; opacity: root.split ? 1 : 0.4 }
        Dial { size: 110; n: 24; label: "bottom"; from: 40; to: 87; step: 1; value: cfg.woofer; text: root.dac(v); onMoved: v => cfg.woofer = v; opacity: root.split ? 1 : 0.4 }
    }

    // EQ presets: one chip each, the one that matches the bands is white; editing a band turns it into "custom"
    Flow {
        width: 925
        spacing: 10
        opacity: root.toneOn ? 1 : 0.4
        Lb { height: 44; verticalAlignment: Text.AlignVCenter; rightPadding: 8; text: `eq · ${root.preset}` }
        Repeater {
            model: root.presets
            Rectangle {
                id: chip
                required property var modelData
                readonly property bool on: root.preset === modelData.name
                width: chipLb.implicitWidth + 32
                height: 44
                radius: Theme.corner(22)
                color: on ? Theme.fg : chipTap.containsMouse ? Theme.s3 : Theme.s2
                Behavior on color { ColorAnimation { duration: 150 } }
                Lb { id: chipLb; anchors.centerIn: parent; text: chip.modelData.name; px: 10; color: chip.on ? Theme.ink : Theme.fg }
                MouseArea { id: chipTap; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: cfg.eq = chip.modelData.eq.slice() }
            }
        }
    }

    // 8-band graphic EQ, ±6 dB per octave band
    Row {
        spacing: 40
        Row {
            spacing: 14
            opacity: root.toneOn ? 1 : 0.4
            Repeater {
                model: root.bands
                EqBand {
                    required property int index
                    required property string modelData
                    label: modelData
                    value: cfg.eq?.[index] ?? 0
                    onPut: x => {
                        const e = (cfg.eq ?? [0, 0, 0, 0, 0, 0, 0, 0]).slice();
                        while (e.length < 8) e.push(0);
                        e[index] = x;
                        cfg.eq = e;
                    }
                }
            }
        }
        Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: 10
            Rectangle {
                width: flatLb.implicitWidth + 48
                height: 52
                radius: Theme.corner(26)
                color: flatTap.pressed ? Theme.fg : Theme.s2
                Lb { id: flatLb; anchors.centerIn: parent; text: "flat eq"; color: flatTap.pressed ? Theme.ink : Theme.fg }
                MouseArea { id: flatTap; anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: cfg.eq = [0, 0, 0, 0, 0, 0, 0, 0] }
            }
            Lb { text: `boosts in use ${(st.budget_db ?? 0).toFixed(1)} of 14 dB`; px: 10; color: Theme.grey }
            Lb { text: "gain above +10 dB compresses · use the volume for loudness"; px: 10; color: Theme.grey }
            Lb { text: "limiter −1 dBFS and 100 Hz high-pass always on"; px: 10; color: Theme.grey }
        }
    }

    readonly property bool toneOn: cfg.enabled && cfg.profile !== "off"
    readonly property bool split: st.routing === "split" || !st.routing
    readonly property var bands: ["125", "250", "500", "1k", "2k", "4k", "8k", "16k"]
}
