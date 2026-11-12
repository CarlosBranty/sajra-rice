# AGENTS.md

Roamies: a Tauri 2 desktop app (Rust shell in `showcase/tauri/src-tauri`), a Node sidecar that runs the
agent (`showcase/tauri/sidecar`), shared browser JS in `showcase/roamies`, macOS Swift helpers built by
`src-tauri/build.rs`, and two Windows helpers built by `build.sh` for Windows targets: voice
(`src-tauri/voice-win`, Rust + Parakeet; `--transcribe <wav>` and `--test-audio <wav>` test speech without a
Windows PC, see the top of its `main.rs`) and hands (`src-tauri/hands-win`, the twin of `hands/main.swift`: same
commands and JSON, over Win32, UI Automation and Windows OCR). Only hands-win's `logic.rs` builds off Windows, so
`cargo test` there runs its checks anywhere; `roamies-hands --smoke` drives Notepad on a real Windows desktop (CI).
From a Mac, `cargo xwin check --target x86_64-pc-windows-msvc` type-checks the Windows code with the real SDK.

Linux (beta) uses the same voice helper (`voice-win` builds for Linux too: ALSA mic, talk keys over X11, and a
`toggle` command for `roamies --talk` on Wayland) and no hands helper. Its shell code is `src-tauri/src/linux.rs`,
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
screenshot handed to the agent there, with its pixels and bounds in a `.json` beside it (`roamies --shot` takes one
without asking the agent anything; they show your screen, so delete them after).
`ROAMIES_LATENCY=1` (any build) times each spoken question on the wall clock: the Windows and Linux voice helper sends
when the voice stopped, the take closed (and why) and its words were ready with the words, the
sidecar adds the request, first token, first sentence to the voice and first Fish audio, and the page when that audio
starts playing (`voice-out.js`); `~/.gg/sidekick.log` gets one `[latency]` line per stage and a summary with the gaps
(`sidecar/latency.mjs`). Debug builds: `ROAMIES_FISH_MODEL=s2.1-pro` (or `drama-3`) voices that run without changing
the saved setting (an account with no credit stays on the free tier either way).

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
in a child process with row and time limits (`money/query.mjs`). Banks are data, one JSON per bank in `sidecar/banks/`
(bundled in), and users add or replace them with the same JSON in `<data dir>/banks/` (`otherLabels`: the layout's
labels that are not read, so an empty value never runs into the next row). Own-account transfers and refused purchases
(`own_transfer`, `rejected`) are stored as `ignored`; summaries leave out every `NOT_SPENDING` kind. Test fixtures are
synthetic: copy a real mail's markup, never its names, account numbers or amounts.
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
- In-app updates read `latest.json` from the newest published release, signed with the key in the
  `TAURI_SIGNING_PRIVATE_KEY` secret. Keep `plugins.updater.pubkey` in `tauri.conf.json` matching it.
  When GitHub's release links fail, the updater falls back to the copy on the `updates` branch, which
  `.github/workflows/update-feed.yml` writes whenever a release is published; downloads go through the API.

- CI lives in `.github/workflows/ci.yml` and must stay green.
- Never commit with `--no-verify`.
- Never commit experiments (prototypes, test pages, design tools). They stay local and are listed in `.git/info/exclude`; check `git status` before every commit.
- Never commit secrets (Apple ID passwords, certificates, `~/.gg/auth.json`); signing credentials go in GitHub Actions secrets.
