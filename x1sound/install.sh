#!/usr/bin/env bash
# x1sound: instalación de usuario (sin sudo). La parte de root (ruta del codec, udev, Rust) está en hw/phase2-root.sh.
# Requiere el .irs de la corrección Dolby en ~/.local/share/x1sound/ir/dolby-balanced.irs (README → Desarrollo).
set -euo pipefail
cd "$(dirname "$0")"
cargo test --offline -q
cargo build --release --offline -q
install -Dm755 target/release/x1sound ~/.local/bin/x1sound
install -Dm644 wireplumber/51-x1c9-softmixer.conf ~/.config/wireplumber/wireplumber.conf.d/51-x1c9-softmixer.conf
# the chain names the IR by absolute path (generated on the author's machine): point it at this $HOME
install -d ~/.config/pipewire/pipewire.conf.d
sed "s#/home/sajra/#$HOME/#g" pipewire/x1sound.conf >~/.config/pipewire/pipewire.conf.d/x1sound.conf
install -Dm644 systemd/x1sound.service ~/.config/systemd/user/x1sound.service
install -Dm644 systemd/x1sound-clamp.service ~/.config/systemd/user/x1sound-clamp.service
# The SPEAKERS panel (glyph/Speakers.qml, glyph/EqBand.qml) already ships in sajra-rice's glyph config: nothing to copy
[ -f ~/.local/share/x1sound/ir/dolby-balanced.irs ] || echo "AVISO: falta ~/.local/share/x1sound/ir/dolby-balanced.irs: la cadena no cargará"
systemctl --user daemon-reload
systemctl --user enable x1sound-clamp.service
systemctl --user restart pipewire pipewire-pulse wireplumber
systemctl --user enable --now x1sound.service
x1sound doctor
