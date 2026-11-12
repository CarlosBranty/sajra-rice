# AGENTS.md

Hanami is a modified version of Roamies by Ken Kai (KenKaiii/Roamies, AGPL-3.0-only; credits in `NOTICE` and the
panel's About page, which must keep showing the original project, its author and the licence). The rename is
user-facing only: the product name, window and menu text, copy, the default look's name ("Hanami"), the agent's
prompt, the Linux program `hanami` (`[[bin]]` in `src-tauri/Cargo.toml`; the crate stays `roamies`) and the
identifier `com.hanami.assistant` (the webview's local storage under the old `com.kenkai.roamies` isn't carried over;
it only held per-viewer conveniences). Internal names stay as upstream's to ease merges: JS globals (`window.Roamie`,
`R.*`, `__roamie*`), file and function names, `ROAMIES_*` variables, the `roamies-voice` and `roamies-hands` helpers,
the keyring service `com.kenkai.roamies`, `~/.gg/...`, the layer-shell namespaces `roamies` and `roamies-panel`.
Hanami's own GitHub repository goes in one place, `FORK_REPO` (`"OWNER/REPO"`) in `src-tauri/src/main.rs`: empty,
no update check runs and nothing links to a repository of its own; set, it drives the updater's feeds, the
releases page, the diagnostics issue link and About's source link (the sidecar gets it as `ROAMIES_REPO`).

Roamies (Hanami): a Tauri 2 desktop app (Rust shell in `showcase/tauri/src-tauri`), a Node sidecar that runs the
agent (`showcase/tauri/sidecar`), shared browser JS in `showcase/roamies`, macOS Swift helpers built by
`src-tauri/build.rs`, and two Windows helpers built by `build.sh` for Windows targets: voice
(`src-tauri/voice-win`, Rust + Parakeet; `--transcribe <wav>` and `--test-audio <wav>` test speech without a
Windows PC, see the top of its `main.rs`) and hands (`src-tauri/hands-win`, the twin of `hands/main.swift`: same
commands and JSON, over Win32, UI Automation and Windows OCR). Only hands-win's `logic.rs` builds off Windows, so
`cargo test` there runs its checks anywhere; `roamies-hands --smoke` drives Notepad on a real Windows desktop (CI).
From a Mac, `cargo xwin check --target x86_64-pc-windows-msvc` type-checks the Windows code with the real SDK.

Linux (beta) uses the same voice helper (`voice-win` builds for Linux too: ALSA mic, talk keys over X11, and a
`toggle` command for `hanami --talk` on Wayland) and no hands helper. Its shell code is `src-tauri/src/linux.rs`,
which picks one of two ways to make windows before GTK starts. On a Wayland compositor with layer-shell (Hyprland,
Sway, KDE; it is asked over its socket) GTK runs on Wayland itself: each overlay is a layer surface over its monitor
(namespace `roamies`, on the overlay layer, the keyboard only while something is typed to the Roamie), the panel
is one in the top right corner (`roamies-panel`), and the setup guide is an ordinary window. Everywhere else (X11
sessions, and Wayland without layer-shell, like GNOME) every window is an X11 window (`GDK_BACKEND=x11` on Wayland,
through XWayland). Either way the overlay lets clicks through by region (the page reports its click areas, `host.js`
→ `set_hit_rects`) instead of following the cursor, and screenshots (the screen in use, cut out of a capture of
every screen), Ask About an Area (on layer-shell compositors the user drags it with `slurp`, and it is cut out of a
capture the same way), copying, Open at Login and AppImage-only updates live there too. Building needs the system library
`gtk-layer-shell` (`libgtk-layer-shell-dev` on Debian and Ubuntu). Debug aids: `ROAMIES_TRACE=1` prints which way was
picked, the overlay's click areas and what each screenshot was cut to, `ROAMIES_LAYER_SHELL=0` keeps the X11 windows
and `ROAMIES_LAYER_SHELL=1` takes layer surfaces on any Wayland session, and in debug builds
`ROAMIES_TEST_AUDIO=<wav>` stands in for the microphone and `ROAMIES_SHOT_DIR=<dir>` keeps a copy of every
screenshot handed to the agent there, with its pixels and bounds in a `.json` beside it (`hanami --shot` takes one
without asking the agent anything; they show your screen, so delete them after).
`ROAMIES_LATENCY=1` (any build) times each spoken question on the wall clock: the Windows and Linux voice helper sends
when the voice stopped, the take closed (and why) and its words were ready with the words, the
sidecar adds the request, first token, first sentence to the voice and first Fish audio, and the page when that audio
starts playing (`voice-out.js`); `~/.gg/sidekick.log` gets one `[latency]` line per stage and a summary with the gaps
(`sidecar/latency.mjs`). Debug builds: `ROAMIES_FISH_MODEL=s2.1-pro` (or `drama-3`) voices that run without changing
the saved setting (an account with no credit stays on the free tier either way).

