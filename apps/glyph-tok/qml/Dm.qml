import QtQuick
import QtQuick.Window

// máscara de puntos de glyph (components/Dm.qml): `layer.enabled: true; layer.effect: Dm {}` — el elemento se vuelve una
// matriz de LEDs. El paso va en px físicos (dots): mismo aspecto en el monitor 1× y en la laptop 1.67×, y lo más denso que
// aún se ve como puntos. shaders/dots.frag.qsb: /usr/lib/qt6/bin/qsb --qt6 -o shaders/dots.frag.qsb shaders/dots.frag
ShaderEffect {
    readonly property real dpr: Screen.devicePixelRatio > 0 ? Screen.devicePixelRatio : 1
    // paso de la rejilla, px físicos: en pantallas 1× los px son grandes y 2.5 deja el icono en 8 puntos — cuadrado; 2 aún
    // separa los puntos. En la laptop (1.67×) 2.5 se ve como LEDs
    readonly property real dense: dpr >= 1.5 ? 2.5 : 2
    property real dots: dense
    readonly property real pitch: dots / dpr
    property bool circle: false
    readonly property real circ: circle ? 1 : 0
    // paso par (2 px físicos): punto = un px físico, alineado; impar o fraccionario: centrado, radio 0.38 del paso
    readonly property bool even: Math.abs(dots - Math.round(dots)) < 0.01 && Math.round(dots) % 2 === 0
    readonly property real off: even ? 0.5 / dpr : pitch / 2
    readonly property real rad: even ? 0.5 / dpr : pitch * 0.38
    readonly property real soft: (even ? 0.25 : 0.5) / dpr
    readonly property size size: Qt.size(width, height)
    fragmentShader: Qt.resolvedUrl("shaders/dots.frag.qsb")
}
