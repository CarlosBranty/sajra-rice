# Third-party notices

Roamies is licensed under [AGPL-3.0](LICENSE). It builds on the components below, each under its own license.

| Component | How it's used | License |
| --------- | ------------- | ------- |
| [Tauri](https://tauri.app) 2 (`tauri`, `tauri-build`) and plugins `tauri-plugin-single-instance`, `tauri-plugin-updater` | desktop shell, see `showcase/tauri/src-tauri/Cargo.toml` | MIT OR Apache-2.0 |
| [Node.js](https://nodejs.org) v24.22.2 | bundled runtime for the sidecar (version in `showcase/tauri/sidecar/fetch-node.sh`) | MIT |
| [@kenkaiiii/gg-agent](https://github.com/KenKaiii/gg-framework), gg-ai, gg-core 5.95.0 | agent framework in the sidecar | AGPL-3.0-only |
| [zod](https://zod.dev) 4.6.7 | schema validation in the sidecar | MIT |
| [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 0.3.318 | Claude sign-in support in the sidecar | Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." (not open source) |
| Claude Code | downloaded at sign-in with Claude, not bundled | Anthropic's terms |
| [Doto](https://github.com/oliverlalan/Doto) and [Martian Mono](https://github.com/evilmartians/mono) fonts | text in the app | SIL Open Font License 1.1, texts in `showcase/onboarding/fonts/` |
| [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [ONNX export by istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) | Windows speech model, downloaded at setup, not bundled | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [parakeet-rs](https://github.com/altunenes/parakeet-rs) 0.4.3 | runs the speech model in the Windows voice helper | MIT OR Apache-2.0 |
| [Piper](https://github.com/rhasspy/piper-voices) voice `es_ES-sharvard-medium` (retrained, [piper-voices commit cf910fb](https://huggingface.co/rhasspy/piper-voices/tree/cf910fb59f1d79ab3b625a63993a108751c6c25d/es/es_ES/sharvard/medium)), speaker F | the local voice (Windows and Linux), downloaded on first use, not bundled; its config is a test fixture in `voice-win/fixtures/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): finetuned from the hifi_tts_92 base model, trained on [Hi-Fi TTS](https://www.openslr.org/109/) (CC BY 4.0), on the [Sharvard corpus](https://datashare.ed.ac.uk/handle/10283/574) ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)) |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) 1.8 | how the local voice turns text into phonemes and ids and runs the voice, reproduced in `voice-win/src/speak.rs` | GPL-3.0-or-later |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng) (commit 724808c) | phonemizer of the local voice, built from source into the voice helper with its Spanish data | GPL-3.0-or-later |
| [unicode-normalization](https://github.com/unicode-rs/unicode-normalization) 0.1.26 | splits the local voice's phonemes (NFD) in the voice helper | (MIT OR Apache-2.0) AND Unicode-3.0 |
| [tinyvec](https://github.com/Lokathor/tinyvec) 1.13.3 | used by unicode-normalization | Zlib OR Apache-2.0 OR MIT |
| [cmake](https://github.com/rust-lang/cmake-rs) 0.1.58 (build only) | builds eSpeak NG for the voice helper | MIT OR Apache-2.0 |

## Full dependency list

These are the main components. To see every dependency, including indirect ones:

```bash
cd showcase/tauri/sidecar && npm ls --all
cd showcase/tauri/src-tauri && cargo tree
cd showcase/tauri/src-tauri/voice-win && cargo tree
```
