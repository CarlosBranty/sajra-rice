// The desktop's own shortcuts on Hyprland with a Lua config (0.55 and later, like the glyph dotfiles): read from the
// user's keybinds.lua each time they are asked for, so they follow the user's edits, and used for them by voice. A
// shell action (`hl.dsp.global("shell:<name>")`: the launcher, settings, quick settings, wallpapers…) is dispatched
// to the compositor by name; any other shortcut (special workspaces, apps, media, workspaces, window actions) is
// pressed as keys (wtype), so the compositor does exactly what the user's bind does. What could hurt (killing or
// restarting the shell, typing, putting the computer to sleep) is never offered nor used (safety.mjs checkShortcut).
// Parsing is pure (test/shortcuts.test.mjs).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BLOCK, checkShortcut } from './safety.mjs';

const INTERNAL = /^(launcherArm|launcherInterrupt)$/;

/** `kbName = "KEYS"` (variables.lua) and `vars.kbName = "KEYS"` (user.lua); later texts win, comments don't count. */
function readVars(texts) {
  const vars = {};
  for (const t of texts) {
    for (const line of t.split('\n')) {
      const m = /^\s*(?:vars\.)?(kb\w+)\s*=\s*"([^"]*)"/.exec(line);
      if (m) vars[m[1]] = m[2];
    }
  }
  return vars;
}

/** The arguments of every `hl.bind(` call that isn't commented out, with the last column-0 comment before it. */
function bindCalls(text) {
  const calls = [];
  let section = '';
  const lineStart = (i) => text.lastIndexOf('\n', i - 1) + 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '-' && text.startsWith('--', i)) {
      const start = lineStart(i), end = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
      if (text.startsWith('--[[', i)) { i = (text.indexOf(']]', i) + 1) || text.length; continue; }
      if (i === start) section = text.slice(i + 2, end).trim();
      i = end;
      continue;
    }
    const unbind = text.startsWith('hl.unbind(', i);
    if (!unbind && !text.startsWith('hl.bind(', i)) continue;
    const args = [];
    let depth = 0, block = 0, from = i + (unbind ? 'hl.unbind(' : 'hl.bind(').length, j = from;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '"' || c === "'") { const q = c; for (j++; j < text.length && text[j] !== q; j++) if (text[j] === '\\') j++; continue; }
      if (text.startsWith('[[', j)) { j = text.indexOf(']]', j) + 1 || text.length; continue; }
      if (text.startsWith('--[[', j)) { j = (text.indexOf(']]', j) + 1) || text.length; continue; }
      if (text.startsWith('--', j)) { j = text.indexOf('\n', j); if (j < 0) j = text.length; continue; }
      if (/[A-Za-z_]/.test(c) && !/[\w.]/.test(text[j - 1] ?? '')) {
        const word = /^[A-Za-z_]\w*/.exec(text.slice(j))[0];
        if (word === 'function' || word === 'if' || word === 'do') block++;
        else if (word === 'end') block--;
        j += word.length - 1;
        continue;
      }
      if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') {
        if (depth === 0 && c === ')') { args.push(text.slice(from, j).trim()); break; }
        depth--;
      } else if (c === ',' && depth === 0 && block === 0) { args.push(text.slice(from, j).trim()); from = j + 1; }
    }
    calls.push({ args: args.map(stripComments), section, unbind });
    i = j;
  }
  return calls;
}

// Lua comments inside an argument (a line comment, a block one) are not part of it.
const stripComments = (a) => a.replace(/--\[\[[\s\S]*?\]\]/g, ' ').split('\n').map((l) => l.replace(/^\s*--.*$/, '')).join('\n').trim();
const str = (s) => (/^"([^"]*)"$|^'([^']*)'$/.exec(s ?? '') ?? []).slice(1).find((x) => x != null);

/** What a bind's action does, in a few words, and the shell action's name when it is one. `action`: all of it, which
 *  is what checkShortcut reads (`does` may be cut short to be shown). */
