pragma Singleton
import QtQuick

// lo mismo que Theme de glyph, pero leído de palette.json (lo escribe shell.qml; Main lo enlaza en pal).
// Valores por defecto = glyph claro, por si el shell no está corriendo
QtObject {
    property var pal: ({})

    readonly property bool light: pal.light ?? true
    readonly property color bg: pal.bg ?? "#E9E9E9"
    readonly property color s1: pal.s1 ?? "#FFFFFF"
    readonly property color s2: pal.s2 ?? "#F1F1F1"
    readonly property color s3: pal.s3 ?? "#D9D9D9"
    readonly property color mute: pal.mute ?? "#B8B8B8"
    readonly property color grey: pal.grey ?? "#6E6E6E"
    readonly property color fg: pal.fg ?? "#0B0B0B"
    readonly property color ink: pal.ink ?? "#FFFFFF"
    readonly property color accent: pal.accent ?? "#D71921"
    readonly property color red: pal.red ?? "#D71921"
    // esquinas: % de las propias, como Theme.corner en glyph
    function corner(r) { return r * (pal.corners ?? 100) / 100; }

    readonly property string ui: "Space Grotesk"
    readonly property string mono: "Space Mono"
    readonly property string nf: "JetBrainsMono Nerd Font"
    readonly property string dot: "Doto"
    readonly property int t: 350
    readonly property var glide: [0.25, 1, 0.5, 1, 1, 1]
}
