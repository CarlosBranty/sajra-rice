import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs

// glyph-tok (TikTok tipo celular, ~/Projects/glyph-tok) en modo fijo: franja reservada a la derecha, como la barra —
// las ventanas en mosaico no entran ahí, en todos los escritorios. La ventana de glyph-tok se coloca sola encima
// (está fijada, pin). Reservamos solo mientras la ventana existe y se ve: oculta o cerrada — las ventanas recuperan el sitio.
// Qt WebEngine no carga en qs, por eso glyph-tok es otro proceso; habla con nosotros por su state.json
Scope {
    id: root

    property string mode: "dock"
    property int width: 520 // px lógicos de la ventana; el hueco exterior de hypr va aparte (gaps)

    FileView {
        path: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/glyph-tok/state.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: {
            try {
                const s = JSON.parse(text());
                root.mode = s.mode ?? "dock";
                root.width = s.dockWidth ?? 520;
            } catch (e) {}
        }
    }

    readonly property var tok: ToplevelManager.toplevels.values.find(t => t.appId === "glyph-tok") ?? null
    readonly property bool on: mode === "dock" && !!tok
    // бар сменил толщину (BAR → thickness/size, стиль, монитор): glyph-tok сам переставит окно по новому reserved
    readonly property int barPx: Theme.barPx(dock.screen)
    onBarPxChanged: if (on) placeT.restart()
    Timer { id: placeT; interval: 300; onTriggered: Quickshell.execDetached([Quickshell.env("HOME") + "/.local/bin/glyph-tok", "place"]) }

    PanelWindow {
        id: dock
        screen: root.tok?.screens?.[0] ?? Quickshell.screens[0]
        visible: root.on
        anchors { right: true; top: true; bottom: true }
        implicitWidth: 1
        // ventana + hueco a su derecha; el hueco de la izquierda lo ponen las ventanas en mosaico (gaps_out)
        exclusiveZone: root.width + 10
        color: "transparent"
        mask: Region {} // no come clics: debajo está la ventana de glyph-tok
        // Overlay, no Background: hypr reparte las zonas exclusivas capa por capa (background → overlay). Si la franja
        // va antes que el bar (Top), el bar y el marco hug se calculan sin ella y quedan cortados a su izquierda
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.namespace: "glyph-tok-dock"
    }
}
