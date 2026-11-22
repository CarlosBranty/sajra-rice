pragma Singleton

import Quickshell
import Quickshell.Io
import QtQuick
import qs

// límite de carga de la batería (thinkpad_acpi: charge_control_{start,end}_threshold, como "conservación" en Lenovo Vantage).
// Para en limit %, vuelve a cargar por debajo de limit − 5. 100 = sin límite (start 0, end 100). Los umbrales viven en el EC
// del ThinkPad y sobreviven al reinicio; igual se reaplican al arrancar desde Theme.state.chargeLimit.
// Escribir en sysfs es de root: /etc/udev/rules.d/90-glyph-charge.rules da g+w al grupo wheel (writable lo comprueba)
Singleton {
    id: root

    readonly property string bat: "/sys/class/power_supply/BAT0"
    property bool supported: false
    property bool writable: false
    property int start: 0
    property int end: 100
    readonly property int limit: Math.max(50, Math.min(100, Theme.state.chargeLimit || 100))
    readonly property int resume: limit < 100 ? limit - 5 : 0

    function read() { probe.running = true; }
    // start a 0 primero: el EC rechaza start ≥ end al bajar o subir el límite
    function apply() {
        if (!writable) return;
        put.command = ["sh", "-c", `echo 0 > ${bat}/charge_control_start_threshold; echo ${limit} > ${bat}/charge_control_end_threshold; `
            + `echo ${resume} > ${bat}/charge_control_start_threshold`];
        put.running = true;
    }
    onLimitChanged: if (writable && (end !== limit || start !== resume)) apply()

    Process {
        id: probe
        command: ["sh", "-c", `f=${root.bat}/charge_control_end_threshold; [ -e "$f" ] || exit 1; `
            + `cat ${root.bat}/charge_control_start_threshold "$f"; [ -w "$f" ] && echo w || echo r`]
        stdout: StdioCollector {
            onStreamFinished: {
                const l = text.trim().split("\n");
                root.supported = l.length === 3;
                if (!root.supported) return;
                root.start = parseInt(l[0]);
                root.end = parseInt(l[1]);
                root.writable = l[2] === "w";
                // al arrancar (o al dar el permiso): el EC tiene otros umbrales que los guardados — los nuestros
                if (root.writable && (root.end !== root.limit || root.start !== root.resume) && !put.running) root.apply();
            }
        }
    }
    Process { id: put; onExited: root.read() }
    Component.onCompleted: read()
}
