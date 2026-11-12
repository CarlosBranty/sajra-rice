// The desktop's screens, workspaces and windows on Hyprland, and acting in a window wherever it is, so the user
// needn't go there: "on the laptop's screen, in the terminal on workspace 1, run …".
// - desktop_windows: every screen (the laptop's told apart), the workspace each shows, and every window with its id.
// - window_keys: a key combination sent to one window in the background (Hyprland's send_shortcut): nothing on
//   screen moves.
// - window_type: text typed into one window. A kitty terminal gets it in the background, through kitty's remote
//   control (its socket in $XDG_RUNTIME_DIR); any other window has to have the keyboard for that on Wayland, so it is
//   focused for a moment and the user is put back where they were (the screen's workspace and the window they had).
//   Text with Enter in a terminal is a command: it goes through safety.mjs classifyCommand like run_command, and
//   asks first when that says so. Password managers and system prompts are never typed into.
// - terminal_output: what a kitty terminal shows (its screen, or its last command's output).
// Reads are `hyprctl -j` (clients, monitors, workspaces, activewindow); the parsing and planning are pure
// (test/desktop.test.mjs).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ASK, BLOCK, classifyCommand, isYes } from './safety.mjs';

// A terminal, by its window class or initial class, or by the program behind the window (a kitty started with
// `--class dropterm` is still kitty).
const TERMINAL = /^(kitty|foot|footclient|alacritty|wezterm|wezterm-gui|org\.wezfurlong\.wezterm|ghostty|com\.mitchellh\.ghostty|konsole|org\.kde\.konsole|xterm|uxterm|st|st-256color|urxvt|rxvt|org\.gnome\.(console|terminal|ptyxis)|kgx|ptyxis|gnome-terminal(-server)?|tilix|com\.gexperts\.tilix|terminator|xfce4-terminal|lxterminal|qterminal|sakura|terminology|rio|contour|cool-retro-term|blackbox|com\.raggesilver\.blackbox|warp|dev\.warp\.warp)$/i;
/** Windows nothing is ever typed or pressed into: password managers, unlock and permission prompts, Roamies itself. */
const HANDS_OFF = /keepass|bitwarden|1password|pinentry|gcr-prompter|polkit|seahorse|kwallet|proton.?pass|enpass|hyprlock|swaylock|roamies|hanami/i;
/** In a terminal these run what is typed, as Enter does. */
const SUBMITS = (c) => /^(return|enter|kp_enter|iso_enter|linefeed)$/i.test(c.key) || (/\bCTRL\b/.test(c.mods) && /^[mjo]$/i.test(c.key));
/** Control characters other than tab and line ends: a terminal acts on them (Ctrl-O runs the line in bash). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ADDRESS = /^0x[0-9a-f]{1,16}$/i;
const MODS = new Set(['SUPER', 'CTRL', 'ALT', 'SHIFT']);

const comm = (pid) => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; } };
export const isTerminal = (w) => [w?.class, w?.initialClass, w?.program].some((n) => TERMINAL.test(n ?? ''));
export const handsOff = (w) => HANDS_OFF.test(`${w?.class ?? ''} ${w?.initialClass ?? ''}`);
/** The laptop's own panel, by its connector (eDP, LVDS, DSI). */
export const isLaptop = (m) => /^(eDP|LVDS|DSI)/i.test(m?.name ?? '');

/** hyprctl's JSON → { screens, windows }: screens left to right, numbered from 1; windows with where they are. */
export function desktopModel({ monitors = [], workspaces = [], clients = [], active = null, programOf = comm }) {
  const screens = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y).map((m, i) => ({
    n: i + 1, name: m.name, laptop: isLaptop(m), focused: !!m.focused, description: m.description ?? '',
    width: Math.round(m.width / (m.scale || 1)), height: Math.round(m.height / (m.scale || 1)),
    workspace: m.activeWorkspace?.name ?? String(m.activeWorkspace?.id ?? ''), special: m.specialWorkspace?.name || '',
  }));
  const screenOf = (name) => screens.find((s) => s.name === name);
  const wsMonitor = new Map(workspaces.map((w) => [w.name, w.monitor]));
  const windows = clients.filter((c) => c.mapped !== false && ADDRESS.test(c.address ?? '')).map((c) => {
    const ws = c.workspace?.name ?? String(c.workspace?.id ?? '');
    const screen = screenOf(wsMonitor.get(ws)) ?? screens.find((s) => monitors.find((m) => m.name === s.name)?.id === c.monitor);
    const shown = !!screen && (screen.workspace === ws || screen.special === ws);
    return { id: c.address, class: c.class ?? '', initialClass: c.initialClass ?? '', program: programOf(c.pid), title: c.title ?? '', pid: c.pid, workspace: ws, screen: screen?.n ?? null, shown, focused: c.address === active?.address };
  });
  return { screens, windows };
}

