pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// Hanami (the assistant, formerly Roamies): the link to its native panel. Hanami listens on a Unix socket, one JSON
// object per line both ways. It sends the same messages its web panel gets through window.__panel(msg) (state, money,
// note, copied…) plus {kind:"open"} and {kind:"close"}; the panel sends back what the web panel passes to sidecar_send
// ({type:"menu", id}, panel_open, panel_key, panel_money…) and {type:"panel_hide"} when it closes itself.
// Hanami not running: no socket file, so it looks again every 3 s, quietly.
// HANAMI_PANEL_SOCK overrides the path (tests); the default is the contract's.
Singleton {
    id: root

    readonly property string path: Quickshell.env("HANAMI_PANEL_SOCK")
        || (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/roamies/panel.sock"
    readonly property bool linked: sock.connected
    // everything Hanami shows, as it last sent it; null until it does (and again when it goes away)
    property var state: null

    // ---- the panel: open or not, its page and what's open on it (the same as panel.js's ui) ----
    property bool shown: false
    property string page: "home"
    readonly property var pages: [["home", "Home"], ["memory", "Memory"], ["model", "Model"], ["appearance", "Appearance"],
        ["voice", "Voice"], ["money", "Money"], ["behavior", "Behavior"], ["about", "About"]]
    property string arm: ""      // the row action waiting for its Confirm (4 s)
    property string key: ""      // the key or phrase field open: a provider id, "fish" or "wake"
    property var kinds: ({})     // the kind of key picked per provider (Kimi, Xiaomi)
    property string dd: ""       // the dropdown open, one at a time
    property string mtab: "facts"
    property string vtab: "replies"
    property string atab: "look"
    property string ytab: "moves"
    property string mprov: "gmail"
    property string q: ""        // Memory's search
    property var bindShown: []   // shortcut commands shown after copying them failed
    // Money's table as the sidecar last sent it, its filters (category: "" every one, "null" not classified, else the
    // name as JSON), page and selected rows, the category picked for them or a new one being typed, a rename going on
    property var mview: null
    property string mmonth: ""
    property string mcat: ""
    property string mgroup: "all"
    property string mtext: ""
    property int mpage: 0
    readonly property int mper: 10
    property var msel: []
    property string mput: ""     // the category picked for the selected rows (a name)
    property bool mnew: false
    property bool mren: false
    property var mform: ({ kind: "expense", amount: "", currency: "PEN", description: "", date: "", category: "" })

    // the clock for "2m" on the recent list
    property real now: Date.now()
    Timer { interval: 30000; repeat: true; running: root.shown; onTriggered: root.now = Date.now() }

    // ---- a short line at the bottom of the panel ----
    property string noteText: ""
    property bool noteBad: false
    function note(text, bad) {
        noteText = text;
        noteBad = !!bad;
        noteTimer.interval = bad ? 9000 : 5000;
        noteTimer.restart();
    }
    Timer { id: noteTimer; onTriggered: root.noteText = "" }

    // ---- open and close ----
    function open() {
        if (!shown) {
            shown = true;
            now = Date.now();
        }
        if (linked) send({ type: "panel_open" });
        else retryNow();
        if (page === "money") moneyAsk();
    }
    // the panel closing itself: Hanami is told
    function close() {
        if (!shown) return;
        reset();
        shown = false;
        send({ type: "panel_hide" });
    }
    function toggle() { shown ? close() : open(); }
    function reset() {
        arm = "";
        key = "";
        dd = "";
    }

    function show(name) {
        if (!pages.some(p => p[0] === name)) name = name === "settings" ? "model" : "home";
        if (name === page) return;
        page = name;
        reset();
        if (name === "money") moneyAsk();
    }

    // ---- to Hanami ----
    function send(msg) {
        if (!sock.connected || !msg || String(msg.type ?? "").startsWith("auth")) return;
        sock.write(JSON.stringify(msg) + "\n");
        sock.flush();
    }
    // an action from the menu's list. away: it happens on the desktop, so the panel steps aside first
    function act(id, away) {
        if (away) close();
        send({ type: "menu", id: id });
    }
    // asks first in the same spot: the first press arms it (4 s), the second does it
    function armed(k, id) {
        if (arm === k) {
            arm = "";
            act(id);
            return;
        }
        arm = k;
        armTimer.restart();
    }
    Timer { id: armTimer; interval: 4000; onTriggered: root.arm = "" }

    // Esc: the innermost thing open closes first, then the panel
    function back() {
        if (dd) dd = "";
        else if (page === "money" && (msel.length || mren)) { clearSel(); mren = false; }
        else if (key || arm) { key = ""; arm = ""; }
        else close();
    }

    // ---- money ----
    function mquery() {
        const o = { month: mmonth, group: mgroup, text: mtext.trim().slice(0, 200), page: mpage, per: mper };
        if (mcat !== "") o.category = JSON.parse(mcat);
        return o;
    }
    function moneyDo(op, args) { send(Object.assign({ type: "panel_money", op: op }, args ?? {}, { query: mquery() })); }
    function moneyAsk() { moneyDo("list"); }
    function askFirst() { note("Confirm it is you: the prompt is by your Hanami."); }
    function clearSel() {
        msel = [];
        mnew = false;
    }
    function toggleSel(id) {
        msel = msel.includes(id) ? msel.filter(x => x !== id) : msel.concat([id]);
        mnew = false;
    }
    function filter(patch) {
        if ("month" in patch) mmonth = patch.month;
        if ("cat" in patch) mcat = patch.cat;
        if ("group" in patch) mgroup = patch.group;
        if ("text" in patch) mtext = patch.text;
        mpage = 0;
        mren = false;
        moneyAsk();
    }
    // a table from the sidecar: kept unless the filters changed since it was asked for (a newer one is on its way)
    function takeMoney(v) {
        if (!v) return;
        if (v.dropped !== undefined && mcat !== "" && JSON.parse(mcat) === v.dropped) mcat = "";
        const n = mquery();
        if (["month", "category", "group", "text"].some(k => (v.query?.[k] ?? "") !== (n[k] ?? ""))) return;
        mview = v;
        mpage = v.page ?? 0;
        msel = msel.filter(id => v.rows.some(r => r.id === id));
    }

    // ---- from Hanami ----
    function take(line) {
        let m;
        try { m = JSON.parse(line); } catch (e) { return; }
        if (!m || typeof m !== "object") return;
        if (m.kind === "state") {
            state = m.state;
            if (page === "money" && shown) moneyAsk();
        } else if (m.kind === "money") takeMoney(m.view);
        else if (m.kind === "note") note(m.text ?? "", m.bad);
        else if (m.kind === "copied") {
            if (!m.ok && state?.bind?.[m.which] && !bindShown.includes(m.which)) bindShown = bindShown.concat([m.which]);
            note(m.ok ? "Copied. Paste it into a new custom shortcut." : "Couldn't copy it. Select the command and copy it instead.", !m.ok);
        } else if (m.kind === "open") open();
        else if (m.kind === "close") {
            reset();
            shown = false;
        }
    }

    // ---- the socket ----
    // Quickshell's Socket warns on every failed connect, so it only tries when the socket file is there (a `test -S`
    // every 3 s while unlinked). There but refusing (Hanami crashed and left it): 1 s, 2 s, 4 s… up to 15 s apart
    property int wait: 1000
    function retryNow() {
        wait = 1000;
        if (!sock.connected && !probe.running) probe.running = true;
    }
    Socket {
        id: sock
        path: root.path
        parser: SplitParser { onRead: data => root.take(data) }
        onConnectedChanged: {
            if (connected) {
                root.wait = 1000;
                root.send({ type: "hello", client: "glyph" });
                root.send({ type: "panel_open" });
                if (root.shown && root.page === "money") root.moneyAsk();
            } else {
                root.state = null;
                root.mview = null;
            }
        }
        onError: root.wait = Math.min(root.wait * 2, 15000)
    }
    Process {
        id: probe
        command: ["test", "-S", root.path]
        onExited: code => {
            if (code !== 0) root.wait = 3000;
            else if (!sock.connected) sock.connected = true;
        }
    }
    Timer {
        interval: root.wait
        repeat: true
        triggeredOnStart: true
        running: !sock.connected
        onTriggered: if (!probe.running) probe.running = true
    }

    // ---- shared helpers for the pages ----
    // Object.fromEntries (not in this JS engine)
    function dict(pairs) {
        const o = {};
        for (const [k, v] of pairs) o[k] = v;
        return o;
    }
    function ago(at) {
        const s = Math.max(0, (now - at) / 1000);
        if (s < 45) return "now";
        if (s < 3600) return `${Math.round(s / 60)}m`;
        if (s < 86400) return `${Math.round(s / 3600)}h`;
        return new Date(at).toLocaleDateString(Qt.locale("en_US"), "d MMM");
    }
    function tokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
    function where() {
        const os = state?.os;
        return os === "mac" ? "your Keychain" : os === "win" ? "Windows, encrypted for your account" : os === "linux" ? "your keyring" : "this computer";
    }
    // a spoken reply is about 200 characters, so 100 replies are about 20,000
    function price(c) {
        const per100 = perM => `$${(perM * 0.02).toFixed(2)}`;
        const until = c.promo ? Date.parse(c.promo.until) : 0;
        const promo = c.promo && Date.now() < until
            ? ` (${per100(c.promo.perM)} until ${new Date(until - 1).toLocaleDateString(Qt.locale("en_US"), "d MMM")})` : "";
        return `$${c.perM} per million characters: about ${per100(c.perM)} per 100 replies${promo}. Billed to your Fish Audio account.`;
    }
    readonly property var months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    function monthName(m) { return `${months[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`; }
}
