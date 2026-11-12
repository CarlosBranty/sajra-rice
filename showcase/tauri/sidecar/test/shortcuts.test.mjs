// The desktop's shortcuts on Hyprland with a Lua config (shortcuts.mjs): read from the user's keybinds.lua, named
// for the agent, and used: a shell action (`global shell:<name>`) is dispatched, any other shortcut is pressed. The
// config below is synthetic, in the shape of a glyph keybinds.lua. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBinds, pressArgs, shortcutTools } from '../shortcuts.mjs';
import { BLOCK, SAFE, checkShortcut } from '../safety.mjs';

const VARS = `
local M = {
    kbAltar      = "SUPER + Space",
    kbGoToWs     = "SUPER",
    kbMusicWs    = "SUPER + M",
    kbCloseWindow = "SUPER + Q",
    kbTerminal   = "SUPER + Return",
}
return M`;
const USER = `-- vars.kbTerminal = "SUPER + T"
vars.kbMusicWs = "SUPER + SHIFT + M"`;
const BINDS = `local vars = require("variables")
hl.bind("SUPER + SUPER_L", hl.dsp.global("shell:launcher"), { release = true })
hl.bind("SUPER_L", hl.dsp.global("shell:launcherArm"), { ignore_mods = true, non_consuming = true })
for _, key in ipairs({ "Q", "W" }) do
    hl.bind("SUPER + " .. key, hl.dsp.global("shell:launcherInterrupt"), { non_consuming = true })
end
-- Misc
hl.bind(vars.kbAltar, hl.dsp.global("shell:altar"))
hl.bind("SUPER + A", hl.dsp.global("shell:quick")) -- quick settings
-- Media
hl.bind("CTRL + SUPER + Space", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
-- Kill/restart
hl.bind("CTRL + SUPER + SHIFT + R", hl.dsp.exec_cmd(vars.rice .. " kill"), { release = true })
for i = 1, 10 do
    local key = i % 10 -- 10 maps to key 0
    hl.bind(vars.kbGoToWs .. " + " .. key, fn.wsaction("focus", "", i))
end
-- Window actions
hl.bind(vars.kbCloseWindow, hl.dsp.window.close())
hl.bind("SUPER + mouse:272", hl.dsp.window.resize(), { mouse = true })
hl.bind(vars.kbMusicWs, fn.toggle_special("music"))
hl.bind(vars.kbTerminal, function() hl.exec_cmd(vars.terminal) end)
hl.bind(
    "XF86AudioLowerVolume",
    hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"),
    { locked = true, repeating = true }
)
hl.bind("SUPER + SHIFT + U", hl.dsp.exec_cmd("hyprctl kill"))
hl.bind(
    "CTRL + SHIFT + ALT + V",
    hl.dsp.exec_cmd('sleep 0.5s && ydotool type -d 1 "$(cliphist list | head -1 | cliphist decode)"')
    -- not locked: on the lock screen it would type the last copied text into the password field
)
hl.bind("SUPER + SHIFT + L", hl.dsp.exec_cmd(vars.sleepGestureCmd), { locked = true })`;

const binds = parseBinds(BINDS, [VARS, USER]);
const find = (keys) => binds.find((b) => b.keys === keys);

test('the binds are read with their keys resolved, their section and what they do', () => {
  assert.deepEqual(find('SUPER + Space'), { keys: 'SUPER + Space', section: 'Misc', does: 'global shell:altar', global: 'altar', action: 'hl.dsp.global("shell:altar")' });
  assert.equal(find('SUPER + A').global, 'quick');
  assert.equal(find('SUPER + SUPER_L').global, 'launcher', 'the launcher, by its shell action');
  assert.equal(find('CTRL + SUPER + Space').does, 'exec playerctl play-pause');
  assert.equal(find('SUPER + SHIFT + M').does, 'toggle special workspace music', "user.lua's override wins; a commented one doesn't");
  assert.equal(find('SUPER + Return').does, 'function() hl.exec_cmd(vars.terminal) end');
  assert.equal(find('XF86AudioLowerVolume').does, 'exec wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-', 'a call over several lines');
  assert.deepEqual(find('SUPER + 1'), { keys: 'SUPER + 1', section: 'Workspaces', does: 'go to workspace 1', action: 'fn.wsaction("focus", "", i)' });
  assert.equal(find('CTRL + SHIFT + ALT + V').does, `exec sleep 0.5s && ydotool type -d 1 "$(cliphist list | head -1 | cliphist decode)"`, 'a comment inside the call is not part of it');
  assert.equal(find('SUPER + 0').does, 'go to workspace 10');
  assert.equal(find('SUPER + Q').does, 'window close');
  assert.equal(binds.filter((b) => /launcher(Arm|Interrupt)/.test(b.does)).length, 0, "the launcher's bookkeeping binds are not shortcuts");
  assert.equal(find('SUPER + mouse:272'), undefined, 'mouse binds are not keys to press');
});