/** The model as the agent reads it. */
export function describeDesktop({ screens, windows }) {
  const lines = ['Screens (left to right):'];
  for (const s of screens) {
    lines.push(`${s.n}. ${s.laptop ? "The laptop's own screen" : 'External screen'} ${s.name}${s.description && !s.laptop ? ` (${s.description})` : ''}, ${s.width}x${s.height}, showing workspace ${s.workspace}${s.special ? ` (and ${s.special} over it)` : ''}${s.focused ? '; the user is on this one' : ''}.`);
  }
  const byWs = new Map();
  for (const w of windows) byWs.set(w.workspace, [...(byWs.get(w.workspace) ?? []), w]);
  lines.push('Windows (id: app — title), by workspace:');
  for (const [ws, list] of byWs) {
    const sc = list[0].screen;
    lines.push(`Workspace ${ws}${sc ? ` on screen ${sc}` : ''}${list[0].shown ? ', shown' : ', not shown now'}:`);
    for (const w of list) lines.push(`  ${w.id}: ${w.class} — ${w.title.slice(0, 80)}${w.focused ? ' [has the keyboard]' : ''}${isTerminal(w) ? ' [terminal]' : ''}${handsOff(w) ? ' [never typed into]' : ''}`);
  }
  if (!windows.length) lines.push('  (no windows)');
  return lines.join('\n');
}

/** "ctrl + shift + t" → { mods: "CTRL SHIFT", key: "t" }, or null when it isn't modifiers and one key. */
export function parseCombo(combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const mods = parts.map((p) => ({ CONTROL: 'CTRL', META: 'SUPER', WIN: 'SUPER' }[p.toUpperCase()] ?? p.toUpperCase()));
  if (!key || !/^[A-Za-z0-9_]{1,24}$/.test(key) || /^(SUPER|CTRL|CONTROL|ALT|SHIFT|META|WIN)$/i.test(key) || mods.some((m) => !MODS.has(m))) return null;
  return { mods: mods.join(' '), key: key.length === 1 ? key.toLowerCase() : key };
}

/** The Lua for one dispatcher, every value checked before it gets here. */
const dispatch = (d) => `hl.dispatch(${d})`;
export const shortcutLua = (address, { mods, key }) => dispatch(`hl.dsp.send_shortcut({ mods = "${mods}", key = "${key}", window = "address:${address}" })`);
export const focusWindowLua = (address) => dispatch(`hl.dsp.focus({ window = "address:${address}" })`);
export const focusWorkspaceLua = (ws) => dispatch(`hl.dsp.focus({ workspace = "${ws}" })`);

const said = (out) => String(out ?? '').trim();
const failed = (out) => /^(warning|error)\b/i.test(said(out));

const sockDir = () => process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `runtime-${os.userInfo().uid}`);
/** Where a kitty process listens when kitty.conf has `listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}`. */
export const kittySocket = (pid) => path.join(sockDir(), `kitty-${pid}`);

/** In kitty's `ls`, the window that is active in the OS window titled like the Hyprland window (or the only one). */
export function kittyTarget(ls, title) {
  const osw = Array.isArray(ls) ? ls : [];
  const pick = osw.length === 1 ? osw[0] : osw.find((o) => activeWindow(o)?.title === title) ?? osw.find((o) => o.is_focused) ?? osw[0];
  return activeWindow(pick)?.id ?? null;
}
function activeWindow(o) {
  const tab = o?.tabs?.find((t) => t.is_focused) ?? o?.tabs?.find((t) => t.is_active) ?? o?.tabs?.[0];
  return tab?.windows?.find((w) => w.is_focused) ?? tab?.windows?.find((w) => w.is_active) ?? tab?.windows?.[0] ?? null;
}

