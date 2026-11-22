import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Services.Pam
import Quickshell.Wayland
import "lock"

// блокировка — отдельный процесс, как в demonshot: qs -p …/glyph/lock.qml (его зовёт `rice lock`). Разблокировались — выходим.
// Упал шелл — лок живёт; упал лок — Hyprland держит экран закрытым, SUPER+ALT+L поднимает его заново
ShellRoot {
    id: shell
    // hot-reload пересоздаёт WlSessionLock: старый умирает, процесс висит без экрана
    settings.watchFiles: false

    QtObject {
        id: gate
        property string buffer: ""
        property bool fail: false
        property bool leaving: false // пароль принят: поверхность доигрывает уход, потом unlockT снимает лок
        readonly property bool busy: pam.active
        // отпечаток: ждёт пальца всё время, пока лок на экране (finger), touchFail — палец не узнан
        readonly property bool finger: fp.active
        property bool touchFail: false
        property bool touchOk: false // отпечаток принят — значок загорается целиком
        // pam_faillock: после 3 неверных паролей подряд аккаунт заперт на время (по умолчанию 10 мин) — тогда и верный
        // пароль не проходит. Говорим об этом, а не «wrong password»; отпечаток (свой pam без faillock) работает и так
        property bool lockedOut: false
        function submit() {
            if (!buffer || pam.active || leaving) return;
            pam.start();
        }
    }

    PamContext {
        id: pam
        config: "lock"
        configDirectory: Quickshell.shellPath("pam")
        onResponseRequiredChanged: if (responseRequired) respond(gate.buffer)
        onActiveChanged: if (active) gate.lockedOut = false
        // faillock шлёт «The account is locked due to N failed logins…» сообщением-ошибкой
        onMessageChanged: if (messageIsError && /locked/i.test(message)) gate.lockedOut = true
        onCompleted: res => {
            gate.buffer = "";
            if (res === PamResult.Success) {
                gate.leaving = true;
                unlockT.start();
            } else gate.fail = true;
        }
    }
    Timer { id: unlockT; interval: 470; onTriggered: lock.locked = false }

    // отпечаток параллельно паролю: свой pam-контекст (pam/fprint). Не узнал три раза или 30 с без пальца — заново;
    // ответил сразу ошибкой (нет fprintd, нет пальцев, нет считывателя) — больше не трогаем
    PamContext {
        id: fp
        config: "fprint"
        configDirectory: Quickshell.shellPath("pam")
        property real began: 0
        property int quick: 0 // подряд ответов быстрее 2 с: нет fprintd, пальцев или считывателя
        onActiveChanged: if (active) began = Date.now()
        // ждём пальца без конца: 30 с тишины (pam_fprintd отвечает на это ошибкой, не «не совпало») или три промаха — заново.
        // Отказ сразу три раза подряд — считывать нечем, больше не спрашиваем
        onCompleted: res => {
            if (gate.leaving) return;
            if (res === PamResult.Success) {
                gate.touchFail = false;
                gate.touchOk = true;
                gate.leaving = true;
                unlockT.start();
                return;
            }
            fp.quick = Date.now() - fp.began < 2000 ? fp.quick + 1 : 0;
            if (res === PamResult.Failed || res === PamResult.MaxTries) gate.touchFail = true;
            if (fp.quick < 3) fpAgain.start();
        }
        // «не совпало» приходит сообщением посреди попыток
        onMessageChanged: if (messageIsError) gate.touchFail = true
    }
    Timer { id: fpAgain; interval: 800; onTriggered: if (!gate.leaving) fp.start() }

    // светодиод у отпечатка (кнопка питания, tpacpi::power): ждёт пальца — мигает медленно, не узнал — часто ~2.5 с,
    // принят или лок уходит — горит, как обычно. Писать в brightness даёт правило udev (группа video); нет прав — молчит.
    // ponytail: цвет у него один, и читать brightness бесполезно (tpacpi всегда отдаёт 0) — только пишем
    FileView { id: led; path: "/sys/class/leds/tpacpi::power/brightness"; atomicWrites: false; printErrors: false }
    property bool ledOn: true
    onLedOnChanged: led.setText(ledOn ? "255" : "0")
    property bool ledFast: false
    Timer { id: ledFastT; interval: 2500; onTriggered: shell.ledFast = false }
    Connections {
        target: gate
        function onTouchFailChanged() { if (gate.touchFail) { shell.ledFast = true; ledFastT.restart(); } }
        function onLeavingChanged() { if (gate.leaving) shell.ledOn = true; }
    }
    Timer {
        running: gate.finger && !gate.leaving
        interval: shell.ledFast ? 120 : 800
        repeat: true
        onTriggered: shell.ledOn = !shell.ledOn
        onRunningChanged: if (!running) shell.ledOn = true
    }
    Process {
        running: true
        command: ["sh", "-c", "test -e /usr/lib/security/pam_fprintd.so && command -v fprintd-list >/dev/null"]
        onExited: code => { if (code === 0) fp.start(); }
    }

    property string layout: "en"
    function short(name) { return name.slice(0, 2).toLowerCase(); }
    Process {
        running: true
        command: ["sh", "-c", "hyprctl devices -j | jq -r '.keyboards[] | select(.main) | .active_keymap'"]
        stdout: StdioCollector { onStreamFinished: if (text.trim()) shell.layout = shell.short(text.trim()) }
    }
    Connections {
        target: Hyprland
        function onRawEvent(e) { if (e.name === "activelayout") shell.layout = shell.short(e.data.split(",").pop()); }
    }

    WlSessionLock {
        id: lock
        locked: true
        // ponytail: lockedChanged после locked = false не приходит (quickshell 0.3.2), а secure падает — выходим по нему
        onSecureChanged: if (!secure) Qt.quit()

        LockSurface { auth: gate; layout: shell.layout }
    }
}
