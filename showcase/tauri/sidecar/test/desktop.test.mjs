// The desktop's screens, workspaces and windows, and acting in a window wherever it is (desktop.mjs), against a fake
// hyprctl, kitten and wtype that record what they were asked. The desktop below is synthetic, in hyprctl's shapes.
// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopModel, desktopTools, describeDesktop, kittySocket, parseCombo } from '../desktop.mjs';

const MONITORS = [
  { id: 1, name: 'HDMI-A-1', description: 'Some Monitor', x: 2304, y: 0, width: 1920, height: 1080, scale: 1, focused: false, activeWorkspace: { id: 4, name: '4' }, specialWorkspace: { id: 0, name: '' } },
  { id: 0, name: 'eDP-1', description: 'Panel', x: 0, y: 0, width: 3840, height: 2400, scale: 1.6666666, focused: true, activeWorkspace: { id: 2, name: '2' }, specialWorkspace: { id: 0, name: '' } },
];
const WORKSPACES = [{ id: 1, name: '1', monitor: 'eDP-1' }, { id: 2, name: '2', monitor: 'eDP-1' }, { id: 4, name: '4', monitor: 'HDMI-A-1' }];
const CLIENTS = [
  { address: '0xaa1', mapped: true, class: 'kitty', initialClass: 'kitty', title: 'build', pid: 1217, workspace: { id: 1, name: '1' }, monitor: 0 },
  { address: '0xbb2', mapped: true, class: 'zen', initialClass: 'zen', title: 'Docs', pid: 900, workspace: { id: 4, name: '4' }, monitor: 1 },
  { address: '0xcc3', mapped: true, class: 'code', initialClass: 'code', title: 'main.rs', pid: 901, workspace: { id: 2, name: '2' }, monitor: 0 },
  { address: '0xdd4', mapped: true, class: 'org.keepassxc.KeePassXC', initialClass: 'org.keepassxc.KeePassXC', title: 'Vault', pid: 902, workspace: { id: 2, name: '2' }, monitor: 0 },
  { address: '0xee5', mapped: true, class: 'foot', initialClass: 'foot', title: 'shell', pid: 903, workspace: { id: 1, name: '1' }, monitor: 0 },
];
const ACTIVE = { address: '0xcc3' };
const KITTY_LS = [{ is_focused: false, tabs: [{ is_focused: true, windows: [{ id: 7, is_focused: true, title: 'build' }] }] }];

function fakeDesktop({ kitty = true, yes = true } = {}) {
  const ran = [], asked = [];
  const run = async (file, args, opts = {}) => {
    ran.push([file, ...args, ...(opts.input != null ? [`<<${opts.input}`] : [])]);
    if (file === 'hyprctl' && args[0] === '-j') return JSON.stringify({ monitors: MONITORS, workspaces: WORKSPACES, clients: CLIENTS, activewindow: ACTIVE }[args[1]]);
    if (file === 'hyprctl' && args[0] === 'eval') return args[1].includes('0xbad') ? 'warning: =[C]:-1: send_shortcut: window not found' : 'ok';
    if (file === 'kitten') {
      if (!kitty) throw new Error('connection refused');
      if (args.includes('ls')) return JSON.stringify(KITTY_LS);
      if (args.includes('get-text')) return 'line 1\nline 2\n';
      return '';
    }
    return '';
  };
  const tools = Object.fromEntries(desktopTools({ run, home: '/home/u', wait: async () => {}, ask: async (q) => { asked.push(q.placeholder); return yes ? 'Allow' : "Don't allow"; } }).map((t) => [t.name, t]));
  const acted = () => ran.filter(([f, a]) => !(f === 'hyprctl' && a === '-j'));
  return { tools, ran, asked, acted };
}

