#!/usr/bin/env bash
# x1sound: instalación de usuario (sin sudo). La parte de root (ruta del codec, udev, Rust) está en hw/phase2-root.sh.
# Requiere el .irs de la corrección Dolby en ~/.local/share/x1sound/ir/dolby-balanced.irs (README → Desarrollo).
set -euo pipefail
cd "$(dirname "$0")"
cargo test --offline -q
cargo build --release --offline -q
install -Dm755 target/release/x1sound ~/.local/bin/x1sound
install -Dm644 wireplumber/51-x1c9-softmixer.conf ~/.config/wireplumber/wireplumber.conf.d/51-x1c9-softmixer.conf
install -Dm644 pipewire/x1sound.conf ~/.config/pipewire/pipewire.conf.d/x1sound.conf
install -Dm644 systemd/x1sound.service ~/.config/systemd/user/x1sound.service
install -Dm644 systemd/x1sound-clamp.service ~/.config/systemd/user/x1sound-clamp.service
G=~/.local/share/glyph/config/quickshell/glyph/prefs
[ -d "$G" ] && install -Dm644 glyph/Speakers.qml "$G/Speakers.qml" && install -Dm644 glyph/EqBand.qml "$G/EqBand.qml"
[ -f ~/.local/share/x1sound/ir/dolby-balanced.irs ] || echo "AVISO: falta ~/.local/share/x1sound/ir/dolby-balanced.irs: la cadena no cargará"
systemctl --user daemon-reload
systemctl --user enable x1sound-clamp.service
systemctl --user restart pipewire pipewire-pulse wireplumber
systemctl --user enable --now x1sound.service
x1sound doctor
