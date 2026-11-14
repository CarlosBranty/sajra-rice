import QtQuick
import Quickshell
import Quickshell.Io
import qs
import qs.components

// настройки музыки (⚙ в шапке панели): папка локальной библиотеки и сервер Qodi Music.
// Папка → ~/.config/musica/music-dir (её читают musica и musica-index); пусто — папка «Музыка» системы.
// Сервер → musica-remote login: пароль уходит через окружение процесса (не в argv), не сохраняется — остаётся только токен
Column {
    id: root

    required property string bin
    property string dir          // выбранная папка, "" — по умолчанию
    property string indexed     // папка, которую реально проиндексировали
    property int localCount
    property var remote          // ~/.cache/musica/remote.json
    property string remoteNote
    signal dirSaved

    readonly property bool connected: !!remote?.server && remote?.error !== "not_logged_in" && remote?.error !== "login_expired"
    property string msg          // ответ последней команды сервера

    spacing: 14

    // --- локальная библиотека
    Lb { x: 6; text: "local library" }
    MusicField {
        id: dirField
        width: root.width
        label: "music folder"
        hint: "default · system Music folder"
        text: root.dir
        onAccepted: saveDir.go()
    }
    Item {
        width: root.width
        height: 40
        Lb {
            anchors { left: parent.left; leftMargin: 6; right: dirBtn.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
            px: 10
            elide: Text.ElideMiddle
            text: root.indexed ? `${root.localCount} songs in ${root.indexed.replace(Quickshell.env("HOME"), "~")}` : "not indexed yet"
        }
        MusicPill {
            id: dirBtn
            anchors.right: parent.right
            main: true
            text: "save"
            busy: saveDir.running
            enabled: dirField.text.trim() !== root.dir
            onClicked: saveDir.go()
        }
    }
    Process {
        id: saveDir
        function go() {
            command = ["sh", "-c", 'mkdir -p "$1" && printf "%s\\n" "$2" > "$1/music-dir"', "_",
                       (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/musica", dirField.text.trim()];
            running = true;
        }
        onExited: root.dirSaved()
    }

    Rectangle { width: root.width; height: 1; color: Theme.s2 }

    // --- сервер
    Lb { x: 6; text: "qodi music server" }

    // подключён: кто, сколько песен, синхронизировать / отключить
    Column {
        visible: root.connected
        width: root.width
        spacing: 12
        Column {
            x: 6
            width: parent.width - 12
            spacing: 2
            Text { width: parent.width; elide: Text.ElideMiddle; textFormat: Text.PlainText; text: root.remote?.server ?? ""; font { family: Theme.ui; pixelSize: 15; weight: Font.DemiBold } color: Theme.fg }
            Lb { width: parent.width; elide: Text.ElideRight; px: 10; text: `${root.remote?.user ?? ""} · ${(root.remote?.tracks ?? []).length} songs` }
            Lb { width: parent.width; wrapMode: Text.Wrap; px: 10; visible: !!root.remoteNote; text: root.remoteNote; color: Theme.accent }
        }
        Row {
            spacing: 10
            MusicPill { text: "sync"; busy: remoteCmd.running && remoteCmd.verb === "sync"; enabled: !remoteCmd.running; onClicked: remoteCmd.go("sync", []) }
            MusicPill { text: "disconnect"; enabled: !remoteCmd.running; onClicked: remoteCmd.go("logout", []) }
        }
    }

    // не подключён или сессия истекла: адрес, логин, пароль
    Column {
        visible: !root.connected
        width: root.width
        spacing: 12
        MusicField { id: url; width: parent.width; label: "server url"; hint: "https://music.example.com"; text: root.remote?.server ?? "" }
        MusicField { id: user; width: parent.width; label: "user"; hint: "username"; text: root.remote?.user ?? "" }
        MusicField { id: pass; width: parent.width; label: "password"; hint: "password"; secret: true; onAccepted: connect.clicked() }
        Item {
            width: parent.width
            height: 40
            Lb {
                anchors { left: parent.left; leftMargin: 6; right: connect.left; rightMargin: 10; verticalCenter: parent.verticalCenter }
                px: 10
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
                color: Theme.accent
                text: root.remote?.error === "login_expired" ? "session expired · sign in again" : ""
            }
            MusicPill {
                id: connect
                anchors.right: parent.right
                main: true
                text: "connect"
                busy: remoteCmd.running
                enabled: !!url.text.trim() && !!user.text.trim() && !!pass.text
                onClicked: remoteCmd.go("login", [url.text.trim(), user.text.trim()], pass.text)
            }
        }
    }

    Lb { x: 6; width: root.width - 12; wrapMode: Text.Wrap; px: 10; visible: !!root.msg; text: root.msg }

    Process {
        id: remoteCmd
        property string verb
        function go(v, args, password) {
            verb = v;
            root.msg = "";
            environment = password ? { MUSICA_REMOTE_PASSWORD: password } : {};
            command = [root.bin + "musica-remote", v].concat(args);
            running = true;
        }
        stderr: StdioCollector { id: err }
        onExited: code => {
            pass.text = "";
            if (code !== 0) root.msg = err.text.trim().split("\n").pop() || `${verb} failed`;
        }
    }
}