test('screens left to right, the laptop told apart; every window with its workspace and screen', () => {
  const m = desktopModel({ monitors: MONITORS, workspaces: WORKSPACES, clients: CLIENTS, active: ACTIVE });
  assert.deepEqual(m.screens.map((s) => [s.n, s.name, s.laptop, s.workspace, s.width]), [[1, 'eDP-1', true, '2', 2304], [2, 'HDMI-A-1', false, '4', 1920]]);
  const w = Object.fromEntries(m.windows.map((x) => [x.id, x]));
  assert.deepEqual([w['0xaa1'].screen, w['0xaa1'].shown, w['0xbb2'].shown, w['0xcc3'].focused], [1, false, true, true]);
  const text = describeDesktop(m);
  assert.match(text, /1\. The laptop's own screen eDP-1, 2304x1440, showing workspace 2; the user is on this one\./);
  assert.match(text, /Workspace 1 on screen 1, not shown now:\n {2}0xaa1: kitty — build \[terminal\]/);
  assert.match(text, /0xdd4: org\.keepassxc\.KeePassXC — Vault \[never typed into\]/);
});

test('a key combination is modifiers and one key, nothing else reaches the compositor', () => {
  assert.deepEqual(parseCombo('ctrl + shift + t'), { mods: 'CTRL SHIFT', key: 't' });
  assert.deepEqual(parseCombo('Control+R'), { mods: 'CTRL', key: 'r' });
  assert.deepEqual(parseCombo('F5'), { mods: '', key: 'F5' });
  for (const bad of ['', 'CTRL +', 'HYPER + x', 'CTRL + a")', 'CTRL + a b']) assert.equal(parseCombo(bad), null, bad);
});

test('window_keys sends the combination to that window in the background; never Enter to a terminal, never to a vault', async () => {
  const d = fakeDesktop();
  assert.match(await d.tools.window_keys.execute({ window: '0xbb2', keys: 'CTRL + R' }), /Sent CTRL \+ R to zen on workspace 4, screen 2/);
  assert.deepEqual(d.acted(), [['hyprctl', 'eval', 'hl.dispatch(hl.dsp.send_shortcut({ mods = "CTRL", key = "r", window = "address:0xbb2" }))']]);
  await assert.rejects(d.tools.window_keys.execute({ window: '0xaa1', keys: 'Return' }), /use window_type with enter/);
  await assert.rejects(d.tools.window_keys.execute({ window: '0xdd4', keys: 'CTRL + V' }), /never type or press keys there/);
  await assert.rejects(d.tools.window_keys.execute({ window: '0x999', keys: 'CTRL + V' }), /No window 0x999/);
  await assert.rejects(d.tools.window_keys.execute({ window: 'address:0xbb2"', keys: 'CTRL + V' }), /isn't a window id/);
  assert.equal(d.acted().length, 1, 'nothing more was sent');
});

test('window_type into kitty goes in the background through its socket, the text exactly as given', async () => {
  const d = fakeDesktop();
  assert.match(await d.tools.window_type.execute({ window: '0xaa1', text: 'ls -la ~/Projects', enter: true }), /in the background and pressed Enter/);
  const sock = `unix:${kittySocket(1217)}`;
  assert.deepEqual(d.acted(), [['kitten', '@', '--to', sock, 'ls'], ['kitten', '@', '--to', sock, 'send-text', '--stdin', '--match', 'id:7', '<<ls -la ~/Projects\r']]);
  assert.deepEqual(d.asked, [], 'a safe command runs without asking');
});

test('a command typed into a terminal is checked like run_command: refused, or asked first', async () => {
  const d = fakeDesktop({ yes: false });
  await assert.rejects(d.tools.window_type.execute({ window: '0xaa1', text: 'rm -rf ~', enter: true }), /won't run that/);
  await assert.rejects(d.tools.window_type.execute({ window: '0xaa1', text: 'rm notes.txt', enter: true }), /said no/);
  assert.equal(d.asked.length, 1);
  assert.match(d.asked[0], /Run `rm notes\.txt` in kitty \(workspace 1\)\?/);
  await assert.rejects(d.tools.window_type.execute({ window: '0xaa1', text: 'rm notes.txt\n' }), /said no/, 'a newline is an Enter too');
  assert.deepEqual(d.acted(), [], 'nothing typed');
  // Without Enter it is only text waiting at the prompt.
  await d.tools.window_type.execute({ window: '0xaa1', text: 'rm notes.txt' });
  assert.equal(d.asked.length, 2, 'not asked again');
});

test('any other window is focused for a moment and the user is put back: the workspace that screen showed, then their window', async () => {
  const d = fakeDesktop();
  assert.match(await d.tools.window_type.execute({ window: '0xbb2', text: 'hola ñandú', enter: true }), /had the keyboard for a moment/);
  assert.deepEqual(d.acted(), [
    ['hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({ window = "address:0xbb2" }))'],
    ['wtype', '--', 'hola ñandú'], ['wtype', '-k', 'Return'],
    ['hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({ window = "address:0xcc3" }))'],
  ], 'zen was shown already: only the window goes back');

  const k = fakeDesktop({ kitty: false });
  await k.tools.window_type.execute({ window: '0xaa1', text: 'echo hi' });
  assert.deepEqual(k.acted().filter(([f]) => f !== 'kitten'), [
    ['hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({ window = "address:0xaa1" }))'],
    ['wtype', '--', 'echo hi'],
    ['hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({ workspace = "2" }))'],
    ['hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({ window = "address:0xcc3" }))'],
  ], 'a kitty without remote control: the same way, and its screen goes back to workspace 2');
  await assert.rejects(fakeDesktop().tools.window_type.execute({ window: '0xdd4', text: 'x' }), /never type/);
});

test("terminal_output reads a kitty's screen or last command; other terminals can't be read", async () => {
  const d = fakeDesktop();
  assert.equal(await d.tools.terminal_output.execute({ window: '0xaa1', last_command: true }), 'line 1\nline 2');
  assert.deepEqual(d.acted().at(-1), ['kitten', '@', '--to', `unix:${kittySocket(1217)}`, 'get-text', '--extent', 'last_cmd_output', '--match', 'id:7']);
  await assert.rejects(d.tools.terminal_output.execute({ window: '0xee5' }), /Only kitty/);
  await assert.rejects(fakeDesktop({ kitty: false }).tools.terminal_output.execute({ window: '0xaa1' }), /kitty didn't answer/);
});

test('what the compositor refuses comes back as an error', async () => {
  const d = fakeDesktop();
  CLIENTS.push({ address: '0xbad', mapped: true, class: 'zen', title: 'x', pid: 1, workspace: { id: 4, name: '4' }, monitor: 1 });
  await assert.rejects(d.tools.window_keys.execute({ window: '0xbad', keys: 'CTRL + R' }), /The desktop said: warning/);
  CLIENTS.pop();
});
