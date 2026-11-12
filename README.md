<p align="center">
  <img src="showcase/tauri/src-tauri/icons/128x128@2x.png" width="128" alt="Roamies icon">
</p>

<p align="center">
  <img src="docs/art/hero.gif" alt="Roamies: JARVIS, a glowing globe of LED dots, ripples as it says &quot;At your service.&quot; beside a mouse cursor, while Roamie, Anime Girl, Sarah and Adrian wave and hop on either side">
</p>

<p align="center">
  <strong>A little buddy that lives on your screen and keeps you on track.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/Roamies/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/Roamies?style=for-the-badge&label=Download&color=78ffe2" alt="Roamies desktop release"></a>
  <a href="https://github.com/KenKaiii/Roamies/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/Roamies?style=for-the-badge&label=Stars&color=yellow" alt="Star Roamies on GitHub"></a>
  <a href="https://github.com/KenKaiii/Roamies/releases"><img src="https://img.shields.io/github/downloads/KenKaiii/Roamies/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://www.skool.com/raid"><img src="https://img.shields.io/badge/Skool-Free%20community-78ffe2?style=for-the-badge" alt="Free Skool community"></a>
</p>

Roamies is a little AI buddy that lives on your desktop. It stays by your cursor, talks back in its own
voice, keeps track of what you said you'd do and nudges you when it's due.

