# x1sound

Controlador de altavoces estilo Dolby para el **ThinkPad X1 Carbon Gen 9** (Realtek ALC287, 17aa:22d5) sobre PipeWire.
Plan completo y razonamiento: [`docs/plan.md`](docs/plan.md).

## Qué hay instalado

| Pieza | Dónde | Qué hace |
|---|---|---|
| Ruta de fábrica del codec | `/etc/modprobe.d/x1c9-audio.conf.off` (desactivado) | tweeters (0x14) en DAC 0x02 = `DAC1`, woofers (0x17) en DAC 0x03 = `DAC2`; nunca el 0x06 sin volumen |
| Volumen por software | `~/.config/wireplumber/wireplumber.conf.d/51-x1c9-softmixer.conf` | el volumen no mueve los DAC: el balance arriba/abajo no cambia |
| Cadena DSP | `~/.config/pipewire/pipewire.conf.d/x1sound.conf` (generada con `tools/render_conf.py`) | corrección Dolby de Lenovo (FIR) → graves → agudos → voz → **EQ 8 bandas** (125 Hz…16 kHz, ±6 dB) → EQ Dolby (HP 100 Hz) → regulador por bandas → limitador −1 dBFS |
| Controlador | `~/.local/bin/x1sound`, `x1sound.service` | perfiles, graves/agudos, ganancia, loudness según el volumen, DAC1/DAC2 |
| DAC al iniciar sesión | `x1sound-clamp.service` | `x1sound clamp` antes de PipeWire |
| Techo al arrancar la tarjeta | `/etc/udev/rules.d/89-x1c9-dac2.rules` | DAC2 = 50 hasta que `x1sound clamp` aplique la config |
| Panel | glyph → Prefs → **SPEAKERS** (`glyph/Speakers.qml`, `glyph/EqBand.qml`; ver `glyph/README.md`) | perfiles, ruedas, presets y EQ; edita `~/.config/x1sound/config.json` |
| Presets de EQ | `~/.config/x1sound/eq-presets.json` | `x1sound eq list` / `x1sound eq rock`; se pueden añadir propios |

## Uso

```sh
x1sound status            # estado del daemon y config
x1sound profile music     # dynamic | music | voice | off
x1sound set bass_db 7     # bass_db treble_db boost_db loudness loudness_amount tweeter woofer enabled
x1sound set eq 0,0,-2,0,2,3,1,0   # ecualizador 125 250 500 1k 2k 4k 8k 16k (±6 dB); o una banda: x1sound set eq5 3
x1sound doctor            # autodiagnóstico
```

Perfiles (no son copias de Windows, que no publica sus deltas): **dynamic** = tu calibración; **music** = +3 dB de
graves y agudos (V); **voice** = +6 dB a 2,5 kHz, −6 dB de graves, +1 de agudos; **off** = sin corrección Dolby ni realces, con HP, regulador y
limitador activos. Loudness: por debajo de −10 dB de volumen suma graves (máx. +6) y la mitad en agudos.

**Ganancia:** medido con ruido rosa, hasta +10 dB sube el nivel sin comprimir (margen pico/RMS 14,9 dB); a +15 baja a
9,6 dB y a +18 a 8,3 dB (aplastado). Por eso el valor por defecto es +10: el volumen se pone con el control general.

Límites duros (en el código, no se saltan editando el JSON): graves −6…+12, agudos −6…+8, EQ ±6 por banda,
ganancia 0…+20 dB, DAC 40…87, suma de realces (graves+agudos+voz+banda EQ más alta) ≤ 14 dB. El limitador y el HP de 100 Hz no son escribibles.

## Instalar

`./install.sh` instala la parte de usuario (binario, cadena, servicios, panel). La de root: `sudo bash hw/phase2-root.sh`
(regla udev en `udev/`, quita el fixup yoga9 e instala Rust) y reiniciar.

## Desarrollo

```sh
cargo test --offline                     # 17 tests: JSON, límites, presupuesto en rejilla, rutas del codec…
cargo build --release --offline && install -m755 target/release/x1sound ~/.local/bin/
python3 -I tools/render_conf.py <Dolby_X.conf> ~/.local/share/x1sound/ir/dolby-balanced.irs pipewire/x1sound.conf 10   # 10 = g_in dB
```
Sin dependencias externas (solo `std`).

## Deshacer

```sh
systemctl --user disable --now x1sound x1sound-clamp
mv ~/.config/pipewire/pipewire.conf.d/x1sound.conf ~/.config/pipewire/disabled/
mv ~/.config/pipewire/disabled/Dolby_Balanced.conf ~/.config/pipewire/pipewire.conf.d/   # cadena anterior
systemctl --user restart pipewire pipewire-pulse wireplumber
sudo bash hw/phase2-rollback.sh && systemctl reboot                                        # ruta yoga9 anterior
```
Copias de seguridad: `~/x1sound-backup/`.
