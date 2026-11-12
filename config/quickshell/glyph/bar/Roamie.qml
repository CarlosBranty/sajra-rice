import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import qs

// Roamies (~/Projects/Roamies) vive en el bar: aquí descansa, en puntos, mientras no está en pantalla. Cuando tiene algo
// que hacer sale de este hueco y luego vuelve a él; mientras está fuera queda solo el contorno. Nos hablamos por dos notas
// en $XDG_RUNTIME_DIR/roamies: dock.json (nuestra: dónde está el hueco) y state.json (suya: si está fuera, y la reescribe
// cada par de segundos — una nota vieja significa que Roamies no corre). Apagado: gris, y el clic lo arranca.
// Clic: hablarle (--talk). Derecho: su panel. Central: llamarlo.
// Archivo aparte y no inline component: un inline component nuevo rompe la recarga en caliente (ver Pile.qml)
Item {
    id: root

    property var screen: null
    width: 27
    height: 27

    readonly property string dir: Quickshell.env("XDG_RUNTIME_DIR") + "/roamies"
    property bool out: false
    property string exe: ""
    property real seen: 0 // cuándo escribió su nota, s
    property real now: Date.now() / 1000
    readonly property bool alive: now - seen < 7
    readonly property bool home: alive && !out
    property bool blink: false

    FileView {
        id: note
        path: root.dir + "/state.json"
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: {
            try {
                const s = JSON.parse(text());
                root.out = !!s.out;
                root.exe = s.exe ?? "";
                root.seen = s.t ?? 0;
                root.now = Date.now() / 1000;
            } catch (e) {} // a medio escribir: vale la anterior
        }
    }

    // con varios monitores hay un bar en cada uno y un solo Roamie: el hueco es el del monitor con foco
    readonly property bool mine: !!screen && (Hyprland.focusedMonitor?.name ?? screen.name) === screen.name
    onMineChanged: if (mine) { sent = ""; place(); }
    property string sent: ""
    property int ticks: 0

    // dónde está el hueco: su centro en px lógicos del monitor (el bar empieza en la esquina del monitor, así que las
    // coordenadas de la ventana son las del monitor). Nadie avisa de «me movieron»: se mira cada 2 s y se escribe si
    // cambió, y una vez por minuto por si borraron la nota. De paso se relee la suya mientras no da señales: el
    // vigilante no ve un archivo que todavía no existía
    function place() {
        now = Date.now() / 1000;
        if (!alive) note.reload();
        if (!mine) return;
        const p = mapToItem(null, width / 2, height / 2);
        const s = JSON.stringify({ monitor: screen.name, x: Math.round(p.x), y: Math.round(p.y), sw: screen.width, sh: screen.height, mx: screen.x, my: screen.y });
        if (s === sent && ++ticks % 30) return;
        sent = s;
        Quickshell.execDetached(["sh", "-c", 'mkdir -p "$1" && printf %s "$2" > "$1/dock.json"', "sh", dir, s]);
    }
    Timer { interval: 2000; running: true; repeat: true; onTriggered: root.place() }
    Timer { interval: 400; running: true; onTriggered: root.place() } // la primera, ya colocado

    // el color de Roamies sigue al shell: la paleta va a $XDG_RUNTIME_DIR/roamies/theme.json (contrato en el README de
    // Roamies) en cada cambio de tema, de claro/oscuro o de fondo, y una vez por minuto por si borraron la nota.
    // Roamies la relee cada par de segundos cuando su ajuste Colors está en System
    readonly property string theme: JSON.stringify({
        light: Theme.light, bg: String(Theme.bg), surface: String(Theme.s1), fg: String(Theme.fg),
        muted: String(Theme.grey), line: String(Theme.s3), accent: String(Theme.accent), danger: String(Theme.red)
    })
    onThemeChanged: themeT.restart()
    Timer {
        id: themeT
        interval: 300
        running: true
        onTriggered: Quickshell.execDetached(["sh", "-c", 'mkdir -p "$1" && printf %s "$2" > "$1/theme.json"', "sh", root.dir, root.theme])
    }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: themeT.restart() }

    // el Roamie en puntos, 7×7: cuerpo redondo y dos ojos (huecos). En casa está vivo: respira, parpadea (a veces dos
    // veces seguidas), mira a un lado o hacia el escritorio y vuelve al frente. Todo al azar, para que no parezca un reloj
    property int lookX: 0  // -1 izquierda, 0 al frente, 1 derecha
    property int lookY: 0  // 1 — hacia abajo
    property int blinks: 0 // cuántos parpadeos quedan en esta tanda
    function body(x, y) { return x >= 0 && x < 7 && y >= 0 && y < 7 && !((x === 0 || x === 6) && (y === 0 || y === 6)); }
    function eyeAt(x, y) { return y === 2 + lookY && (x === 2 + lookX || x === 4 + lookX); }
    function wink(n) { blinks = n; blink = true; open.restart(); }
    onHomeChanged: {
        lookX = 0; lookY = 0; face.y = 0;
        if (home) wink(2); else { blink = false; blinks = 0; } // recién llegado se despabila
    }

    Item {
        id: face
        width: parent.width
        height: parent.height
        SequentialAnimation on y {
            running: root.home
            loops: Animation.Infinite
            NumberAnimation { from: 0; to: -1.4; duration: 1400; easing.type: Easing.InOutSine }
            NumberAnimation { from: -1.4; to: 0; duration: 1400; easing.type: Easing.InOutSine }
        }

        Repeater {
            model: 49

            Rectangle {
                required property int index
                readonly property int cx: index % 7
                readonly property int cy: Math.floor(index / 7)
                readonly property bool eye: root.eyeAt(cx, cy)
                readonly property bool rim: !root.body(cx - 1, cy) || !root.body(cx + 1, cy) || !root.body(cx, cy - 1) || !root.body(cx, cy + 1)
                x: cx * 4
                y: cy * 4
                width: 3
                height: 3
                radius: 1.5
                visible: root.body(cx, cy)
                // en casa: encendido, ojos abiertos. Fuera: solo el contorno. Apagado: todo gris, ojos cerrados
                color: root.home ? (eye && !root.blink ? "transparent" : Theme.fg) : !root.alive || rim ? Theme.s3 : "transparent"
                // sale y entra por abajo: los puntos cambian en ola, fila a fila; los ojos — de golpe
                Behavior on color {
                    enabled: !eye
                    SequentialAnimation { PauseAnimation { duration: root.home ? 0 : cy * 30 } ColorAnimation { duration: root.home ? 90 : 140 } }
                }
            }
        }
    }

    Timer {
        interval: 2400
        running: root.home
        repeat: true
        onTriggered: {
            interval = 1500 + Math.random() * 3000;
            const r = Math.random();
            if (r < 0.5) root.wink(r < 0.14 ? 2 : 1);
            else { root.lookY = r > 0.86 ? 1 : 0; root.lookX = r > 0.86 ? 0 : r < 0.68 ? -1 : 1; front.restart(); }
        }
    }
    Timer { id: open; interval: 150; onTriggered: { root.blink = false; if (--root.blinks > 0) again.restart(); } }
    Timer { id: again; interval: 130; onTriggered: { root.blink = true; open.restart(); } }
    Timer { id: front; interval: 900 + Math.random() * 700; onTriggered: { root.lookX = 0; root.lookY = 0; } }

    MouseArea {
        anchors.fill: parent
        anchors.margins: -6
        acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
        cursorShape: Qt.PointingHandCursor
        onClicked: e => {
            if (!root.exe) return; // aún no se ha presentado en esta sesión: no sabemos qué arrancar
            const arg = !root.alive ? [] : e.button === Qt.RightButton ? ["--panel"] : e.button === Qt.MiddleButton ? ["--summon"] : ["--talk"];
            Quickshell.execDetached([root.exe].concat(arg));
        }
    }
}
