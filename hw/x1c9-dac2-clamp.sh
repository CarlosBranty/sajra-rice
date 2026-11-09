#!/bin/sh
# x1sound: deja los DAC de los altavoces en sus valores calibrados (el volumen lo hace PipeWire por software).
#   DAC1 (tweeters, 0x14) = ~/.config/x1sound/tweeter_ceiling  (por defecto 87 = 0 dB)
#   DAC2 (woofers,  0x17) = ~/.config/x1sound/woofer_ceiling   (por defecto 80 = -5.25 dB)
# Máximo 87 (0 dB, lo mismo que la ruta anterior al 100 %). Sin controles DAC1/DAC2 (ruta yoga9): no hace nada.
val() { v=$(cat "$HOME/.config/x1sound/$1" 2>/dev/null); case "$v" in ''|*[!0-9]*) v=$2 ;; esac; [ "$v" -gt 87 ] && v=87; echo "$v"; }
set_dac() { amixer -c0 cget name="$1" >/dev/null 2>&1 && amixer -c0 -q cset name="$1" "$2"; }
set_dac 'DAC1 Playback Volume' "$(val tweeter_ceiling 87)"
set_dac 'DAC2 Playback Volume' "$(val woofer_ceiling 80)"
exit 0