const execRun = (file, args, { input, timeout = 5000 } = {}) => new Promise((resolve, reject) => {
  const p = execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(new Error(err.code === 'ENOENT' ? `${file} is not installed` : String(stdout || stderr || err.message).trim().slice(0, 300)), { code: err.code }));
    else resolve(String(stdout));
  });
  if (input != null) p.stdin.end(input);
});
const hyprRead = async (run, what) => { try { return JSON.parse(await run('hyprctl', ['-j', what])); } catch { return null; } };

/** run(file, args, { input }): a program's stdout (a test's fake); ask: the sidecar's yes/no bubble; home: for the
 *  command rules; wait(ms): a pause (focus has to land before keys); allowActions(): the "Allow File Edits &
 *  Commands" switch, which acting in windows needs as run_command does; actionsOff: what to say when it's off;
 *  programOf(pid): the program behind a window (/proc). */
export function desktopTools({ run = execRun, ask, home = os.homedir(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), allowActions = () => false, actionsOff = 'Acting in other windows is switched off.', programOf = comm } = {}) {
  const look = async () => {
    const [monitors, workspaces, clients, active] = await Promise.all(['monitors', 'workspaces', 'clients', 'activewindow'].map((w) => hyprRead(run, w)));
    if (!monitors || !clients) throw new Error("The desktop didn't answer (this works on Hyprland).");
    return desktopModel({ monitors, workspaces: workspaces ?? [], clients, active, programOf });
  };
  const allowed = () => { if (!allowActions()) throw new Error(actionsOff); };
  const find = async (id) => {
    if (!ADDRESS.test(id)) throw new Error(`${id} isn't a window id: desktop_windows lists them (0x…).`);
    const model = await look();
    const w = model.windows.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!w) throw new Error(`No window ${id} now: it may have closed. desktop_windows lists them again.`);
    if (handsOff(w)) throw new Error(`${w.class} is a password or permission window: I never type or press keys there.`);
    return { w, model };
  };
  const hypr = async (lua) => {
    const out = await run('hyprctl', ['eval', lua]);
    if (failed(out)) throw new Error(`The desktop said: ${said(out).slice(0, 200)}`);
  };
  const kitty = async (w, args, input) => {
    const to = `unix:${kittySocket(w.pid)}`;
    const id = kittyTarget(JSON.parse(await run('kitten', ['@', '--to', to, 'ls'])), w.title);
    if (id == null) throw new Error('kitty has no window there');
    return run('kitten', ['@', '--to', to, ...args, '--match', `id:${id}`], input == null ? {} : { input });
  };
  // A command typed with Enter into a terminal: the same rules as run_command.
  const allowCommand = async (w, text, signal) => {
    const v = classifyCommand(text, home);
    if (v.level === BLOCK) throw new Error(`I won't run that in the terminal: ${v.reason}`);
    if (v.level === ASK && !(isYes(await ask?.({ placeholder: `Run \`${text.length > 70 ? `${text.slice(0, 67)}…` : text}\` in ${w.class} (workspace ${w.workspace})?${v.reason ? ` ${v.reason}` : ''}`, choices: ['Allow', "Don't allow"] }, signal)))) {
      throw new Error('The user said no, so I didn\'t run it.');
    }
  };
  const where = (w) => `${w.class} on workspace ${w.workspace}${w.screen ? `, screen ${w.screen}` : ''}`;

  return [
    {
      name: 'desktop_windows',
      description: "The user's screens (the laptop's own told apart from external ones, numbered left to right), the workspace each shows, and every open window on every workspace with its id, app and title. Read it first when the user names a screen, a workspace or an app to work in (\"the terminal on the laptop's workspace 1\"); the ids are what window_type, window_keys and terminal_output take.",
      parameters: z.object({}),
      execute: async () => describeDesktop(await look()),
    },
    {
      name: 'window_keys',
      description: 'Send a key combination to one window, wherever it is, without bringing it up or moving anything on screen (e.g. "CTRL + R" to reload a browser tab, "CTRL + C" to stop a terminal\'s command, "CTRL + SHIFT + T"). Modifiers: SUPER, CTRL, ALT, SHIFT. Not for typing text (window_type) or Enter in a terminal (window_type with enter).',
      parameters: z.object({ window: z.string().min(3).max(20).describe('its id from desktop_windows'), keys: z.string().min(1).max(40) }),
      execute: async ({ window, keys }) => {
        allowed();
        const combo = parseCombo(keys);
        if (!combo) throw new Error(`"${keys}" isn't modifiers and one key, like "CTRL + R".`);
        const { w } = await find(window);
        if (isTerminal(w) && SUBMITS(combo)) throw new Error(`${keys} in a terminal runs what is typed there, as Enter does: use window_type with enter, so the command is checked.`);
        await hypr(shortcutLua(w.id, combo));
        return `Sent ${keys} to ${where(w)}.`;
      },
    },
    {
      name: 'window_type',
      description: "Type text into one window, wherever it is, and press Enter after it if asked (enter: true; in a terminal that runs it as a command, checked like run_command and asked first when risky). A kitty terminal gets it in the background, nothing moves; any other window has to be focused for a moment (Wayland), and the user is put back where they were right after. Type into a field that already has the cursor in that window; window_keys can move it first.",
      parameters: z.object({ window: z.string().min(3).max(20).describe('its id from desktop_windows'), text: z.string().min(1).max(4000), enter: z.boolean().optional() }),
      execute: async ({ window, text, enter = false }, ctx) => {
        allowed();
        if (CONTROL.test(text)) throw new Error('The text has control characters; type plain text (a key combination goes with window_keys).');
        const { w, model } = await find(window);
        const runs = isTerminal(w) && (enter || /[\r\n]/.test(text));
        if (runs) await allowCommand(w, text.replace(/[\r\n]+$/, ''), ctx?.signal);
        if (w.class.toLowerCase() === 'kitty') {
          try {
            await kitty(w, ['send-text', '--stdin'], text + (enter ? '\r' : ''));
            return `Typed into ${where(w)} in the background${enter ? ' and pressed Enter' : ''}.`;
          } catch (e) {
            if (e.code === 'ENOENT') throw e;
            // No remote control in that kitty (an old window, or kitty.conf without it): the way every app takes.
          }
        }
        const prev = model.windows.find((x) => x.focused);
        const screen = model.screens.find((s) => s.n === w.screen);
        await hypr(focusWindowLua(w.id));
        await wait(120);
        try {
          // Only into that window: if the keyboard didn't go there, the text would land wherever it is.
          const now = await hyprRead(run, 'activewindow');
          if (now?.address?.toLowerCase() !== w.id.toLowerCase()) throw new Error(`${w.class} didn't take the keyboard, so nothing was typed.`);
          await run('wtype', ['--', text]);
          if (enter) await run('wtype', ['-k', 'Return']);
        } finally {
          await wait(80);
          // Back as it was: the workspace that screen showed, then the window the user had.
          if (screen && !w.shown && /^[\w:.-]+$/.test(screen.workspace)) await hypr(focusWorkspaceLua(screen.workspace)).catch(() => {});
          if (prev && prev.id !== w.id) await hypr(focusWindowLua(prev.id)).catch(() => {});
        }
        return `Typed into ${where(w)}${enter ? ' and pressed Enter' : ''}; it had the keyboard for a moment, and the user is back where they were.`;
      },
    },
    {
      name: 'terminal_output',
      description: "What a kitty terminal shows now, wherever it is: its screen, or the output of its last command (last_command: true), to read what a command typed with window_type printed.",
      parameters: z.object({ window: z.string().min(3).max(20), last_command: z.boolean().optional() }),
      execute: async ({ window, last_command = false }) => {
        const { w } = await find(window);
        if (w.class.toLowerCase() !== 'kitty') throw new Error(`Only kitty terminals can be read this way; ${w.class} isn't one.`);
        const text = await kitty(w, ['get-text', '--extent', last_command ? 'last_cmd_output' : 'screen']).catch((e) => {
          throw new Error(`kitty didn't answer (${e.message}). Its remote control is on for kitty windows opened after kitty.conf got it.`);
        });
        return text.trimEnd().split('\n').slice(-120).join('\n') || '(nothing on screen)';
      },
    },
  ];
}