function describe(action) {
  const flat = action.replace(/\s+/g, ' ').trim();
  return { ...short(flat), action: flat };
}
function short(flat) {
  let m;
  if ((m = /^hl\.dsp\.global\(\s*["']shell:([^"']*)["']\s*\)$/.exec(flat))) return { does: `global shell:${m[1]}`, global: m[1] };
  if ((m = /^hl\.dsp\.exec_cmd\(\s*(.*)\s*\)$/.exec(flat))) return { does: `exec ${str(m[1]) ?? m[1]}` };
  if ((m = /^fn\.toggle_special\(\s*["']([^"']*)["']\s*\)$/.exec(flat))) return { does: `toggle special workspace ${m[1]}` };
  if ((m = /^hl\.dsp\.([\w.]+)\((.*)\)$/.exec(flat))) return { does: `${m[1].replace(/\./g, ' ')}${m[2].trim() ? ` ${m[2].trim()}` : ''}` };
  return { does: flat.slice(0, 160) };
}

const WS = { focus: 'go to workspace', move: 'move the window to workspace' };

/** Every keyboard shortcut: { keys, section, does, action, global? }. texts: keybinds.lua, then user.lua (its binds
 *  and `hl.unbind`s come after, as Hyprland runs them); varsTexts: variables.lua, user.lua. One key is one entry,
 *  whatever its spelling, with every action bound to it. */
export function parseBinds(texts, varsTexts = []) {
  const vars = readVars(varsTexts);
  const out = new Map();
  const add = (keys, section, d) => {
    const k = normKeys(keys), id = k.toUpperCase();
    const prev = out.get(id);
    const both = (a, b) => (a && b ? `${a}; ${b}` : a || b);
    // A key with several actions is pressed, so that the compositor runs them all (not dispatched as one of them).
    if (!prev) out.set(id, { keys: k, section, ...d });
    else out.set(id, { keys: prev.keys, section: prev.section, does: both(prev.does, d.does), action: both(prev.action, d.action) });
  };
  const calls = (Array.isArray(texts) ? texts : [texts]).flatMap((t) => bindCalls(t));
  for (const { args: [keyExpr = '', action = '', opts = ''], section, unbind } of calls) {
    let m;
    if (unbind) {
      const keys = str(keyExpr) ?? ((m = /^vars\.(\w+)$/.exec(keyExpr)) ? vars[m[1]] : null);
      if (keys) out.delete(normKeys(keys).toUpperCase());
      continue;
    }
    if (/mouse\s*=\s*true/.test(opts)) continue;
    // The workspace loop: `vars.kbGoToWs .. " + " .. key` with fn.wsaction(kind, group, i), for i = 1..10.
    if ((m = /^vars\.(\w+)\s*\.\.\s*" \+ "\s*\.\.\s*key$/.exec(keyExpr))) {
      const w = /^fn\.wsaction\(\s*"(\w+)"\s*,\s*"(\w*)"\s*,\s*i\s*\)$/.exec(action.replace(/\s+/g, ' '));
      if (!vars[m[1]] || !w) continue;
      for (let i = 1; i <= 10; i++) add(`${vars[m[1]]} + ${i % 10}`, 'Workspaces', { does: `${WS[w[1]] ?? w[1]}${w[2] ? ` ${w[2]}` : ''} ${i}`, action: action.replace(/\s+/g, ' ') });
      continue;
    }
    const keys = str(keyExpr) ?? ((m = /^vars\.(\w+)$/.exec(keyExpr)) ? vars[m[1]] : null);
    if (!keys || /mouse/i.test(keys)) continue;
    const d = describe(action);
    if (d.global && INTERNAL.test(d.global)) continue;
    add(keys, section, d);
  }
  return [...out.values()];
}

/** "super + shift + m" → "SUPER + SHIFT + M": modifiers upper case, the key as written (one letter upper case). */
export function normKeys(keys) {
  const parts = String(keys).split('+').map((p) => p.trim()).filter(Boolean);
  return parts.map((p, i) => (i < parts.length - 1 || MODS[p.toUpperCase()] || p.length === 1 ? p.toUpperCase() : p)).join(' + ');
}

