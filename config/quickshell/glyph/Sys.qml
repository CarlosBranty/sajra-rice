pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Bluetooth
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Services.Pipewire
import Quickshell.Services.SystemTray
import Quickshell.Wayland
import qs.services
import qs.settings

// то, что трогают бар, быстрые настройки, Glyph и лок: звук, яркость, раскладка, запись, ночник, авиарежим, кофеин, vpn
Singleton {
    id: root

    // deck (панель снизу) открыта — SysStats нужен подробный опрос, как на пустом воркспейсе (Home)
    property bool deckOpen: false
    // пикер обоев открыт — дом меняет обои сразу, без волны: её уже показал пикер
    property bool wallOpen: false

    // ---- звук ----
    readonly property var sink: Pipewire.defaultAudioSink
    readonly property var mic: Pipewire.defaultAudioSource
    PwObjectTracker { objects: [root.sink, root.mic] }
    readonly property real vol: sink?.audio?.volume ?? 0
    readonly property bool muted: sink?.audio?.muted ?? true
    readonly property bool micOn: !(mic?.audio?.muted ?? true)
    function setVol(v) {
        if (!sink?.audio) return;
        sink.audio.muted = false;
        sink.audio.volume = Math.max(0, Math.min(1, v));
    }
    // микрофон кто-то слушает — центр знака в баре краснеет
    PwNodeLinkTracker { id: micUse; node: root.mic }
    readonly property bool live: rec || micUse.linkGroups.length > 0

    // ---- яркость: общий с demonshot Backlight (устройство ищет brightnessctl) ----
    readonly property real bri: Backlight.value
    readonly property bool hasBri: !!Backlight.dev // нет подсветки (ПК с монитором) — регуляторов яркости нет
    function setBri(v) { Backlight.set(v); }
    Binding { target: Backlight; property: "steps"; value: Theme.state.briSteps }

    // ---- раскладка: старт — main-клавиатура из hyprctl, дальше событие activelayout ----
    property string kbd: ""
    Process {
        running: true
        command: ["hyprctl", "devices", "-j"]
        stdout: StdioCollector { onStreamFinished: root.kbd = JSON.parse(this.text).keyboards.find(k => k.main)?.active_keymap ?? "" }
    }
    Connections {
        target: Hyprland
        function onRawEvent(e) { if (e.name === "activelayout") root.kbd = e.data.slice(e.data.lastIndexOf(",") + 1); }
    }
    readonly property string layout: kbd.slice(0, 2).toLowerCase() // "English (US)" → en

    // ---- запись и авиарежим: их же включают бинды hypr. Ночник — общий с demonshot, в его rules.json
    // запись: один pgrep раз в 3 с (без sh); код выхода 0 — пишет. ponytail: станет заметно — systemd-run --scope ----
    property bool rec: false
    readonly property bool night: Rules.store.night
    property bool air: false
    Process {
        id: poll
        command: ["pgrep", "-f", "^gpu-screen-recorder"]
        onExited: code => root.rec = code === 0
    }
    Timer { running: true; repeat: true; interval: 3000; triggeredOnStart: true; onTriggered: poll.running = true }
    // авиарежим без опроса: `rfkill event` сначала выдаёт все устройства, потом только изменения.
    // op 1 — устройство ушло. Авиарежим — ни одно не разблокировано (как прежнее `rfkill -rno SOFT | grep -qv ^blocked`)
    property var rfSoft: ({}) // idx → soft
    Process {
        running: true
        command: ["rfkill", "event"]
        stdout: SplitParser {
            onRead: l => {
                const m = l.match(/idx (\d+) type \d+ op (\d+) soft (\d+)/);
                if (!m) return;
                const s = Object.assign({}, root.rfSoft);
                if (m[2] === "1") delete s[m[1]]; else s[m[1]] = +m[3];
                root.rfSoft = s;
                root.air = !Object.values(s).some(v => v === 0);
            }
        }
    }

    function sh(c) { Quickshell.execDetached(["sh", "-c", c]); }
    // настройки записи из Theme.state (quick/Rec) → флаги gpu-screen-recorder; их же берёт скриншотилка
    readonly property var recFps: [30, 60, 120]
    function recArgs() {
        const st = Theme.state;
        const a = ["", "default_output", "default_input", "default_output|default_input"][st.recAudio];
        return `-f ${st.recFps} -q ${["medium", "high", "very_high", "ultra"][st.recQuality]} -cursor ${st.recCursor ? "yes" : "no"}` + (a ? ` -a "${a}"` : "");
    }
    // второй раз — стоп. Область — slurp; отменили выбор — gsr не стартует, rec поправит опрос
    function toggleRec() {
        const w = Theme.state.recArea ? `-w region -region "$(slurp -f %wx%h+%x+%y)"` : `-w ${Hyprland.focusedMonitor?.name ?? "screen"}`;
        sh(`pkill -INT -f '^gpu-screen-recorder' || exec gpu-screen-recorder ${w} ${recArgs()} -o "$(xdg-user-dir VIDEOS)/rec-$(date +%F_%H-%M-%S).mp4"`);
        rec = !rec;
    }
    function toggleNight() { Rules.store.night = !night; Rules.night(); }
    function toggleAir() { Quickshell.execDetached(["rfkill", air ? "unblock" : "block", "all"]); air = !air; }
    function toggleMic() { if (mic?.audio) mic.audio.muted = !mic.audio.muted; }

    // ---- наушники Nothing / CMF: шумодав и заряд через ./ear (их RFCOMM-протокол). Спрашиваем при открытии быстрых настроек.
    // ponytail: узнаём по имени, как Gadgetbridge; не Nothing — ear не ответит, ear останется null ----
    readonly property var buds: Bluetooth.devices.values.find(d => d.connected && /^(nothing|cmf|ear)\b/i.test(d.name)) ?? null
    property var ear: null // {mode, l, r, case?}
    onBudsChanged: ear = null
    // сразу после подключения канал ещё не готов — спрашивать раз в 2 с, пока не ответят. ponytail: не Nothing с похожим
    // именем так и будет опрашиваться, пока подключено
    Timer { interval: 2000; repeat: true; running: !!root.buds && !root.ear; onTriggered: root.earRun([]) }
    readonly property var ancModes: [[5, "off"], [7, "transp"], [3, "low"], [2, "mid"], [1, "high"], [4, "auto"]]
    property var earNext: null
    function earRun(a) {
        if (!buds) return;
        const c = [Quickshell.shellPath("ear"), buds.address, ...a];
        if (earP.running) earNext = c;
        else { earP.command = c; earP.running = true; }
    }
    function setAnc(m) { ear = Object.assign({}, ear, { mode: m }); earRun(["mode", m]); }
    Process {
        id: earP
        stdout: StdioCollector { onStreamFinished: { try { root.ear = JSON.parse(text); } catch (e) { root.ear = null; } } }
        onExited: if (root.earNext) { command = root.earNext; root.earNext = null; running = true; }
    }

    // ---- Bluetooth сам не переподключает устройства, когда адаптер включили обратно (пилюля, авиарежим, rfkill).
    // BlueZ сначала рвёт соединения и только потом гасит адаптер (Connected:false за 40–90 мс до Powered:false), так что
    // снимок в момент выключения пуст. Поэтому список подключённых пишем с задержкой: выключение её отменяет, и в
    // btResume остаётся то, что было до. Отключил сам или наушники убрали в кейс — через полсекунды список это примет ----
    readonly property var btOn: Bluetooth.devices.values.filter(d => d.connected).map(d => d.address)
    property var btResume: []
    onBtOnChanged: btKeep.restart()
    Timer { id: btKeep; interval: 500; running: true; onTriggered: if (Bluetooth.defaultAdapter?.enabled && !btResumeT.running) root.btResume = root.btOn }
    Connections {
        target: Bluetooth.defaultAdapter
        function onEnabledChanged() { if (Bluetooth.defaultAdapter.enabled) btResumeT.restart(); else { btKeep.stop(); btResumeT.stop(); } }
    }
    // адаптеру нужно время после включения
    Timer { id: btResumeT; interval: 1500; onTriggered: { for (const d of Bluetooth.devices.values) if (root.btResume.includes(d.address) && !d.connected) d.connect(); } }

    // ---- кофеин: не спать. Ингибитору нужно живое окно — невидимое 0×0, как в demonshot ----
    // remembered in the shell's state (Theme.state), so a restart or reload keeps it as it was
    property bool caffeine: Theme.state.caffeine
    onCaffeineChanged: if (Theme.state.caffeine !== caffeine) Theme.state.caffeine = caffeine
    IdleInhibitor {
        enabled: root.caffeine
        window: PanelWindow {
            implicitWidth: 0
            implicitHeight: 0
            color: "transparent"
            exclusionMode: ExclusionMode.Ignore
            WlrLayershell.namespace: "glyph-caffeine"
            mask: Region {}
        }
    }
    // The Wayland inhibitor counts only while its surface is shown, and a 0×0 one isn't, so hypridle kept counting
    // (lock, screen off, suspend). A logind lock as well, held while caffeine is on: hypridle honours idle locks
    // (ignore_systemd_inhibit is off by default) and `systemctl suspend` is blocked by the sleep one.
    Process {
        running: root.caffeine
        command: ["systemd-inhibit", "--what=idle:sleep", "--who=glyph", "--why=Caffeine", "--mode=block", "sleep", "infinity"]
    }

    // ---- vpn: clash verge через пункты его трея, как договор в demonshot.
    // ponytail: подписи английские (language: en в verge); другой язык — поменять строки ----
    readonly property var verge: SystemTray.items.values.find(i => i.title === "clash-verge" || i.id.includes("clash-verge")) ?? null
    QsMenuOpener { id: vmenu; menu: root.verge?.menu ?? null }
    readonly property var vpnItems: ["System Proxy", "TUN Mode"]
    function vpnItem(l) { return vmenu.children.values.find(e => e.text.startsWith(l)) ?? null; }
    readonly property bool vpn: vpnItems.some(l => vpnItem(l)?.checkState === Qt.Checked)
    property var queue: []
    function toggleVpn() {
        if (!verge) return Quickshell.execDetached(["clash-verge"]); // спит — разбудить
        queue = vpn ? vpnItems.filter(l => vpnItem(l)?.checkState === Qt.Checked) : vpnItems;
        presser.start();
    }
    // verge пересобирает меню после каждого нажатия — по одному
    Timer {
        id: presser
        interval: 350
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            const [l, ...rest] = root.queue;
            root.queue = rest;
            if (l) root.vpnItem(l)?.triggered();
            if (!rest.length) stop();
        }
    }
}
