# Third-party notices

Roamies is licensed under [AGPL-3.0](LICENSE). It builds on the components below, each under its own license.

| Component | How it's used | License |
| --------- | ------------- | ------- |
| [Tauri](https://tauri.app) 2 (`tauri`, `tauri-build`) and plugins `tauri-plugin-single-instance`, `tauri-plugin-updater` | desktop shell, see `showcase/tauri/src-tauri/Cargo.toml` | MIT OR Apache-2.0 |
| [Node.js](https://nodejs.org) v24.22.2 | bundled runtime for the sidecar (version in `showcase/tauri/sidecar/fetch-node.sh`) | MIT |
| [@kenkaiiii/gg-agent](https://github.com/KenKaiii/gg-framework), gg-ai, gg-core 5.95.0 | agent framework in the sidecar | AGPL-3.0-only |
| [zod](https://zod.dev) 4.6.7 | schema validation in the sidecar | MIT |
| [imapflow](https://github.com/postalsys/imapflow) 2.11.0, with libmime 5.6.4, libqp 3.0.1, libbase64 1.4.1, iconv-lite 0.7.3, encoding-japanese 2.5.0, socks 2.8.10, smart-buffer 4.2.0, ip-address 10.7.6, pino 10.3.1 and its parts (@pinojs/redact 0.4.0, atomic-sleep 1.0.0, on-exit-leak-free 2.1.2, pino-abstract-transport 3.0.0, pino-std-serializers 7.1.0, process-warning 5.1.1, quick-format-unescaped 4.0.4, real-require 0.2.0 and 1.0.0, safe-stable-stringify 2.5.0, sonic-boom 4.2.1, thread-stream 4.2.1), safer-buffer 2.1.2; split2 4.2.0 | reads bank mails over IMAP (Money) in the sidecar | MIT; split2: ISC |
| [@zone-eu/mailsplit](https://github.com/zone-eu/mailsplit) 5.4.30 | splits mails into their parts, for imapflow and mailparser | MIT OR EUPL-1.1+ (used under MIT) |
| [mailparser](https://github.com/nodemailer/mailparser) 3.14.3, with he 1.2.0, html-to-text 10.0.1, linkify-it 5.0.2, uc.micro 2.1.0, tlds 1.261.0, punycode.js 2.3.1, htmlparser2 10.1.0, @selderee/plugin-htmlparser2 0.12.0, selderee 0.12.0, parseley 0.13.1, leac 0.7.0, peberminta 0.10.0 | turns a fetched mail into its headers, text and HTML (Money) | MIT |
| [nodemailer](https://github.com/nodemailer/nodemailer) 10.5.0 (used by mailparser for address parsing; nothing is sent) | sidecar | MIT-0 |
| domhandler 5.0.3, domutils 3.2.2, domelementtype 2.3.0, entities 4.5.0 and 7.0.1, dom-serializer 2.0.0, deepmerge-ts 8.0.2 | used by htmlparser2 and html-to-text | BSD-2-Clause; dom-serializer: MIT; deepmerge-ts: BSD-3-Clause |
| [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 0.3.318 | Claude sign-in support in the sidecar | Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." (not open source) |
| Claude Code | downloaded at sign-in with Claude, not bundled | Anthropic's terms |
| [Doto](https://github.com/oliverlalan/Doto) and [Martian Mono](https://github.com/evilmartians/mono) fonts | text in the app | SIL Open Font License 1.1, texts in `showcase/onboarding/fonts/` |
| [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [ONNX export by istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) | Windows speech model, downloaded at setup, not bundled | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [parakeet-rs](https://github.com/altunenes/parakeet-rs) 0.4.3 | runs the speech model in the Windows voice helper | MIT OR Apache-2.0 |
| [Piper](https://huggingface.co/rhasspy/piper-voices) voice `es_ES-sharvard-medium` (retrained, [piper-voices commit cf910fb](https://huggingface.co/rhasspy/piper-voices/tree/cf910fb59f1d79ab3b625a63993a108751c6c25d/es/es_ES/sharvard/medium)), speaker F | the local voice (Windows and Linux), downloaded on first use, not bundled; its config is a test fixture in `voice-win/fixtures/` | MIT: the voices repository states `license: mit` (its README at that commit); the voice's model card states only its data's licenses: the [Sharvard corpus](https://datashare.ed.ac.uk/handle/10283/574) ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)), and, through the hifi_tts_92 base model it was finetuned from, [Hi-Fi TTS](https://www.openslr.org/109/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Credits [below](#credits-for-the-local-voice) |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) 1.8 | how the local voice turns text into phonemes and ids and runs the voice, reproduced in `voice-win/src/speak.rs` | GPL-3.0-or-later |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng) (commit 724808c) | phonemizer of the local voice, built from source into the voice helper with its data (every language's dictionary, as Piper ships them) | GPL-3.0-or-later: "released under the GPL version 3 or later license" (its README; text in its `COPYING`) |
| Unicode Character Database 11.0.0, in eSpeak NG's `ucd-tools` | character data eSpeak NG reads text with, linked into the voice helper | Unicode-DFS-2016 (eSpeak NG's `COPYING.UCD`, notice [below](#unicode-data)); the `ucd-tools` code is GPL-3.0-or-later |
| [unicode-normalization](https://github.com/unicode-rs/unicode-normalization) 0.1.26 | splits the local voice's phonemes (NFD) in the voice helper | (MIT OR Apache-2.0) AND Unicode-3.0 |
| [tinyvec](https://github.com/Lokathor/tinyvec) 1.13.3 | used by unicode-normalization | Zlib OR Apache-2.0 OR MIT |
| [flate2](https://github.com/rust-lang/flate2-rs) 1.1.11 | unpacks eSpeak NG's data in the voice helper; when building, unpacks eSpeak NG's source and packs its data | MIT OR Apache-2.0 |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide) 0.9.1, [adler2](https://github.com/oyvindln/adler2) 2.0.1, [simd-adler32](https://github.com/mcountryman/simd-adler32) 0.3.10, [crc32fast](https://github.com/srijs/rust-crc32fast) 1.5.4 | used by flate2 | MIT OR Zlib OR Apache-2.0; 0BSD OR MIT OR Apache-2.0; MIT; MIT OR Apache-2.0 |
| [cmake](https://github.com/rust-lang/cmake-rs) 0.1.58 (build only) | builds eSpeak NG for the voice helper | MIT OR Apache-2.0 |
| [hmac-sha256](https://github.com/jedisct1/rust-hmac-sha256) 1.1.15 (build only) | checks eSpeak NG's source archive and stamps its packed data | ISC |

## Credits for the local voice

- Sharvard corpus, which its page asks to cite: Aubanel, Vincent; Garcia Lecumberri, Maria Luisa; Cooke, Martin.
  (2014). Sharvard_IJA, [sound]. LISTA Consortium: (i) Language and Speech Laboratory, Universidad del Pais Vasco,
  Spain and Ikerbasque, Spain; (ii) Centre for Speech Technology Research, University of Edinburgh, UK; (iii) KTH
  Royal Institute of Technology, Sweden; (iv) Institute of Computer Science, FORTH, Greece.
  https://doi.org/10.7488/ds/75. License: Creative Commons Attribution 3.0 Unported (CC BY 3.0).
- Hi-Fi Multi-Speaker English TTS Dataset (Hi-Fi TTS), NVIDIA Corporation, with the paper its page refers to:
  Bakhturina, E., Lavrukhin, V., Ginsburg, B. and Zhang, Y., 2021. Hi-Fi Multi-Speaker English TTS Dataset.
  arXiv:2104.01497. License: CC BY 4.0. The base model's voice is Cori Samuel, reader 92 of Hi-Fi TTS, from LibriVox
  public-domain audiobooks.
- Voice trained for Piper by the rhasspy/piper-voices project (model cards at the commit above).

## Unicode data

eSpeak NG's `COPYING.UCD`, for the Unicode Character Database data in the voice helper:

```text
COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2018 Unicode, Inc. All rights reserved.
Distributed under the Terms of Use in http://www.unicode.org/copyright.html.

Permission is hereby granted, free of charge, to any person obtaining
a copy of the Unicode data files and any associated documentation
(the "Data Files") or Unicode software and any associated documentation
(the "Software") to deal in the Data Files or Software
without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, and/or sell copies of
the Data Files or Software, and to permit persons to whom the Data Files
or Software are furnished to do so, provided that either
(a) this copyright and permission notice appear with all copies
of the Data Files or Software, or
(b) this copyright and permission notice appear in associated
Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT OF THIRD PARTY RIGHTS.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS
NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL
DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder
shall not be used in advertising or otherwise to promote the sale,
use or other dealings in these Data Files or Software without prior
written authorization of the copyright holder.
```

## Full dependency list

These are the main components. To see every dependency, including indirect ones:

```bash
cd showcase/tauri/sidecar && npm ls --all
cd showcase/tauri/src-tauri && cargo tree
cd showcase/tauri/src-tauri/voice-win && cargo tree
```