const MODS = { SUPER: 'logo', CTRL: 'ctrl', CONTROL: 'ctrl', ALT: 'alt', SHIFT: 'shift' };
const KEYS = {
  SPACE: 'space', RETURN: 'Return', ENTER: 'Return', ESCAPE: 'Escape', TAB: 'Tab', BACKSLASH: 'backslash', COMMA: 'comma',
  PERIOD: 'period', MINUS: 'minus', EQUAL: 'equal', DELETE: 'Delete', LEFT: 'Left', RIGHT: 'Right', UP: 'Up', DOWN: 'Down',
  PAGE_UP: 'Prior', PAGE_DOWN: 'Next', PRINT: 'Print',
};

/** wtype's arguments to press a shortcut (modifiers held around the key), or null when it isn't one key. */
export function pressArgs(keys) {
  const parts = normKeys(keys).split(' + ');
  const key = parts.pop();
  const mods = parts.map((p) => MODS[p]);
  if (!key || mods.some((x) => !x) || MODS[key] || /^(SUPER|CONTROL|ALT|SHIFT)_[LR]$/i.test(key) || !/^\w+$/.test(key)) return null;
  const sym = KEYS[key.toUpperCase()] ?? (key.length === 1 ? key.toLowerCase() : key);
  return [...mods.flatMap((x) => ['-M', x]), '-k', sym, ...mods.reverse().flatMap((x) => ['-m', x])];
}

const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'hypr');
async function readConfig() {
  const dir = configDir();
  let binds;
  try { binds = await fs.readFile(path.join(dir, 'hyprland', 'keybinds.lua'), 'utf8'); } catch { return null; }
  const [variables, user] = await Promise.all(['variables.lua', 'user.lua'].map((f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => '')));
  return { binds: [binds, user], vars: [variables, user] };
}
const runFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 3000, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error(err.code === 'ENOENT' ? `${file} is not installed` : String(stderr || err.message).trim().slice(0, 300)));
    else resolve(String(stdout));
  });
});

/** read(): { binds: [keybinds.lua, user.lua], vars: [variables.lua, user.lua] } or null; run(file, args): runs a program (no shell). */
export function shortcutTools({ read = readConfig, run = runFile } = {}) {
  const usable = async () => {
    const c = await read();
    return c ? parseBinds(c.binds, c.vars).filter((b) => checkShortcut(b).level !== BLOCK) : null;
  };
  return [
    {
      name: 'desktop_shortcuts',
      description: "The user's desktop shortcuts (Hyprland, their glyph dotfiles' keybinds.lua), grouped by section, each with what it does: shell panels (`global shell:<name>`, e.g. launcher, settings, quick, wall, power, clip, shot), special workspaces (music, todo, communication, sysmon), apps, media, volume, workspaces and window actions. Read them before use_shortcut when the user asks to open, close, show or hide something on the desktop by name. A `global shell:` action opens its panel and closes it when already open.",
      parameters: z.object({}),
      execute: async () => {
        const binds = await usable();
        if (!binds) return 'No Hyprland Lua keybinds found (~/.config/hypr/hyprland/keybinds.lua).';
        const sections = new Map();
        for (const b of binds) sections.set(b.section, [...(sections.get(b.section) ?? []), `${b.keys}: ${b.does}`]);
        return [...sections].map(([s, l]) => `[${s || 'Other'}]\n${l.join('\n')}`).join('\n');
      },
    },
    {
      name: 'use_shortcut',
      description: "Use one of the user's desktop shortcuts (from desktop_shortcuts) for them: opens or closes what that shortcut does. Pass its keys exactly as listed, e.g. \"SUPER + A\".",
      parameters: z.object({ keys: z.string().min(1).max(60) }),
      execute: async ({ keys }) => {
        const c = await read();
        const want = normKeys(keys).toUpperCase();
        const b = c && parseBinds(c.binds, c.vars).find((x) => x.keys.toUpperCase() === want);
        if (!b) throw new Error(`No shortcut ${normKeys(keys)} in the desktop's keybinds. desktop_shortcuts lists them.`);
        const v = checkShortcut(b);
        if (v.level === BLOCK) throw new Error(`${b.keys} can't be used: ${v.reason}`);
        if (b.global) await run('hyprctl', ['dispatch', `hl.dsp.global("shell:${b.global}")`]);
        else {
          const args = pressArgs(b.keys);
          if (!args) throw new Error(`${b.keys} can't be pressed.`);
          await run('wtype', args);
        }
        return `Done: ${b.keys} (${b.does}).`;
      },
    },
  ];
}
