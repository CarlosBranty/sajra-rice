import QtQuick

// botón redondo de la barra, icono en puntos (Dm): on — relleno fg (como «encendido» en glyph), si no — transparente con hover s2
Rectangle {
    id: root

    property string icon
    property bool on: false
    property real size: 32
    property string tip: ""
    property real dot: -1 // paso de la matriz de puntos, px físicos; -1 = el de Dm según la pantalla
    signal clicked

    width: size
    height: size
    radius: size / 2
    color: on || ma.pressed ? Theme.fg : ma.containsMouse ? Theme.s2 : "transparent"
    Behavior on color { ColorAnimation { duration: Theme.t / 2 } }

    Text {
        anchors.centerIn: parent
        text: root.icon
        font { family: Theme.nf; pixelSize: root.size * 0.66 }
        // icono en puntos, como los de glyph (máscara Dm, rejilla densa en px físicos)
        layer.enabled: true
        layer.effect: Dm { dots: root.dot > 0 ? root.dot : dense }
        // la fuente NF tiene renglón alto: recentrar como Icon de glyph
        topPadding: -0.16 * font.pixelSize
        bottomPadding: -0.16 * font.pixelSize
        color: root.on || ma.pressed ? Theme.ink : Theme.fg
    }
    MouseArea {
        id: ma
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.clicked()
    }
}
