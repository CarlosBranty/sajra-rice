// What the model is told about the computer it's on, and which of the hands helper's features this one has.
// Pure, so the wording for each system is tested without running on it (test/platform.test.mjs).

/** The prompt's platform line. "darwin" alone left the model using PC habits on a Mac (Cmd+End, cat -A), and the
 *  same goes the other way on Windows (Cmd, ls, grep). next: on Wayland, a beat that waits has a Next button
 *  (stepWaits 'chip'). */
export function platformLine(platform, { macVersion = '', arch = '', release = '', session = '', desktop = '', distro = '', next = false } = {}) {
  if (platform === 'darwin') {
    return `Platform: macOS${macVersion ? ` ${macVersion}` : ''} on ${arch === 'arm64' ? 'Apple silicon' : 'Intel'}. Use Mac keys: Cmd, not Ctrl; the end and start of a document are Cmd+Down and Cmd+Up, of a line Cmd+Right and Cmd+Left (Home and End don't move the cursor in most Mac apps). Shell commands are the macOS (BSD) versions, not GNU: no cat -A, grep -P, date -d or sed -i without ''.`;
  }
  if (platform === 'win32') {
    const build = +String(release).split('.')[2] || 0;
    const name = build ? `Windows ${build >= 22000 ? '11' : '10'}` : 'Windows';
    return `Platform: ${name} on ${arch === 'arm64' ? 'Arm' : 'x64'}. Use Windows keys: Ctrl, not Cmd (in act_in_app steps cmd means Ctrl); the end and start of a document are Ctrl+End and Ctrl+Home, of a line End and Home. run_command runs in cmd.exe: use Windows commands (dir, type, where, findstr) or powershell -NoProfile -Command "…", not Unix ones like ls -la, cat, grep or sed. Paths look like C:\\Users\\name, and ~ is the user's folder.`;
  }
  if (platform === 'linux') {
    const wayland = session !== 'x11';
    // XDG_CURRENT_DESKTOP reads "ubuntu:GNOME": the last part is the desktop itself.
    const de = String(desktop).split(':').filter(Boolean).pop() ?? '';
    return `Platform: Linux${distro ? ` (${distro})` : ''} on ${arch === 'arm64' ? 'Arm' : 'x64'}, ${de ? `the ${de} desktop` : 'a desktop'} on ${wayland ? 'Wayland' : 'X11'}. Use PC keys: Ctrl, not Cmd; the end and start of a document are Ctrl+End and Ctrl+Home, of a line End and Home. run_command runs in bash with the GNU tools (grep -P, sed -i with no '', date -d all work), not the macOS ones. Software comes from the distro's own package manager (apt, dnf, pacman, zypper) or Flatpak or Snap: check which is there before naming one, and installing needs the user's password, so give them the command instead of running sudo. Paths look like /home/name, and ~ is the user's folder.${wayland ? ` Wayland keeps apps from seeing the pointer, clicks and keys in other apps: you can't tell where the user's cursor is or what they clicked, so a draw beat ${next ? 'that waits shows a Next button on screen and goes on when they press it' : 'never waits for a click or hover (beats play one after another)'}, and nothing follows their cursor.` : ''}`;
  }
  return `Platform: ${platform}.`;
}