test('what can never be used: killing or restarting the shell, typing, sleep, killing a window by click', () => {
  for (const keys of ['CTRL + SUPER + SHIFT + R', 'SUPER + SHIFT + U', 'CTRL + SHIFT + ALT + V', 'SUPER + SHIFT + L']) {
    assert.equal(checkShortcut(find(keys)).level, BLOCK, keys);
  }
  for (const keys of ['SUPER + A', 'SUPER + 3', 'SUPER + Q', 'CTRL + SUPER + Space', 'SUPER + SHIFT + M']) assert.equal(checkShortcut(find(keys)).level, SAFE, keys);
  assert.equal(checkShortcut({ keys: 'SUPER + A', does: 'global shell:x"); os.execute("rm', global: 'x"); os.execute("rm' }).level, BLOCK, 'only plain shell action names are dispatched');
  assert.equal(checkShortcut(undefined).level, BLOCK);
});

test("user.lua's binds come after keybinds.lua's: an unbind drops one, a bind adds or replaces it, any spelling", () => {
  const user = `hl.unbind("SUPER + A")
hl.bind("SUPER + a", hl.dsp.exec_cmd("pkill quickshell"))
hl.bind("SUPER + B", hl.dsp.exec_cmd("firefox")) -- a browser
--[[ hl.bind("SUPER + J", hl.dsp.exec_cmd("nothing")) ]]
hl.bind("SUPER + RETURN", hl.dsp.exec_cmd("hyprctl kill"))`;
  const all = parseBinds([BINDS, user], [VARS, USER]);
  const one = (k) => all.filter((b) => b.keys.toUpperCase() === k.toUpperCase());
  assert.equal(one('SUPER + A').length, 1);
  assert.equal(one('SUPER + A')[0].does, 'exec pkill quickshell', 'unbound, then bound again by user.lua');
  assert.equal(checkShortcut(one('SUPER + A')[0]).level, BLOCK);
  assert.equal(one('SUPER + B')[0].does, 'exec firefox');
  assert.equal(one('SUPER + J').length, 0, 'a bind in a block comment is not one');
  assert.equal(one('SUPER + Return').length, 1, 'one key whatever its spelling');
  assert.equal(checkShortcut(one('SUPER + Return')[0]).level, BLOCK, 'its other action kills: the key is not pressed');
});

test('what kills, ends the session or sleeps is seen however it is written, and wherever in the action', () => {
  const bind = (action) => parseBinds(`hl.bind("SUPER + K", ${action})`)[0];
  for (const a of ['hl.dsp.exit()', 'hl.dsp.exec_cmd("hyprctl dispatch exit")', 'hl.dsp.exec_cmd("uwsm stop")', 'hl.dsp.exec_cmd("loginctl terminate-user $USER")',
    'hl.dsp.exec_cmd("pkill quickshell")', 'hl.dsp.exec_cmd("killall -9 firefox")', 'hl.dsp.exec_cmd("systemctl suspend")',
    `function()\n${'    local w = hl.get_active_window(); if w and w.class ~= "kitty" and w.class ~= "foot" then end\n'.repeat(4)}    hl.exec_cmd("systemctl suspend")\nend`]) {
    assert.equal(checkShortcut(bind(a)).level, BLOCK, a);
  }
  assert.equal(checkShortcut(bind('hl.dsp.exec_cmd("firefox")')).level, SAFE);
});

test('a shortcut is pressed with its modifiers held', () => {
  assert.deepEqual(pressArgs('SUPER + SHIFT + M'), ['-M', 'logo', '-M', 'shift', '-k', 'm', '-m', 'shift', '-m', 'logo']);
  assert.deepEqual(pressArgs('CTRL + SUPER + Space'), ['-M', 'ctrl', '-M', 'logo', '-k', 'space', '-m', 'logo', '-m', 'ctrl']);
  assert.deepEqual(pressArgs('SUPER + Return'), ['-M', 'logo', '-k', 'Return', '-m', 'logo']);
  assert.deepEqual(pressArgs('XF86AudioLowerVolume'), ['-k', 'XF86AudioLowerVolume']);
  assert.equal(pressArgs('SUPER + SUPER_L'), null, 'a modifier alone is not pressed');
});

test('the tools list the shortcuts and use one: dispatched, pressed or refused', async () => {
  const ran = [];
  const tools = shortcutTools({
    read: async () => ({ binds: BINDS, vars: [VARS, USER] }),
    run: async (file, args) => { ran.push([file, ...args]); },
  });
  const [list, use] = tools;
  assert.deepEqual(tools.map((t) => t.name), ['desktop_shortcuts', 'use_shortcut']);
  const text = await list.execute({});
  assert.match(text, /SUPER \+ A: global shell:quick/);
  assert.match(text, /\[Misc\]/);
  assert.doesNotMatch(text, /kill|ydotool/, 'what can never be used is not offered');

  assert.match(await use.execute({ keys: 'super + a' }), /Done: SUPER \+ A/);
  assert.deepEqual(ran.pop(), ['hyprctl', 'dispatch', 'hl.dsp.global("shell:quick")']);
  await use.execute({ keys: 'SUPER + SHIFT + M' });
  assert.deepEqual(ran.pop(), ['wtype', '-M', 'logo', '-M', 'shift', '-k', 'm', '-m', 'shift', '-m', 'logo']);
  await assert.rejects(use.execute({ keys: 'SUPER + SHIFT + U' }), /can't be used/);
  await assert.rejects(use.execute({ keys: 'SUPER + J' }), /No shortcut SUPER \+ J/);
  assert.equal(ran.length, 0, 'nothing run for a refused or unknown shortcut');

  const none = shortcutTools({ read: async () => null, run: async () => {} });
  assert.match(await none[0].execute({}), /No Hyprland Lua keybinds/);
});