Listening (Windows and Linux voice helper): Silero VAD v6 (`voice-win/src/vad.rs`, MIT, `silero-vad.onnx` next to
the Parakeet files) tells a voice from noise for takes and the wake word; without that file a voice is a level, as
before (sound under -60 dBFS is never given to it, so a quiet room costs next to nothing). Waiting for the wake word, Parakeet reads only the stretches of voice it hears (each when it ends, or every
2.5 s or more while it goes on, the next read reaching back past the cut by the phrase's length, at least 1 s; a phrase
that ends right at a cut is read again whole before a take starts), and for 6 s after a spoken reply (and its 1 s echo) a voice is the next
question without the phrase. A hands-free take quiet for 0.25 s asks the end-of-turn check (Smart Turn,
`smart-turn.onnx`) and ends as soon as it says the turn is over and a read has heard words that sound finished (a
question, or a full stop after four words or more, not ending on "y", "de", "eh"…); otherwise the pauses decide as
before. While a reply is under way the app tells the helper it is speaking, gaps between its chunks included.
`ROAMIES_TEST_VAD=<silero-vad.onnx> cargo test vad` checks the probabilities against the official wrapper's
(`fixtures/silero-vad-hola.*`). `roamies-voice --model <dir> --bench-listen <wav> [--phrase P] [--listen] [--no-vad]
[--turn p]` plays a WAV as the microphone at real speed and prints the CPU seconds and Parakeet reads it cost, and how
a take ended (see the top of `main.rs`).

The local voice (Windows and Linux): `roamies-voice --speak <voice.onnx> [--speaker 1] [--threads 2]` speaks a Piper
voice as upstream Piper 1.8 (`OHF-Voice/piper1-gpl`) does, in a process of its own that the sidecar starts when the
voice is picked (`sidecar/localvoice.mjs`, JSON lines; see the top of `voice-win/src/speak.rs`). Text becomes phonemes
with espeak-ng, built from source by `voice-win/build.rs` at the commit Piper pins (downloaded once and checked; set
`ESPEAK_NG_SOURCE` to a checkout to build offline; needs CMake and a C compiler), whose data is compiled at build time,
deflated into the helper and unpacked next to the voice on first use. Every dictionary is built, as Piper ships them:
for letters outside the Spanish alphabet espeak-ng switches language and crashes if that dictionary is missing
(`build.rs` `check_switches` fails the build if one could be). Sentences longer than `MAX_PHONEMES` go to the model in
pieces (memory grows with length). If the helper still dies on a text, the sidecar skips that text and starts it again
once. The VITS model runs on the `ort` Parakeet already links. The voice (`es_ES-sharvard-medium`
at piper-voices commit cf910fb, speaker F) downloads on first use next to the speech model. `cargo test` there checks
that text gives the same phoneme ids as Piper 1.8 (`voice-win/fixtures/piper18-ids*.json`, made once with Piper's
Python package) and that no character crashes espeak-ng; `ROAMIES_TEST_VOICE=<voice.onnx> cargo test --release --test
speak` runs `--speak` end to end on a copy of the voice. Debug builds: `ROAMIES_VOICE_ENGINE=local` (or `fish`) picks the voice for one run
without changing the saved setting.

