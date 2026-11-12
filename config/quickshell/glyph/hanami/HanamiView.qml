import QtQuick
import qs
import qs.components

// what the panel shows: the header (name, what's going on, updates, quit), the pages down the left as words (the open
// one white with a red dot, as the prefs' sections) and the open page. Hanami not running: says so, and waits for it.
// Esc closes what's open, then the panel; ↑↓ on the page words walk them
FocusScope {
    id: root

    readonly property var s: Hanami.state
    readonly property var u: s?.update ?? null

    // ---- the header's update button: Check for updates, then Update to x, then Done. "Up to date" for a few seconds ----
    property real clock: Date.now()
    Timer { interval: 1000; repeat: true; running: Hanami.shown && !!root.u?.result; onTriggered: root.clock = Date.now() }
    readonly property bool fresh: !!u?.result?.ok && clock - (u.result.at ?? 0) < 6000
    readonly property var upd: !u || u.off ? null
        : u.done ? ["Done", false]
        : u.installing ? ["Updating…", false]
        : u.available ? [u.page ? `Get ${u.available}` : `Update to ${u.available}`, true]
        : u.checking ? ["Checking…", false]
        : fresh ? ["Up to date", false]
        : u.result ? ["Check again", true]
        : ["Check for updates", true]
    property bool quitArmed: false
    Timer { id: quitTimer; interval: 4000; onTriggered: root.quitArmed = false }
    Connections {
        target: Hanami
        function onShownChanged() { root.quitArmed = false; }
    }

    Keys.onPressed: e => {
        if (e.key === Qt.Key_Escape) Hanami.back();
        else return;
        e.accepted = true;
    }

    // ---- header ----
    Item {
        id: head
        x: 32
        y: 28
        width: parent.width - 64
        height: 64

        Row {
            anchors.verticalCenter: parent.verticalCenter
            spacing: 18
            Num { anchors.verticalCenter: parent.verticalCenter; text: (root.s?.name ?? "Hanami").toLowerCase(); font.pixelSize: 44 }
            Column {
                anchors.verticalCenter: parent.verticalCenter
                spacing: 4
                Row {
                    spacing: 8
                    Rectangle {
                        id: led
                        anchors.verticalCenter: parent.verticalCenter
                        width: 8
                        height: 8
                        radius: 4
                        readonly property string st: root.s?.status?.state ?? "off"
                        color: st === "ready" ? Theme.accent : st === "busy" ? Theme.fg : Theme.mute
                        SequentialAnimation on opacity {
                            running: led.st === "busy" && Hanami.shown
                            loops: Animation.Infinite
                            alwaysRunToEnd: true
                            NumberAnimation { to: 0.2; duration: 500 }
                            NumberAnimation { to: 1; duration: 500 }
                        }
                    }
                    Text {
                        width: Math.min(implicitWidth, head.width - 420)
                        elide: Text.ElideRight
                        textFormat: Text.PlainText
                        text: !root.s ? "Not running" : (root.s.status?.text ?? "")
                            + (root.s.model ? ` · ${root.s.model.name}` : root.s.status?.state === "off" ? " · Sign in on the Model page" : "")
                        font { family: Theme.ui; pixelSize: 14; weight: Font.Medium }
                        color: Theme.fg
                    }
                }
                Lb { visible: !!root.s?.version; text: `v${root.s?.version ?? ""}`; px: 10 }
            }
        }
        Row {
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            spacing: 10
            Btn {
                visible: !!root.upd
                small: true
                text: root.upd?.[0] ?? ""
                primary: !!root.u?.available && !root.u?.installing && !root.u?.done
                enabled: !!root.upd?.[1]
                onClicked: Hanami.act(root.u?.available ? "install_update" : "update")
            }
            Btn {
                visible: !!root.s
                small: true
                text: root.quitArmed ? "Confirm" : "Quit"
                Accessible.name: root.quitArmed ? "Confirm: quit Hanami" : "Quit Hanami"
                onClicked: {
                    if (root.quitArmed) {
                        root.quitArmed = false;
                        Hanami.act("quit");
                        return;
                    }
                    root.quitArmed = true;
                    quitTimer.restart();
                }
            }
        }
    }

    // ---- the pages ----
    Column {
        id: side
        x: 32
        y: head.y + head.height + 40
        width: 150
        spacing: 16
        visible: !!root.s
        Repeater {
            id: words
            model: Hanami.pages
            Item {
                id: word
                required property var modelData
                required property int index
                readonly property bool on: Hanami.page === modelData[0]
                // a page that needs you: no account to answer with
                readonly property bool flag: modelData[0] === "model" && root.s?.status?.state === "off"
                width: side.width
                height: 22
                activeFocusOnTab: true
                Accessible.role: Accessible.PageTab
                Accessible.name: modelData[1] + (flag ? " (not signed in)" : "")
                Keys.onPressed: e => {
                    const n = Hanami.pages.length;
                    const j = e.key === Qt.Key_Down ? (index + 1) % n : e.key === Qt.Key_Up ? (index + n - 1) % n
                        : e.key === Qt.Key_Home ? 0 : e.key === Qt.Key_End ? n - 1 : -1;
                    if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter || e.key === Qt.Key_Space) Hanami.show(modelData[0]);
                    else if (j >= 0) {
                        Hanami.show(Hanami.pages[j][0]);
                        words.itemAt(j)?.forceActiveFocus();
                    } else return;
                    e.accepted = true;
                }
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: word.on
                    width: 10
                    height: 10
                    radius: 5
                    color: word.activeFocus ? Theme.fg : Theme.accent
                }
                Lb {
                    x: 22
                    anchors.verticalCenter: parent.verticalCenter
                    text: word.modelData[1]
                    px: 13
                    color: word.on ? Theme.fg : hov.hovered || word.activeFocus ? Theme.grey : Theme.mute
                    Behavior on color { ColorAnimation { duration: Theme.t / 2 } }
                }
                Rectangle {
                    visible: word.flag
                    anchors { right: parent.right; rightMargin: 8; verticalCenter: parent.verticalCenter }
                    width: 6
                    height: 6
                    radius: 3
                    color: Theme.red
                }
                HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: Hanami.show(word.modelData[0]) }
            }
        }
    }

    Flickable {
        id: flick
        visible: !!root.s
        anchors { left: side.right; leftMargin: 28; right: parent.right; rightMargin: 32; top: side.top; bottom: foot.top; bottomMargin: 16 }
        contentWidth: width
        contentHeight: page.height + 24
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Loader {
            id: page
            width: flick.width
            sourceComponent: ({ home: homeC, memory: memoryC, model: modelC, appearance: appearanceC, voice: voiceC,
                money: moneyC, behavior: behaviorC, about: aboutC })[Hanami.page] ?? homeC
            onLoaded: { flick.contentY = 0; enter.restart(); }
        }
        // a page comes in from a little below
        ParallelAnimation {
            id: enter
            NumberAnimation { target: page; property: "opacity"; from: 0; to: 1; duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide }
            NumberAnimation { target: page; property: "y"; from: 16; to: 0; duration: Theme.t; easing.type: Easing.BezierSpline; easing.bezierCurve: Theme.glide }
        }
    }
    Component { id: homeC; HomePage {} }
    Component { id: memoryC; MemoryPage {} }
    Component { id: modelC; ModelPage {} }
    Component { id: appearanceC; AppearancePage {} }
    Component { id: voiceC; VoicePage {} }
    Component { id: moneyC; MoneyPage {} }
    Component { id: behaviorC; BehaviorPage {} }
    Component { id: aboutC; AboutPage {} }

    // ---- Hanami isn't running ----
    Column {
        visible: !root.s
        anchors.centerIn: parent
        width: parent.width - 120
        spacing: 16
        Icon { anchors.horizontalCenter: parent.horizontalCenter; text: "\u{F0164}"; font.pixelSize: 48; color: Theme.mute }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            text: Hanami.linked ? "Waiting for Hanami…" : "Hanami isn't running"
            font { family: Theme.ui; pixelSize: 22; weight: Font.Medium }
            color: Theme.fg
        }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            text: "Start it and this panel connects by itself."
            font { family: Theme.ui; pixelSize: 14 }
            color: Theme.grey
        }
    }

    // ---- a note, and the keys ----
    Item {
        id: foot
        anchors { left: parent.left; leftMargin: 32; right: parent.right; rightMargin: 32; bottom: parent.bottom; bottomMargin: 26 }
        height: 22
        Text {
            anchors { left: parent.left; right: keys.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
            text: Hanami.noteText
            textFormat: Text.PlainText
            elide: Text.ElideRight
            font { family: Theme.ui; pixelSize: 13; weight: Font.Medium }
            color: Hanami.noteBad ? Theme.red : Theme.fg
            opacity: Hanami.noteText ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: Theme.t } }
        }
        Lb {
            id: keys
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            text: "esc close"
            TapHandler { onTapped: Hanami.close() }
        }
    }
}
