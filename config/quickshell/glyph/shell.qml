//@ pragma IconTheme Rice
// тема значков своя, а не из qtengine: не загрузился он — Qt ищет только в hicolor, и у kcalc и т.п. пустые круги (#11)
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "bar"
import "buds"
import "cal"
import "charms"
import "clip"
import "deck"
import "glyph"
import "hanami"
import "home"
import "launcher"
import "music"
import "power"
import "prefs"
import "quick"
import "settings"
import "shot"
import "tok"
import "vpn"
import "wall"
import qs.services

// glyph: rice в духе nothing os. Дом на обоях, бар, лаунчер, быстрые настройки,
// Glyph-полосы по краям вместо OSD, остров уведомлений, меню питания, настройки, deck (дашборд снизу), буфер обмена, чары (эмодзи и символы), скриншоты, vpn, обои. Блокировка — отдельный процесс (lock.qml).
// Переключается с demonshot через `rice switch` / приложение Rice — бинды hypr общие (shell:*), каждый шелл берёт свои
ShellRoot {
    id: shell

    Launcher { id: launcher }
    Quick { id: quick; onPowerRequested: power.open(); onSettingsRequested: prefs.open(); onMusicRequested: music.open = true }
    Music { id: music }
    TokDock {}
    Power { id: power }
    Prefs { id: prefs; onWallRequested: walls.open() }
    Glyph {}
    Buds {}
    Cal { id: cal }
    Clip { id: clip }
    Charms { id: charms }
    Deck { id: deck }
    Shot { id: shot }
    Vpn { id: vpn }
    Walls { id: walls }
    // Hanami (the assistant, optional): its settings as a glyph side panel. Stays shut and quiet without Hanami running
    HanamiPanel { id: hanami }

    Variants {
        model: Quickshell.screens
        Scope {
            id: s
            required property var modelData
            Back { screen: s.modelData }
            // бар и дом можно снять с экрана (настройки → display), обои остаются. Здесь, а не в окне: visible от своего
            // screen — петля (окно пересоздаётся, screen меняется)
            Home { screen: s.modelData; visible: Theme.scr(s.modelData.name, "home") }
            Hot { screen: s.modelData; onTriggered: quick.peek() }
            Bar {
                screen: s.modelData
                visible: Theme.scr(s.modelData.name, "bar")
                onMarkClicked: launcher.toggle()
                onTrayClicked: quick.toggle()
                onPowerClicked: power.visible ? power.close() : power.open()
                onClockClicked: cal.toggle()
            }
        }
    }

    // hypr как у demonshot: его Rules (settings/Rules.qml, тот же ~/.config/demonshot/rules.json) ставит монитор, ввод,
    // движение, ночник и hypridle; сверху Theme.apply — свои цвета рамок, скругление и kitty. Его же зовём при смене темы
    Component.onCompleted: {
        hypr();
        // rice start points the links at term/ (dark glyph): a palette of its own or light needs its colours back
        if (Theme.state.paint || Theme.light) Theme.apps();
        else Theme.system();
        Rules.night();
        Rules.idle();
        Charge.read(); // límite de carga guardado → al EC de la batería
        paletteFile.setText(palette);
    }
    // то, что живёт в конфиге hypr. Он перечитывает его сам: сохранили любой файл hypr (ссылки живые — и git pull, и смена
    // ветки), hyprctl reload — и возвращает умолчания variables.lua: рамки demonshot, монитор, ввод, анимации. Накладываем
    // своё заново. hyprctl eval configreloaded не шлёт — петли нет. Ночник и hypridle — свои процессы, reload их не трогает
    function hypr() {
        Rules.monitor();
        Rules.input();
        Rules.motion();
        Theme.apply();
    }
    Connections {
        target: Hyprland
        function onRawEvent(e) { if (e.name === "configreloaded") shell.hypr(); }
    }
    // подключили экран — его масштаб и герцы из prefs → display (Rules.store.outs)
    Connections {
        target: Quickshell
        function onScreensChanged() { Rules.monitor(true); }
    }
    Connections {
        target: Theme
        function onGreysChanged() { paint.restart(); }
    }
    // сменились тема или цвет (style, новые обои) — окна, kitty, gtk и qt. Через 300 мс: тона новых обоев приходят не сразу,
    // а gtk не стоит дёргать дважды
    Timer { id: paint; interval: 300; onTriggered: { Theme.apply(); Theme.apps(); } }
    // тона обоев (Theme.pick) — здесь, не в Theme: его грузит и лок, ему хватает готовых из glyph.json. Пусто — копия обоев не
    // загрузилась (серые дают 16 цветов): старые тона остаются. Новые обои — с первого тона
    ColorQuantizer {
        source: Theme.url(Theme.wallSrc(Theme.wall))
        depth: 4
        rescaleSize: 64
        onColorsChanged: {
            if (!colors.length) return;
            const t = Theme.pick(colors);
            if (t.join() === Theme.state.tones.join()) return;
            Theme.state.tones = t;
            Theme.state.paintAt = 0;
        }
    }
    Connections {
        target: Theme.state
        function onRoundingChanged() { Theme.apply(); }
    }
    // режим ultra включает/снимает blur и тени поверх настроек — окна перекрасить (герцы и движение ставит сам Rules.setMode).
    // Игровой — то же и ещё анимации
    Connections {
        target: Rules.store
        function onUltraChanged() { Theme.apply(); }
        function onGameChanged() { Rules.motion(); Theme.apply(); }
    }

    // тап Super — лаунчер на отпускании; любой Super+<key> по пути шлёт interrupt, и лаунчер не открывается
    property bool interrupted: false
    Shortcut {
        name: "launcher"
        description: "лаунчер (тап Super)"
        onReleased: {
            if (!shell.interrupted) launcher.toggle();
            shell.interrupted = false;
        }
    }
    Shortcut { name: "launcherArm"; description: "нажатие Super — сброс interrupt"; onPressed: shell.interrupted = false }
    Shortcut { name: "launcherInterrupt"; description: "Super+<key> — не открывать лаунчер"; onPressed: shell.interrupted = true }
    // Super+Space (алтарь у demonshot) — deck, дашборд снизу: лаунчер и так на тапе Super
    Shortcut { name: "altar"; description: "deck: дашборд снизу"; onPressed: deck.toggle() }
    Shortcut { name: "quick"; description: "быстрые настройки"; onPressed: quick.toggle() }
    Shortcut { name: "ward"; description: "быстрые настройки"; onPressed: quick.toggle() } // Super+N у demonshot — те же тумблеры
    Shortcut { name: "settings"; description: "настройки"; onPressed: prefs.toggle() }
    Shortcut { name: "power"; description: "меню питания"; onPressed: power.visible ? power.close() : power.open() }
    Shortcut { name: "shot"; description: "скриншот"; onPressed: shot.open() }
    Shortcut { name: "pact"; description: "vpn: clash verge"; onPressed: vpn.toggle() }
    Shortcut { name: "clip"; description: "буфер обмена"; onPressed: clip.toggle() }
    Shortcut { name: "charms"; description: "эмодзи, каомодзи, символы"; onPressed: charms.toggle() }
    Shortcut { name: "wall"; description: "обои"; onPressed: walls.toggle() }
    Shortcut { name: "music"; description: "музыка: плеер и библиотека ~/Music"; onPressed: music.toggle() }
    Shortcut { name: "game"; description: "игровой режим"; onPressed: Rules.store.game = !Rules.store.game }
    Shortcut { name: "hanami"; description: "hanami: its settings panel"; onPressed: hanami.toggle() }

    // палитра наружу — для своих приложений вне шелла (glyph-tok: Qt WebEngine в qs не грузится, живёт отдельным процессом).
    // Пишется при каждой смене темы, светлой/тёмной, обоев
    readonly property string palette: JSON.stringify({
        light: Theme.light,
        bg: String(Theme.bg), s1: String(Theme.s1), s2: String(Theme.s2), s3: String(Theme.s3),
        mute: String(Theme.mute), grey: String(Theme.grey), fg: String(Theme.fg), ink: String(Theme.ink),
        accent: String(Theme.accent), red: String(Theme.red), corners: Theme.state.corners
    })
    onPaletteChanged: paletteFile.setText(palette)
    FileView { id: paletteFile; path: Theme.riceState + "/glyph/palette.json"; printErrors: false }

    component Shortcut: GlobalShortcut { appid: "shell" }
}
