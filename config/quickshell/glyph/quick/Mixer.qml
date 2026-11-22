import QtQuick
import Quickshell
import Quickshell.Services.Pipewire
import qs
import qs.components

// per-app volume mixer under the volume slider (right click on it), like the Windows mixer:
// one row per application, all of its playback streams move together. Click the icon to mute
Rectangle {
    id: root
    signal touched // any click inside pins the panel

    // playback streams of real applications; filter-chain outputs (x1sound DSP) carry no application.name
    readonly property var streams: Pipewire.nodes.values.filter(n => n.isStream && n.audio && (n.type & PwNodeType.AudioOutStream) === PwNodeType.AudioOutStream)
    PwObjectTracker { objects: root.streams }

    readonly property var apps: {
        const by = {};
        for (const n of streams) {
            const name = n.properties["application.name"];
            if (!name) continue;
            if (!by[name]) by[name] = { name, icon: n.properties["application.icon-name"] ?? "", bin: n.properties["application.process.binary"] ?? "", nodes: [] };
            by[name].nodes.push(n);
        }
        return Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
    }

    height: list.height + 32
    radius: Theme.corner(30)
    color: Theme.s2

    Column {
        id: list
        x: 16
        y: 16
        width: parent.width - 32
        spacing: 8

        Lb { x: 4; text: root.apps.length ? `mixer · ${root.apps.length}` : "mixer · nothing playing" }

        Repeater {
            model: root.apps
            Row {
                id: app
                required property var modelData
                readonly property var nodes: modelData.nodes
                readonly property real vol: Math.max(0, ...nodes.map(n => n.audio?.volume ?? 0))
                readonly property bool muted: nodes.every(n => n.audio?.muted ?? false)
                function setVol(v) { for (const n of nodes) if (n.audio) { n.audio.muted = false; n.audio.volume = v; } }
                function toggleMute() { const m = !muted; for (const n of nodes) if (n.audio) n.audio.muted = m; }
                width: list.width
                height: 44
                spacing: 10

                // app icon (icon-name, then desktop entry by binary/name); falls back to the initial
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 44
                    height: 44
                    radius: 22
                    color: app.muted ? Theme.s3 : Theme.s1
                    readonly property string iconName: app.modelData.icon
                        || DesktopEntries.heuristicLookup(app.modelData.bin.replace(/-bin$/, ""))?.icon
                        || DesktopEntries.heuristicLookup(app.modelData.name)?.icon || ""
                    Image {
                        id: ic
                        anchors.centerIn: parent
                        width: 26
                        height: 26
                        sourceSize { width: 52; height: 52 }
                        source: parent.iconName ? Quickshell.iconPath(parent.iconName, true) : ""
                        visible: status === Image.Ready
                        opacity: app.muted ? 0.35 : 1
                    }
                    Text {
                        anchors.centerIn: parent
                        visible: !ic.visible
                        text: app.modelData.name.charAt(0).toUpperCase()
                        font { family: Theme.ui; pixelSize: 18; weight: Font.DemiBold }
                        color: Theme.fg
                    }
                    Icon { visible: app.muted; anchors { right: parent.right; bottom: parent.bottom } text: "\u{F075F}"; font.pixelSize: 14; color: Theme.fg }
                    TapHandler { onTapped: { root.touched(); app.toggleMute(); } }
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                }

                // track: fill — white pill with the app name, empty — s1; value on the right
                Rectangle {
                    id: track
                    anchors.verticalCenter: parent.verticalCenter
                    width: app.width - 54
                    height: 44
                    radius: height / 2
                    color: Theme.s1
                    readonly property real shown: drag.pressed ? drag.v : (app.muted ? 0 : app.vol)
                    Rectangle {
                        width: Math.max(height, track.width * Math.min(1, track.shown))
                        height: parent.height
                        radius: height / 2
                        color: Theme.fg
                    }
                    Text {
                        x: 16
                        anchors.verticalCenter: parent.verticalCenter
                        width: track.width - 70
                        elide: Text.ElideRight
                        textFormat: Text.PlainText
                        text: app.modelData.name
                        font { family: Theme.ui; pixelSize: 14; weight: Font.DemiBold }
                        color: track.shown * track.width > 16 + Math.min(implicitWidth, width) ? Theme.ink : Theme.fg
                    }
                    Lb {
                        anchors { right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter }
                        text: Math.round(track.shown * 100)
                        color: track.shown > 0.88 ? Theme.ink : Theme.grey
                    }
                    MouseArea {
                        id: drag
                        property real v
                        property real wacc: 0
                        anchors.fill: parent
                        preventStealing: true
                        cursorShape: Qt.PointingHandCursor
                        function set(x) { v = Math.max(0, Math.min(1, x / width)); app.setVol(v); }
                        onPressed: e => { root.touched(); set(e.x); }
                        onPositionChanged: e => set(e.x)
                        onWheel: e => {
                            wacc += (e.inverted ? -1 : 1) * (e.angleDelta.y || -e.angleDelta.x) / 120 * 0.05 * (e.phase === Qt.NoScrollPhase ? 1 : 0.25);
                            if (Math.abs(wacc) < 0.02) return;
                            app.setVol(Math.max(0, Math.min(1, track.shown + wacc)));
                            wacc = 0;
                        }
                    }
                }
            }
        }
    }
}
