// Where the windows are on Hyprland, asked of the compositor (read-only `hyprctl -j clients` and `monitors`): for
// the window features the hands helper gives on macOS and Windows, frames fitted to the real window, cards placed
// beside it and old marks cleared when the window or workspace changes. Nothing else of the helper's. Answers in
// the helper's shapes (hands-win main.rs: windows, locate front), in global logical points, the same space as the
// screenshot's bounds and the overlay's origin. Parsing is pure (test/hypr.test.mjs, on real hyprctl output).
import { execFile } from 'node:child_process';

// Only these are ever asked: hyprctl's other commands change things (dispatch, keyword, setprop…).
const READS = new Set(['clients', 'monitors']);

/** hyprctl -j <what>, parsed; null when it isn't there, fails, says something that isn't JSON or takes longer than
 *  timeout ms (killed then: a hung compositor never holds up a drawing). */
export function hyprctl(what, timeout = 800) {
  if (!READS.has(what)) return Promise.resolve(null);
  return new Promise((resolve) => {
    // execFile's timeout kills it and lets go of its output, even when something it started holds that open.
    try {
      execFile('hyprctl', ['-j', what], { timeout, killSignal: 'SIGKILL', maxBuffer: 4 << 20, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const wsId = (w) => num(w?.id);
// A special workspace (a scratchpad) shown over a monitor's own: a negative id, or a name "special:…". Closed, it
// reads { address: "", name: "" } (no id) or id 0.
const openSpecial = (w) => { const id = wsId(w); return id != null && id !== 0 ? id : null; };

/** The workspaces shown now: every monitor's own and any special one open over it, and the one in use: the special
 *  one open on the focused monitor, else that monitor's own. { shown: Set, front: id | null, special: Set }. */
export function shownWorkspaces(monitors) {
  const shown = new Set(), special = new Set();
  let front = null;
  for (const m of Array.isArray(monitors) ? monitors : []) {
    if (!m || m.disabled) continue;
    const own = wsId(m.activeWorkspace), sp = openSpecial(m.specialWorkspace);
    if (own != null) shown.add(own);
    if (sp != null) { shown.add(sp); special.add(sp); }
    if (m.focused) front = sp ?? own;
  }
  return { shown, front, special };
}

/** Roamies' own windows (an X11 overlay, the panel) are clients too: never a window to draw round, nor the front. */
const isSelf = (c, self) => self.includes(c.pid) || /^roamies$/i.test(String(c.class ?? '')) || /^roamies$/i.test(String(c.initialClass ?? ''));

/** The open windows on screen now, front to back: the ones on a shown workspace (or pinned), mapped, not hidden and
 *  not Roamies', as { id (address), app (class), bounds [x, y, w, h], workspace, focus, pinned, monitor }. Hyprland gives no stacking
 *  order, so: a special workspace's over the rest, then fullscreen, then floating, then the most recently focused.
 *  self: Roamies' process ids. */
export function hyprWindows(clients, monitors, self = []) {
  const { shown, special } = shownWorkspaces(monitors);
  const list = [];
  for (const c of Array.isArray(clients) ? clients : []) {
    if (!c || c.mapped === false || c.hidden === true || isSelf(c, self)) continue;
    const ws = wsId(c.workspace);
    if (!c.pinned && !shown.has(ws)) continue;
    const [x, y] = Array.isArray(c.at) ? c.at.map(num) : [], [w, h] = Array.isArray(c.size) ? c.size.map(num) : [];
    if (x == null || y == null || !(w > 0) || !(h > 0)) continue;
    list.push({ id: String(c.address ?? ''), app: String(c.class || c.initialClass || ''), bounds: [x, y, w, h], workspace: ws, focus: num(c.focusHistoryID) ?? Infinity, pinned: !!c.pinned, monitor: num(c.monitor), rank: [special.has(ws) ? 0 : 1, c.fullscreen ? 0 : 1, c.floating ? 0 : 1] });
  }
  list.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || a.focus - b.focus);
  return list.map(({ rank, ...w }) => w);
}

/** The window in use: on the workspace in use (the focused monitor's), the most recently focused of its windows
 *  (focusHistoryID): the active window, or the one that was until the keyboard went to Roamies' own (its X11
 *  windows, or its layer surface holding the keyboard), so a question typed to Roamies isn't a change. Its id
 *  is its address and that workspace's id, so the same window seen on another workspace (pinned) is a change too.
 *  { workspace, window: { id, app, bounds } | null } (null: nothing on that workspace), or null when the monitors
 *  can't be told. */
export function hyprFront(clients, monitors, self = []) {
  const { front } = shownWorkspaces(monitors);
  if (front == null) return null;
  // A pinned window shows on every workspace of its monitor: it belongs to the one in use as much as to its own.
  const mon = num((Array.isArray(monitors) ? monitors : []).find((m) => m?.focused && !m.disabled)?.id);
  const here = hyprWindows(clients, monitors, self).filter((w) => w.workspace === front || (w.pinned && w.monitor != null && w.monitor === mon));
  const top = here.reduce((a, w) => (!a || w.focus < a.focus ? w : a), null);
  return { workspace: front, window: top ? { id: `${top.id}@${front}`, app: top.app, bounds: top.bounds } : null };
}

/** The window source tools.mjs uses on Hyprland. windows(): { ok, windows } like the helper's `windows`;
 *  front(): { ok, workspace, window? } like its `locate front`. Both null when hyprctl doesn't answer in time.
 *  ask: hyprctl (a test's fake); self: Roamies' process ids (this sidecar and the app that started it). */
export function createHypr({ ask = hyprctl, self = [process.pid, process.ppid] } = {}) {
  const both = async () => {
    const [clients, monitors] = await Promise.all([ask('clients'), ask('monitors')]);
    return Array.isArray(clients) && Array.isArray(monitors) ? { clients, monitors } : null;
  };
  return {
    async windows() {
      const s = await both();
      return s ? { ok: true, windows: hyprWindows(s.clients, s.monitors, self).map(({ id, app, bounds }) => ({ id, app, bounds })) } : null;
    },
    async front() {
      const s = await both(), f = s && hyprFront(s.clients, s.monitors, self);
      return f ? { ok: true, workspace: f.workspace, ...(f.window ? { window: f.window } : {}) } : null;
    },
  };
}