> [!TIP]
> **Want to build your own apps with AI?** A free 7-day build challenge and 20+ step-by-step projects are in my free community: **[skool.com/raid](https://www.skool.com/raid)**

> ⭐ **If Roamies keeps you on track, give it a star.** It's the main way other people find it.

## Why Roamies

- **Talk, don't type.** Hold ⌃⌥ (Ctrl+Alt on Windows and Linux), say it, let go. On macOS and Windows, circle something with the cursor while you talk and it sees what you mean (on Linux, drag round it with the mouse).
- **It talks back.** Spoken replies in its own voice, with real feeling, through [Fish Audio](https://fish.audio). On Windows and Linux there's also a free Spanish voice that runs offline on your computer.
- **It remembers.** What you said you'd do, reminders down to the second, and what matters to you.
- **It draws on your screen.** Rings the exact button to click, walks you through each step, and sketches answers beside what you're reading.
- **It does the clicking.** Opens apps, sites and files, and on macOS and Windows clicks or types in other apps for you.
- **Your subscriptions.** Sign in with Claude or ChatGPT, or use an API key (Gemini, Grok, Kimi Code and more).

| Pick your Roamie | What you get                                            |
| ---------------- | ------------------------------------------------------- |
| **JARVIS**       | **A glowing sphere of light that ripples as it speaks** |
| Roamie           | The original: a tiny glowing pixel creature             |
| Anime Girl       | A pixel anime girl                                      |
| Sarah            | A pixel woman                                           |
| Adrian           | A pixel man                                             |

<sub>Each one has its own name, voice and animations, in three sizes: Default, Small, or Cursor, a pixel pointer that rides along with your mouse.</sub>

## JARVIS shows you how

<p align="center">
  <img src="docs/art/jarvis-shows-you-how.gif" alt="Asked &quot;How do I export this as an MP4?&quot;, JARVIS turns into its reticle cursor, rings the Format menu, then MP4, then the Export button in a video editor, waiting for each click while a caption reads each step">
</p>

Ask how to do something in any app. JARVIS turns into its cursor, rings the exact button on your real screen,
says the step out loud and waits for your click before showing the next one.

## JARVIS explains anything

<p align="center">
  <img src="docs/art/jarvis-explains.gif" alt="Asked how black holes work while reading Wikipedia, JARVIS draws an answer card tied to the page, a turning 3D black hole with its glowing disk, underlines the key sentence and adds a discovery timeline">
</p>

Ask about whatever you're looking at. JARVIS sketches the answer right beside it while it talks: cards, graphs,
timelines, photos, molecules and turning 3D models, all in its own glowing ink. Ask it to change any part, or
clear it all in one go.

## Also included

- **The Roamies panel:** click the menu bar or tray icon (on Linux, **Open Panel** in its menu) for what it's doing, what it remembers, and every setting.
- **Safe by default:** file edits, commands and app control stay off until you turn them on, and risky steps always ask.
- **Shows its work:** every tool plays its own animation, so you can see what it's doing.
- **Where keys live:** your Fish Audio key stays in the macOS Keychain (encrypted with Windows DPAPI on Windows, in your desktop's keyring on Linux). AI sign-ins are stored in `~/.gg/auth.json`, shared with GG Coder.
- **Out of the way:** no Dock or taskbar button, a shortcut shows or hides it (see the table), Esc stops a reply.
- **Updates itself:** updates are signature-checked before they install, then it restarts itself. The Windows installer isn't code-signed yet, so SmartScreen warns the first time. On Linux only the AppImage updates itself.
- **Quick setup:** permissions, sign-in and a short chat so it gets to know you.

|                        | macOS                      | Windows                     | Linux (beta)                       |
| ---------------------- | -------------------------- | --------------------------- | ---------------------------------- |
| Talk to it             | Yes, best on macOS 26+     | Yes, speech runs on your PC | Yes, speech runs on your PC        |
| Circle while talking   | Yes                        | Yes                         | With the mouse, on layer surfaces  |
| Spoken replies         | Yes, with a Fish Audio key | Fish Audio, or a local voice (Spanish) | Fish Audio, or a local voice (Spanish) |
| Memory and reminders   | Yes                        | Yes                         | Yes                                |
| Read windows and point | Yes                        | Yes                         | Points from screenshots only       |
| Cards and diagrams     | Yes                        | Yes                         | Yes                                |
| Click and type in apps | Yes                        | Yes                         | No                                 |
| Ask about an area      | Yes (⌃⌥A)                  | Yes (Ctrl+Shift+A)          | With `slurp`, a key you bind\*     |
| Show or hide           | ⌃⌥S                        | Ctrl+Shift+S                | Ctrl+Alt+S, or a key you bind\*    |
| Talk shortcut          | Hold ⌃⌥                    | Hold Ctrl+Alt               | Hold Ctrl+Alt, or a key you bind\* |
| Updates itself         | Yes                        | Yes                         | AppImage only                      |

<sub>\* On Wayland (the default on Ubuntu, Fedora and KDE), apps can't grab keys, so you bind Roamies' commands to keys
in your desktop's keyboard settings. [Linux (beta)](#linux-beta) shows how.</sub>

<sub>Before macOS 26, talking uses Apple's older speech recognizer, which needs Siri or Dictation turned on.</sub>

<sub>On Windows, Roamies reads other apps through UI Automation and finds words on screen with Windows' own text
recognition (it needs a Windows language with text recognition, which most have). It can't type or click in apps
running as administrator, and it borrows your cursor for real clicks, keys and scrolling, giving it back when it's done.
Windows also leaves Roamies out of every screen capture, so it won't show in your screenshots or screen shares.</sub>

<sub>Spoken replies are billed to your own Fish Audio account; the panel shows what each voice model costs. Voice on
Windows and Linux uses [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), in the ONNX export by
[istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), run with
[parakeet-rs](https://github.com/altunenes/parakeet-rs). The model (about 670 MB) downloads once at setup and isn't bundled.</sub>

<sub>**Local voice (Spanish)**, Windows and Linux: picked on the panel's Voice page (Replies), it speaks replies on your
computer, offline, free and with no key, in one voice for every look: the female speaker of
[Piper](https://github.com/OHF-Voice/piper1-gpl)'s `es_ES` sharvard voice (medium, retrained upstream; MIT, trained on
the Sharvard corpus by Aubanel, Garcia Lecumberri and Cooke, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),
and on NVIDIA's Hi-Fi TTS, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); full credits in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)), spoken through [eSpeak NG](https://github.com/espeak-ng/espeak-ng). It's a Spanish (Spain) voice: replies in other languages
sound Spanish-accented, so it suits Language set to Español. It downloads once (about 77 MB) the first time it's picked.
Fish Audio stays the default.</sub>

## Get started

1. Install Roamies:

   **macOS (Apple silicon or Intel):** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and open the `.dmg` for your Mac (`aarch64` for Apple silicon, `x64` for Intel). Requires macOS 13.5 or later.

   **Windows:** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and run the `.exe` installer. Requires Windows 10 or later. It isn't code-signed yet, so Windows shows a SmartScreen warning the first time: click **More info**, then **Run anyway**.

   **Linux (beta, x86_64):** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and pick one:
   the `.deb` (Ubuntu, Debian, Mint, Pop!_OS: `sudo apt install ./Roamies_*_amd64.deb`), the `.rpm` (Fedora,
   openSUSE: `sudo dnf install ./Roamies-*.x86_64.rpm`), or the `.AppImage` (any distro: `chmod +x` it and run it; only
   the AppImage updates itself). Needs glibc 2.38 or later: Ubuntu 24.04, Fedora 39, Debian 13 or newer. See
   [Linux (beta)](#linux-beta) for what works and how to set up shortcuts.

   **Development:** With Rust, Node.js 22+, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and, on macOS, the Xcode Command Line Tools installed:

   ```bash
   git clone https://github.com/KenKaiii/Roamies.git
   cd Roamies/showcase/tauri
   (cd sidecar && npm ci && npm test)
   ./build.sh dev        # debug build
   ./build.sh            # release bundle for this OS
   ```

2. Open the app, follow the setup guide, pick your Roamie, and hold ⌃⌥ (Ctrl+Alt on Windows and Linux) to say hi.

<sub>The first time you sign in with Claude, Roamies downloads Claude Code (about 140 MB). On Windows and Linux, the voice model (about 670 MB) downloads once at setup.</sub>

## Linux (beta)

Roamies on Linux is a beta: it runs on GNOME, KDE Plasma and other desktops, on Wayland or X11, but it's been tested
far less than on macOS and Windows. Bug reports with your distro, desktop and session (`echo $XDG_SESSION_TYPE`) help.

**What works:** the Roamie on screen, the panel, typed and spoken questions (speech runs on your computer), spoken
replies, memory and reminders, screenshots of the screen in use and pointing at things on them, cards and diagrams,
files and commands, Ask About an Area on Wayland with `slurp`, Open at Login, and in-app updates for the AppImage (a
`.deb` or `.rpm` copy opens the download page instead).

**Not yet:** reading or working other apps, circling while talking without layer surfaces (GNOME, X11), and the Cursor
size on Wayland.

**Wayland** (the default on Ubuntu, Fedora and KDE) doesn't let apps grab keys or see the pointer over other apps, so:

- Shortcuts are commands you bind to keys yourself. The panel's **Behavior** page lists them with a **Copy** button
  (for an AppImage they start with its path instead of `roamies`):

  | Command            | What it does                                        |
  | ------------------ | --------------------------------------------------- |
  | `roamies --talk`   | Start listening; press again (or pause) to send     |
  | `roamies --summon` | Show or hide the Roamie                             |
  | `roamies --ask`    | Ask by typing                                       |
  | `roamies --list`   | Show your list                                      |
  | `roamies --panel`  | Open the panel                                      |
  | `roamies --snap`   | Ask about an area: drag a rectangle, then ask       |

  - **GNOME:** Settings › Keyboard › View and Customize Shortcuts › Custom Shortcuts › **+**, then the command and your keys.
  - **KDE Plasma:** System Settings › Keyboard › Shortcuts › **Add New** › **Command or Script**.
  - **Sway:** `bindsym Ctrl+Alt+space exec roamies --talk` in `~/.config/sway/config`.
  - **Hyprland:** `bind = CTRL ALT, SPACE, exec, roamies --talk` in `~/.config/hypr/hyprland.conf`.
- Walkthroughs can't see your clicks: on compositors with layer surfaces (below) each step waits for you to press its
  **Next** button (**Done** on the last), elsewhere they play their steps one after another.
- Screenshots go through your desktop's screenshot portal, which may ask you to allow them.
- **Ask About an Area** needs [slurp](https://github.com/emersion/slurp) (the `slurp` package on most distros) and a
  compositor with layer surfaces (below); Roamies offers it (`roamies --snap`, the tray menu, the panel) once slurp is
  there, after a restart. Drag a rectangle round what you mean, then ask by voice or typing; Esc or a click without
  dragging cancels, and so does leaving it for three minutes. The Roamie steps out of the way while you pick, and
  isn't in the picture. GNOME has no layer surfaces for slurp, and X11 sessions nothing to pick with yet.
- **Circling while talking** is done with the mouse on compositors with layer surfaces (below): while it listens,
  drag round or under what you mean, and that part of the screen goes with your words, your strokes drawn on it.
  Meanwhile the Roamie has every click: a click without dragging gives the mouse back for the rest of that take, and
  the take ending gives it back in any case. **Draw with the mouse while I listen** on the panel's Voice page
  (Talking) turns it off, for example when the wake word would take the mouse on a false start.
- On compositors with layer surfaces (Hyprland, Sway and others built on wlroots, KDE Plasma) the Roamie is a native
  Wayland layer above your windows and bars: it takes no tile or workspace, clicks land on whatever is under it
  everywhere except on the Roamie and what it shows, and it has the keyboard only while you type to it: a click
  anywhere else then gives the keyboard back (that one click goes no further) and leaves the question open, for a
  click on its bubble to take up again. The panel opens in the top right corner. Window rules written for the old
  `Roamies` window no longer match: the layers are named `roamies` and `roamies-panel`. Elsewhere (GNOME) its
  windows still go through XWayland, as on X11.
  `ROAMIES_LAYER_SHELL=0 roamies` keeps the XWayland windows if the layer misbehaves on your compositor, and
  `ROAMIES_LAYER_SHELL=1` asks for the layer where Roamies didn't pick it.

Roamies needs the `gtk-layer-shell` library to start, on every desktop: install it beside the `.deb` or `.rpm`
(`libgtk-layer-shell0` on Debian and Ubuntu, `gtk-layer-shell` on Fedora, openSUSE and Arch). Building from source
needs its development files (`libgtk-layer-shell-dev`, `gtk-layer-shell-devel`).

On X11 sessions the shortcuts work as on Windows (hold Ctrl+Alt to talk, Ctrl+Alt+S to show or hide).

**On Hyprland** Roamies asks the compositor where your windows are (`hyprctl -j clients` and `monitors`, read only),
as it asks its helper on macOS and Windows: a frame drawn round a window takes that window's edges, cards go beside
the window you're in instead of over it, and a drawing goes away when another window comes to the front, that window
moves, or you switch workspace. Other Linux desktops don't say where windows are, so there frames stay as drawn and a
drawing doesn't notice the window changing. It still can't read or work the windows themselves.

**Quiet while you talk:** with **Lower other sounds** on (the panel's **Voice** page, off by default), every other
app's sound goes down while Roamies listens and while it speaks a reply, to 10, 20, 30 or 50 % of what each app had,
and comes back when it stops. It needs `pactl` (PipeWire's pulse server or PulseAudio). A sound that starts meanwhile
is left alone, and so is Roamies' own voice. If Roamies is killed while the volumes are down, they go back up the
next time it starts.

**Call it by name:** with **Wake word** on (the panel's **Voice** page, off by default) and a phrase of your own
typed there (a word or two, like a name, in any language the voice model reads), saying the phrase starts listening
as `roamies --talk` does, and a pause sends it. What you say right after the phrase, in the same breath, is part of
the question. The microphone stays on to hear it: when there's a voice, its last few seconds are read on your
computer, about once a second at most, and nothing leaves it until the phrase is heard. Case, accents and a letter's
difference in spelling don't matter. It doesn't listen while a reply is being spoken, and a room where somebody (or
a video) talks all day costs some CPU.

**A home in your bar** (Quickshell, Waybar, eww and the like): a bar can keep a slot for the Roamie. The Roamie then
comes out of that slot when it has something to do and goes back into it after, and the bar draws it resting there
meanwhile. The two leave each other notes in `$XDG_RUNTIME_DIR/roamies/`:

- `dock.json`, written by the bar: `{"x": 1830, "y": 23, "sw": 2304, "sh": 1440, "mx": 0, "my": 0}`. `x`, `y` is the
  centre of the slot, `sw` × `sh` the size of its screen and `mx`, `my` where that screen starts, all in logical pixels.
  Roamies reads it every couple of seconds; without the file nothing changes. With several screens, write it from the bar
  of the screen in use and rewrite it when that changes: on compositors with layer-shell the Roamie moves to that screen.
- `state.json`, written by Roamies: `{"pid": 1234, "exe": "/usr/bin/roamies", "out": false, "keys": false, "t": 1794359725}`.
  `out` is true while the Roamie is on screen (so the slot is empty). `keys` is true while something is being typed to
  it; a tiling compositor leaves the keyboard with the overlay afterwards, so when `keys` is false and the overlay
  still has the keyboard, the bar should give it back to the window that had it. `t` is when it was written, in seconds; it's rewritten every
  couple of seconds, so an old one means Roamies isn't running. `exe` is the command to run with `--talk`, `--panel`
  or `--summon` when the slot is clicked.

**Your desktop's colours:** with Colors set to System (the panel's Appearance page), Roamies follows the desktop:
light or dark, and its colours when the bar or shell says them, in a third note in the same folder (with or without a
slot):

- `theme.json`, written by the bar or shell:
  `{"light": true, "bg": "#f2e7de", "surface": "#ffffff", "fg": "#100a05", "muted": "#786c61", "line": "#e4d6cb", "accent": "#9e6630", "danger": "#d71921"}`.
  `light` (true or false) is required. The colours are the background, raised surfaces, text, muted text, lines, the
  accent and errors, each written as `#rrggbb`; any of them can be left out, and one written any other way is ignored
  (Roamies then uses its own light or dark colour for it). Everything else Roamies draws is worked out from these few,
  the character included: its dots run from a dark shade of the accent to a light one. Roamies reads the note every
  couple of seconds, so rewrite it when your theme changes; without the file it follows the desktop's light or dark
  setting with its own two schemes.

**Troubleshooting:**

- **No tray icon on GNOME:** GNOME hides tray icons unless the
  [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) is on (Ubuntu has it on
  already). Without it, open Roamies again from your apps (or run `roamies --panel`) to get the panel.
- **The overlay draws black or not at all (often NVIDIA):** start Roamies with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- **"Couldn't save the key" for Fish Audio:** Roamies keeps it in your keyring with `secret-tool`. Install it
  (`libsecret-tools` on Debian and Ubuntu, `libsecret` on Fedora and Arch) and make sure a keyring (GNOME Keyring,
  KWallet or KeePassXC) is running.
- **It can't hear you:** check the input device picked in your sound settings; Roamies uses the default microphone.
- **With fractional scaling** the Roamie may look a little soft.

## Money

Roamies can keep track of your card and wallet spending from the notification mails your bank sends for each
charge. Add a mail account on the panel's **Money** page: Gmail or Yahoo, with an app password made for Roamies
(the page says how; Outlook is coming). Then, every few minutes while Roamies runs:

- **What it reads:** only mails from your banks' exact sender addresses (Banco Falabella and BCP so far), the last 90
  days the first time, then only new ones. Gmail's All Mail (not Spam or Trash), Yahoo's Inbox (not Bulk).
- **Read-only:** the mailbox is opened read-only and mails are fetched without marking them read. Nothing is moved,
  flagged, deleted or sent. A mail counts only when your provider says it really came from the bank (DKIM or DMARC).
- **Where data lives:** each charge's date, amount, merchant, the last four digits of the account and the operation
  number, in `~/.gg/sidekick/money.db` (on Windows `%USERPROFILE%\.gg\sidekick\money.db`); where reading stopped, in
  `mail.db` beside it. Mail bodies are not kept; a mail it couldn't read is kept as its sender, subject and date. The
  app password is only in your Keychain, Windows (encrypted for your account) or your keyring; the settings keep the
  provider and address. The mail goes from your provider to this computer only.
- **Removing everything:** remove each account on the Money page (that deletes its app password from the keyring),
  then delete `money.db` and `mail.db`. Revoke the app password in your Google or Yahoo account too: a Yahoo one keeps
  working after you change your Yahoo password.

## Privacy

Roamies has no analytics, and nothing is collected by the developer. Your messages, and screenshots when you ask
about the screen, go to the AI provider you pick. [PRIVACY.md](PRIVACY.md) lists what's sent where.

## Uninstall

**macOS:**

1. Turn off **Open at login** (panel > Behavior), then quit Roamies from the menu bar.
2. Drag Roamies from Applications to the Trash.
3. Delete `~/.gg/sidekick` and `~/.gg/sidekick.json`. Keep `~/.gg/auth.json` if you use GG Coder.
4. Open Keychain Access, search for "Roamies" and delete the Fish Audio key.

**Windows:**

1. Turn off **Open at login** (panel > Behavior), then uninstall Roamies from Settings > Apps.
2. Delete `%USERPROFILE%\.gg\sidekick` and `%USERPROFILE%\.gg\sidekick.json`. Keep `auth.json` if you use GG Coder.
3. Delete the voice model folder, `%LOCALAPPDATA%\Roamies\models`.

**Linux:**

1. Turn off **Open at login** (panel > Behavior), then quit Roamies from its tray menu (or the panel's About page).
2. Remove the package (`sudo apt remove roamies` or `sudo dnf remove roamies`), or delete the AppImage.
3. Delete `~/.gg/sidekick` (the voice model is in `~/.gg/sidekick/models`) and `~/.gg/sidekick.json`. Keep
   `~/.gg/auth.json` if you use GG Coder.
4. Delete the Fish Audio key: `secret-tool clear service com.kenkai.roamies account fish-audio`.

## Build with the framework

Every Roamie's brain is a [gg-framework](https://github.com/KenKaiii/gg-framework) agent running in a Node
sidecar. Want to build your own? Install just what you need.

- [**@kenkaiiii/gg-ai**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-core/README.md): Model selection, authentication, and local model discovery.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. Roamies is licensed under [AGPL-3.0](LICENSE): you can build
on it, and if you distribute your changes or run them as a network service, you share their source under
the same license.

## Contributing

Bug reports, ideas and pull requests are welcome. [Open an issue](https://github.com/KenKaiii/Roamies/issues)
to get started, read [CONTRIBUTING.md](CONTRIBUTING.md) before a pull request, and report security problems as described in [SECURITY.md](SECURITY.md).

## Learn with me

New to building with AI? Start in **[RAID](https://www.skool.com/raid)**, my free community:

- A free 7-day challenge: build your first app, one short lesson a day
- 20+ step-by-step projects you can build yourself

## Star history

<a href="https://star-history.com/#KenKaiii/Roamies&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/Roamies&amp;type=Date&amp;theme=dark">
    <img alt="Roamies star history chart" src="https://api.star-history.com/svg?repos=KenKaiii/Roamies&amp;type=Date">
  </picture>
</a>

<p align="center">If Roamies is useful to you, ⭐ star the repo so more people find it.</p>