Money (`sidecar/money.mjs`, `sidecar/money/`): expenses read from bank notification mails, kept in
`<data dir>/money.db` (`node:sqlite`, schema migrations in `money/store.mjs`); questions run as one read-only SELECT
in a child process with row and time limits (`money/query.mjs`). The agent's tools (`money/tools.mjs`) read
(`spending`, `balance`, `query_expenses`, `categories`, `next_pending_expenses`) and change: categories, classifying
(learns merchant → category rules), expenses and income added by hand (source `manual`; kind `income`), own accounts
(a recipient that is the user: their transfers, past and future, become `own_transfer`, the old kind kept in
`own_from` so unmarking restores it). What undoes a decision of the user's (rename or delete a category, change or
remove a classification, delete an entry, unmark, mark over classified transfers) first waits for
`authorize(reason)` and is applied only if, planned again inside the transaction, it is still what was confirmed.
Those changes are one function each in `money/ops.mjs`, shared by the tools and the panel's Money page
(`money/panel.mjs`, `panel_money` messages): its Movements tab is the whole table (filters for month, category or not
classified, spending / income / not counted and full-text search; paged by the sidecar, totals per currency), where rows
are classified (a new category too), unclassified, marked as the user's own or deleted (added by hand); Add by hand adds
an expense or income. Every message from the page is checked there (zod, strict); protected ones ask the same
`authorize`. The panel's browser preview (`?tab=money`, `?empty`) answers with sample movements.
Income is `transfer_in` and `income`; balance = income − spending. Banks are data, one JSON per bank in `sidecar/banks/`
(bundled in), and users add or replace them with the same JSON in `<data dir>/banks/` (`otherLabels`: the layout's
labels that are not read, so an empty value never runs into the next row). Own-account transfers and refused purchases
(`own_transfer`, `rejected`) are stored as `ignored`; summaries leave out every `NOT_SPENDING` kind. Test fixtures are
synthetic: copy a real mail's markup, never its names, account numbers or amounts.
Protected money changes (renaming or deleting a category, changing or removing a classification, deleting a manual
entry, unmarking an own account) call `authorize(reason)` (`sidecar/safety.mjs` `createAuthorize`). On Linux the shell
(`src-tauri/src/auth.rs`) shows a prompt by the Roamie (`roamies/agent-auth.js`, host.js) and checks the user's password
and fingerprint in parallel with PAM, like the glyph lock: `pam_faillock` + `pam_unix`, and `pam_fprintd`. libpam is
opened at run time; the configs are compiled in and written for each attempt to a 0700 folder under
`$XDG_RUNTIME_DIR/roamies/` that is removed after (`pam_start_confdir`, Linux-PAM ≥ 1.4; it fails closed without it).
The password goes from the page to the shell (`auth_password`), never to the sidecar or logs. Only the shell reports
`auth_result`: `sidecar_send` drops `auth*` from pages. Elsewhere `authorize` returns false. `safety.mjs` blocks agent
writes and commands that touch `money.db`, `mail.db` or `<data dir>/banks/`.
Desktop (`sidecar/desktop.mjs`, Hyprland): `desktop_windows` lists the screens (the laptop's told apart, numbered left
to right), the workspace each shows and every window with its address; `window_keys` sends a key combination to one
window in the background (`hl.dsp.send_shortcut`); `window_type` types into a kitty in the background through its
remote control (`allow_remote_control socket-only`, `listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}` in kitty.conf;
text over stdin) and into any other window by focusing it for a moment, then putting back that screen's workspace and
the user's window; `terminal_output` reads a kitty's screen or last command's output. Text with Enter in a terminal goes
through `classifyCommand` like run_command (refused, or asked first); password managers and prompts are never typed into.
A yes/no question (Allow / Don't allow) can be answered by voice: while one is open a take doesn't interrupt the
request or close the bubble (host.js), and its words go to `answerByVoice` (sidekick.mjs, `speech.mjs` `spokenChoice`:
"sí", "dale", "permite"… allow; "no", "cancela"… decline; anything else leaves the question open).
Native panel (Linux, `src-tauri/src/panel_socket.rs`): a client such as the glyph dotfiles' Quickshell panel connects to
`$XDG_RUNTIME_DIR/roamies/panel.sock` (in auth.rs's private 0700 folder, refused if it isn't private; the socket 0600, a
stale one removed at start). One JSON object per line both ways (other lines ignored; a line over 1 MiB drops the
connection), one client at a time (a new one replaces the old). The shell sends it every `to_panel` message verbatim
(whether the web panel exists or not) plus `{"kind":"open"}` / `{"kind":"close"}`; the client sends what the web panel
passes to `sidecar_send`, through the same `page_may_send` gate, plus `{"type":"panel_hide"}` (it closed; the sidecar
gets `panel_closed`) and `{"type":"hello"}`. It sends `panel_open` itself when it shows, as the shell does for the web
panel. While one is connected every way of opening the panel (tray, `hanami --panel`, `panel_show`, a plain second
launch) opens it instead, and a tray click while it's open closes it; `ROAMIES_WEB_PANEL=1` keeps the web panel.
Dictation (Linux): `hanami --dictate` on a key's press and `hanami --dictate-end` on its release (two compositor
binds, `{ release = true }` on the second) hold a take in the running voice helper (`hold` and `release` commands;
pauses don't end it, MAX_HELD does if the release never comes) whose words are typed where the keyboard is with
`wtype` (`voice.rs` `dictate`, `dictation_text`), not sent to the agent: no model or process of its own.
Devices (Linux, the Voice page's Devices tab): the microphones and speakers come from `pactl -f json list
sources|sinks` (`sidecar/audiodev.mjs`, monitors left out); a pick is a device name, '' the system's default. The voice
helper is started with `PIPEWIRE_NODE` and `PULSE_SOURCE` set to the microphone (`voice.rs` `set_mic`; a change
restarts it), and Roamies' own playback streams are moved to the speaker with `pactl move-sink-input` when the pick
changes and whenever a reply starts playing (`linux.rs` `set_speaker`, `route_own`). The microphone boost (100–400 %)
is applied by the helper to what it hears only (`voice-win/src/audio.rs` `amplify`, the `gain` command), not to the
microphone's level for other apps.
Usage (`sidecar/usage.mjs`): the agent's `token_usage` tool sums `~/.gg/sidekick/usage.jsonl` (one line per request:
provider, route, model, token counts, never what was said) for today, yesterday, the last 7 days, this month or all,
and says how it answers now: Anthropic signed in with Claude (Claude Code, the user's subscription), another
provider's account, or an API key.
Shortcuts (`sidecar/shortcuts.mjs`, Hyprland with a Lua config such as the glyph dotfiles): `desktop_shortcuts` reads
`~/.config/hypr/hyprland/keybinds.lua` (keys from `variables.lua`, `user.lua` overrides) each time, and `use_shortcut`
runs the bind's own action in the compositor's Lua (`hyprctl eval`, with the config's `variables` and
`hyprland.functions` modules loaded as keybinds.lua has them; keys pressed with wtype don't trigger Hyprland binds). `safety.mjs` `checkShortcut` keeps out binds that kill or restart, type text, or sleep or power off.
Mail (`sidecar/mail/`): bank mails over IMAP with app passwords (Gmail, Yahoo; `imapflow`, `mailparser`), strictly
read-only: EXAMINE, `BODY.PEEK[]`, a server-side SEARCH for the definitions' exact senders inside a 90-day or UID
window (cursors with UIDVALIDITY in `<data dir>/mail.db`), never STORE, COPY, MOVE or EXPUNGE. Only the receiving
provider's own Authentication-Results header goes to `parseMail` (`providerAuthResults`; Yahoo's is `mta.yahoo.com`).
Mails kept as not understood remember the definitions' fingerprint; when it changes they are looked up again by
Message-ID (`SEARCH HEADER`, read-only too) and read with the new definitions. App passwords live only in
the keyring through `secrets.mjs` (`mail-<hash>` per account); the settings keep `{ provider, email }` (`email`, so
diagnostics redact it). `mail/service.mjs` polls while the app runs and does nothing without an account; its tests run
against `test/fake-imap.mjs`, which records every command.

## Commands

```sh
cd showcase/tauri/sidecar && npm ci     # install sidecar deps
npm test                                # sidecar tests (reply stream, storage, pointing, safety, voice model download, money)
npm run build                           # bundle the sidecar into dist/
cd .. && ./build.sh dev                 # web files + sidecar + debug `cargo build`
./build.sh                              # release bundle for this OS (signs on macOS if a Developer ID is in the keychain)
```

There is no linter configured yet.

Releases: push a `v*` tag (or run `.github/workflows/release.yml` by hand). It builds a signed, notarized
macOS DMG (Apple silicon and Intel), an unsigned Windows installer and the Linux beta (AppImage, .deb, .rpm, built on
Ubuntu 24.04 because ONNX Runtime needs glibc 2.38) into a draft GitHub release. The Linux leg may fail without
stopping the release; `latest.json` lists Linux only when its AppImage is there.

## Rules

- Every tool that touches files, commands, URLs or other apps goes through `showcase/tauri/sidecar/safety.mjs`
  (tested in `test/safety.test.mjs`); the hands helpers also refuse to type or click in the apps in `HANDS_OFF`
  (by bundle id in `hands/main.swift`, by program name in `hands-win/src/logic.rs`).
  Add a test case with every rule change.
- In-app updates read `latest.json` from the newest published release of `FORK_REPO` (none while it's empty; the
  feeds are built in `update_endpoints`, `plugins.updater.endpoints` stays empty), signed with the key in the
  `TAURI_SIGNING_PRIVATE_KEY` secret. Keep `plugins.updater.pubkey` in `tauri.conf.json` matching it (it is still
  upstream's until the fork has its own key).
  When GitHub's release links fail, the updater falls back to the copy on the `updates` branch, which
  `.github/workflows/update-feed.yml` writes whenever a release is published; downloads go through the API.

- CI lives in `.github/workflows/ci.yml` and must stay green.
- Never commit with `--no-verify`.
- Never commit experiments (prototypes, test pages, design tools). They stay local and are listed in `.git/info/exclude`; check `git status` before every commit.
- Never commit secrets (Apple ID passwords, certificates, `~/.gg/auth.json`); signing credentials go in GitHub Actions secrets.
