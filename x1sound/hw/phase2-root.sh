#!/usr/bin/env bash
# x1sound fase 2 (root): ruta de fábrica X1 (woofers en su propio DAC con techo) + Rust para la fase 4.
# Deshacer: hw/phase2-rollback.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Ejecuta con sudo"; exit 1; }

# 1. Rust (fase 4: el controlador se compila sin crates externos)
pacman -S --needed --noconfirm rust

# 2. Techo conservador de los woofers en cuanto aparece la tarjeta (DAC2 = 50 = -27.75 dB), antes de cualquier sonido
cat > /etc/udev/rules.d/89-x1c9-dac2.rules <<'R'
# x1sound: los woofers (DAC 0x03, 'DAC2 Playback Volume') arrancan con techo conservador
ACTION=="add", SUBSYSTEM=="sound", KERNEL=="controlC0", RUN+="/usr/bin/amixer -c0 -q cset name='DAC2 Playback Volume' 50"
R

# 3. Quitar el fixup forzado (yoga9): el kernel aplicará el de fábrica por pin-match (X1 Gen7: woofers en DAC 0x03)
[ -f /etc/modprobe.d/x1c9-audio.conf ] && mv /etc/modprobe.d/x1c9-audio.conf /etc/modprobe.d/x1c9-audio.conf.off

# 4. Primer arranque en silencio: mute de woofers y del master (alsa-restore lo guarda al apagar);
#    el asistente comprueba la ruta y los techos antes de devolver el sonido
amixer -c0 -q sset 'Bass Speaker' off || true
amixer -c0 -q sset Master mute || true
alsactl store

echo
echo "Listo. Desenchufa los auriculares y reinicia:  systemctl reboot"
echo "Al volver NO toques el volumen todavía: el sonido estará silenciado a propósito hasta que el asistente compruebe todo."
