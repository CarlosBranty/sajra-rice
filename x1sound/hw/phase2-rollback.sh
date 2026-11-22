#!/usr/bin/env bash
# x1sound: volver a la ruta yoga9 (antes de la fase 2). Requiere reiniciar después.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Ejecuta con sudo"; exit 1; }
U=${SUDO_USER:-sajra}; H=$(getent passwd "$U" | cut -d: -f6)
amixer -c0 -q sset 'Bass Speaker' off || true
amixer -c0 -q sset Master mute || true
rm -f /etc/udev/rules.d/89-x1c9-dac2.rules
[ -f /etc/modprobe.d/x1c9-audio.conf.off ] && mv /etc/modprobe.d/x1c9-audio.conf.off /etc/modprobe.d/x1c9-audio.conf
mv -f "$H/.config/wireplumber/wireplumber.conf.d/51-x1c9-softmixer.conf" "$H/x1sound-backup/" 2>/dev/null || true
sudo -u "$U" XDG_RUNTIME_DIR=/run/user/$(id -u "$U") systemctl --user disable x1c9-dac2-clamp.service 2>/dev/null || true
alsactl store
echo "Hecho. Reinicia; al volver, el asistente restaura el mixer desde ~/x1sound-backup/LATEST."