/** Linux: "x11" or "wayland". The app says which (ROAMIES_SESSION); run without it, the same signs the app reads. */
export function linuxSession(env = process.env) {
  if (env.ROAMIES_SESSION === 'x11' || env.ROAMIES_SESSION === 'wayland') return env.ROAMIES_SESSION;
  return String(env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || env.WAYLAND_DISPLAY ? 'wayland' : 'x11';
}

/** Whether the app can see the pointer and clicks over other apps: draw beats that wait for a click or hover,
 *  the Cursor size and following the cursor all need it. Everywhere but a Wayland session. */
export const seesPointer = (platform, session) => platform !== 'linux' || session === 'x11';

/** How a draw beat with `wait` waits for the user: 'pointer' (their real click or hover is seen), 'chip' (it isn't,
 *  but the overlay is a Wayland layer surface that gets the clicks on its own click areas: it shows a Next button
 *  to press; the app says so with ROAMIES_LAYER=1) or 'none' (neither: the wait is dropped and the beats play
 *  straight through). */
export const stepWaits = (platform, session, layer) => (seesPointer(platform, session) ? 'pointer' : layer === '1' ? 'chip' : 'none');

/** Whether the app can hold global shortcuts and watch the talk keys itself. On Wayland no app can: there the
 *  user binds keys to `roamies --summon`, `--talk` and the rest in the desktop's keyboard settings. */
export const hasHotkeys = (platform, session) => platform !== 'linux' || session === 'x11';

/** Voice in: Apple's speech on macOS, Parakeet on the PC on Windows and Linux. */
export const hasVoice = (platform) => platform === 'darwin' || platform === 'win32' || platform === 'linux';

/** The speech model has to be downloaded first (Parakeet): Windows and Linux. */
export const needsVoiceModel = (platform) => platform === 'win32' || platform === 'linux';

/** Whether the hands helper's tools are on: always on macOS (they explain what's missing), elsewhere when the
 *  helper is there (Roamies sets ROAMIES_HANDS to it). */
export const hasHands = (platform, hands) => platform === 'darwin' || !!hands;

/** Linux in a Hyprland session: the compositor says where windows are (hypr.mjs), which gives the draw tool three of
 *  the helper's window features without the helper: frames fitted to a window, cards beside it, marks cleared when
 *  the window or workspace changes. Not hasHands: nothing finds things by their words or works other apps there. */
export const onHyprland = (platform, env = process.env) => platform === 'linux' && !!env.HYPRLAND_INSTANCE_SIGNATURE;

/** Ask About an Area (the snap shortcut and menu item): the helper's area selection, on macOS and Windows. On Linux
 *  the app picks the area with slurp (linux.rs `area`), a Wayland tool that needs the compositor's layer surfaces:
 *  a Wayland session (session) whose overlay is a layer surface (layer, ROAMIES_LAYER) with slurp there (slurp, its
 *  path: ROAMIES_SLURP). X11 has nothing to pick with (slurp is Wayland only), so it stays off there. */
export const canSnap = (platform, hands, { session = '', layer = '', slurp = '' } = {}) => platform === 'darwin' || (platform === 'win32' && !!hands)
  || (platform === 'linux' && session === 'wayland' && layer === '1' && !!slurp);

/** Wayland: the commands the user binds to keys in the desktop's settings (`<launch> --talk` and the rest), by what
 *  each does. snap: Ask About an Area is on here (canSnap), so `--snap` is one of them. */
export const bindCommands = (launch, { snap = false } = {}) => Object.fromEntries(['summon', 'talk', 'ask', 'list', 'panel', ...(snap ? ['snap'] : [])].map((k) => [k, `${launch} --${k}`]));

/** Circling something while talking: the voice helper draws it while the talk keys are held, on macOS and Windows;
 *  on Linux the mouse does, on a Wayland layer surface (mousePen). */
export const canCircle = (platform, layer = '') => platform === 'darwin' || platform === 'win32' || mousePen(platform, layer);

/** Linux's way of circling: on a Wayland layer surface (layer, ROAMIES_LAYER) nothing follows the cursor over other
 *  apps, but the overlay takes the mouse while a take is heard and a press and drag draws (host.js, pen.js). A
 *  setting on the Voice page, since the overlay has every click meanwhile. */
export const mousePen = (platform, layer = '') => platform === 'linux' && layer === '1';

/** What the model is told about circling (the end of the prompt's Shortcuts part), '' where it can't be done or the
 *  Voice page switched the mouse off (pen). */
export function circleWords(platform, layer = '', pen = true) {
  if (mousePen(platform, layer)) return pen ? "; while they talk to you, they can circle or underline things on screen by dragging with the mouse (a click without dragging stops it for that take), and you'll see what they marked" : '';
  return canCircle(platform, layer) ? "; while holding the talk keys, moving the cursor round something circles it (no clicking; it snaps shut with a click when the circle closes, and loose lines don't count) and you'll see what they circled" : '';
}

// ---------- what the agent is told about pointing and walkthroughs ----------
// Finding a thing by its words or by a read_window id is the hands helper's work, and a beat that waits needs the
// user's click to be seen. The draw tool's description (tools.mjs) and the prompt (sidekick.mjs) take the words
// that depend on either from here, so the agent is only ever sent to what this computer can do.
// hands: hasHands. waits: stepWaits.

/** The draw tool's description: where things are (places), how a walkthrough goes, and a closing note.
 *  Without the helper a place is a box read off a screenshot, drawn where it is given (the helper is what fits a
 *  guess to the real thing), and a walkthrough is a step per call: the next step isn't on the screenshot yet, and
 *  pixels from before a click are refused (pointing.mjs shotProblem). */
export function drawWords({ hands, waits = 'pointer' } = {}) {
  const note = waits === 'none' ? " On this desktop (Wayland) clicks and hovers in other apps can't be seen: never use wait; beats play one after another, so say each step's line in an order that reads well without pausing."
    : waits === 'chip' ? " On this desktop (Wayland) clicks and hovers in other apps can't be seen, so a beat with wait shows a Next button on screen instead (Done on the last of several) and goes on when they press it: word each step's line so they do the step and then press Next. wait 'hover' works the same way."
      : '';
  if (hands) {
    return {
      places: "Places (at, to, tie), best first: {text: the exact words shown on screen} (exact bounds, scrolls to it; target 'screen' searches every app; also words inside paragraphs, text in images or canvases, and a single character, which matches case); add every: true to mark every place that text appears (each letter s, each mention of a word), one mark per place, and within: {x, y, w, h} (screenshot pixels, x, y the centre) to keep to one part of the screen (every s in one sentence); {id} from read_window, for controls without words; {x, y, w, h} pixels in your latest screenshot, for icons, shapes and areas without words: x, y is the thing's centre, and w, h its whole width and height; the box is then fitted to what's really drawn there, so a close guess is enough.",
      walkthroughs: "Walkthroughs (\"how do I…\"): one beat per step, each a target on that step's control with label and wait 'click'; the next step is found after they click, on the screen as it is then.",
      note,
    };
  }
  return {
    places: "Places (at, to, tie): {x, y, w, h} in the pixels of your latest screenshot, where x, y is the thing's centre and w, h its whole width and height. That is the only way to say where something is on this computer: nothing here finds things by their words or reads a window's controls, so text and id don't work. Look first: take a screenshot, then read the place off it carefully, because the mark is drawn exactly where you say.",
    walkthroughs: waits === 'none'
      ? "Walkthroughs (\"how do I…\"): one beat per step, each a target on that step's control with its label, for the steps whose controls are on screen now."
      : "Walkthroughs (\"how do I…\"): a screenshot shows only the step that's on screen now, so one step per call: one beat with a target on that step's control, its label and wait 'click'. When the call returns they've done that step and the screen has changed, so take a new screenshot and draw the next step from it.",
    note,
  };
}

/** The system prompt: finding things on long pages (a whole line, or nothing), the walkthrough sentence of "Show,
 *  don't just tell", what follows "Be fast", and what counts as a fresh look. example: a how-to question to name. */
export function promptWords({ hands, waits = 'pointer', example = 'a how-to' } = {}) {
  if (hands) {
    return {
      pages: "Long pages, feeds and lists: to find something on a page, use draw or click_text with the words you're looking for (they search parts scrolled out of view and scroll there), not scroll after scroll. For \"every post\" or \"each item\" tasks: if the page loads more as you scroll, first act_in_app scroll with to_end; then one read_window shows the whole page (on screen and elsewhere); then do every item in one act_in_app call (fill with near and click_text with near for each, near = words from that item). Don't survey a page by scrolling and screenshotting. Never stop at the first screenful.\n",
      show: `When they ask how to do something in an app (${example}), walk them through it with draw: one beat per step in one call, each marking the control with a target and wait 'click'.`,
      fast: "To point at or click something whose exact words you know (the user said them, or you've seen them), use draw or act_in_app click_text with that text right away, with no read_window or screenshot first. Don't guess words: for \"the version number\" or \"the settings icon\" you don't know what's written, so look first. Put several steps in one act_in_app call. Forms: one act_in_app call with a fill step per field (field = its label or placeholder as shown), choose for dropdowns, fill for typed dates; a field that opens a calendar is clicked, then its month arrows and day are clicked with click_text. Check the field values in the result before saying it's done. When act_in_app shows the page after a click, use that instead of reading again. read_window and act_in_app results include the text on screen, so read pages from them; screenshot only when you need to see something words can't tell you (images, layout, colours).",
      fresh: "draw or click_text with text, read_window or a screenshot made now",
    };
  }
  return {
    pages: '',
    show: waits === 'none'
      ? `When they ask how to do something in an app (${example}), walk them through it with draw: look at the screen, then one beat per step in one call, each marking its control with a target, for the steps whose controls are on screen now.`
      : `When they ask how to do something in an app (${example}), walk them through it with draw, one step at a time: look at the screen, mark the control for the step that's on screen now with a target and wait 'click', and when that call returns look again for the next step.`,
    fast: "To point at something on screen, look first: take a screenshot and give draw the place as x, y, w, h in that picture's pixels. Nothing here finds things by their words, so never give draw text or an id.",
    fresh: 'a screenshot made now',
  };
}

/** What to say when the voice helper can't use the microphone, from its no_input reason (the Mac helper sends
 *  none: it only reports a missing mic). */
export function micTrouble(platform, reason, detail = '') {
  const win = platform === 'win32';
  const sound = win ? 'Settings > System > Sound > Input' : 'your sound settings';
  switch (reason) {
    case 'busy':
      return `Another app has the microphone to itself. Close anything that might be recording (calls, streaming, recorders) and try again.${win ? ' Or untick "Allow applications to take exclusive control" in the mic\'s properties.' : ''}`;
    case 'blocked':
      return win
        ? 'Windows won\'t let me use the microphone. In the Privacy settings I just opened, turn on microphone access and "Let desktop apps access your microphone". If they\'re on already, antivirus or work settings may be blocking it.'
        : 'The system won\'t let me use the microphone. Check your privacy and sound settings, then try again.';
    case 'lost':
      return 'The microphone cut out: it was unplugged, the input changed, or a Bluetooth headset switched modes. Try again.';
    case 'failed':
      return `I couldn't open the microphone${detail ? ` (${String(detail).slice(0, 120)})` : ''}. Check it is the input picked in ${sound}, then try again.`;
    default:
      return `I can't find a microphone. Plug one in and try again.${platform === 'darwin' ? '' : ` If one is plugged in, check it is the input picked in ${sound}.`}`;
  }
}
