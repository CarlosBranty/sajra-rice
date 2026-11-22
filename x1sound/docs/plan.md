# Plan final: `x1sound`, un controlador de altavoces estilo Dolby para el ThinkPad X1 Carbon Gen 9 (17aa:22d5)

> **Convenciones**
> - **[U]**: lo ejecutas tú con `!`. Incluye todo lo que necesita `sudo`, los reinicios, la herramienta Python externa (`~/Projects/speaker-tuning-to-easyeffects`), las escrituras de prueba con `pw-cli`/`pw-metadata`/`amixer` en los gates y las escuchas.
> - **[A]**: lo hace el asistente. Escribe código y configuración en `~/Projects/x1sound`, `~/.config/x1sound`, `~/.config/pipewire|wireplumber|systemd/user` y en el árbol de glyph. Compila con cargo un proyecto **sin dependencias externas**; si el clasificador lo bloquea, compilas tú. También hace comprobaciones de solo lectura y ejecuta sus propias herramientas de análisis (Python solo stdlib con `python3 -I`, y más adelante Rust).
> - **Gx.y**: un gate, es decir, una comprobación con criterio de paso o fallo. Se registra con `x1sound gate pass|fail Gx.y` solo después de que tú confirmes el resultado. Hasta la Fase 4 se registra en `docs/gates.md`. Toda función que dependa de algo **NO VERIFICADO** queda desactivada hasta que su gate pase.
> - **Etiquetas de fidelidad** (en la config y en la UI):
>   - `dax`: está en el XML de Windows.
>   - `realtek`: lo hace la capa de Windows que hay debajo de Dolby (deducido).
>   - `extra`: no existe en Windows; va desactivado por defecto.
> - **Regla de oro del mixer:** nunca se cambia `Master` ni `DAC1` con `amixer` mientras suena audio. `DAC2` solo se toca en pasos de 3 o menos y siempre por debajo de su techo.

---

## 1. Resumen ejecutivo

**Qué va a mejorar de forma audible, de más a menos impacto:**

1. **Hoy la cadena Dolby se aplica dos veces.** `Dolby_Balanced.conf` y `Dolby_Detailed.conf` funcionan en serie. Eso suma:
   - 2 FIR, con unos 32 dB de inclinación entre medios-graves y medios;
   - un high-pass que en la práctica es de 8.º orden;
   - 2 reguladores con +6 y +16,2 dB de ganancia de entrada;
   - 2 limitadores.

   El resultado es un sonido encajonado y con bombeo. Quitar uno cuesta 15 minutos y probablemente sea la mayor parte de la diferencia con Windows.
2. **Equilibrio real entre tweeters y woofers.** Se quita la línea `hda_model=alc287-yoga9-bass-spk-pin`. Así el kernel aplica el fixup de fábrica por pin-match. Según el código fuente es `ALC285_FIXUP_THINKPAD_HEADSET_JACK → X1_GEN7`, pero esto es deducido: el log no lo nombrará porque `CONFIG_SND_DEBUG_VERBOSE` está desactivado. Ese fixup hace lo siguiente:
   - tweeters (0x14) en DAC 0x02, con el control **`DAC1 Playback Volume`**;
   - woofers (0x17) en DAC 0x03, con el control **`DAC2 Playback Volume`**, que funciona como **techo de los woofers** y como **balance**;
   - se mantienen los interruptores `Speaker`, `Bass Speaker` y `Headphone`.

   Los nombres se deducen del código (`rename_ctl` en `alc285_fixup_thinkpad_x1_gen7` y `get_line_out_pfx`) y se confirman tras el reinicio. El volumen pasa a ser **software** (`api.alsa.soft-mixer`) y los controles hardware quedan fijos en sus techos. Así el balance no cambia con el volumen. Esto ataca directamente tu queja de que los tweeters casi no se oyen. De paso recuperas el LED de mute del ThinkPad y el fixup del jack de auriculares.
3. **Un único controlador** (`x1sound`, en Rust, sin crates externos) que añade lo que una conf estática no puede hacer:
   - regulador acoplado al volumen, para que comprima menos a volumen bajo (`dax`, no verificado en DAX3, dentro del budget);
   - perfiles de Windows sin recargar nada (dynamic, music, voice y **off**, este último dentro del grafo y con las protecciones activas);
   - boost (volmax);
   - deslizador de balance;
   - loudness opcional (`extra`);
   - teclas de volumen que aplican la protección **antes** de subir;
   - autodiagnóstico (`doctor`);
   - un panel **Speakers** en la sección AUDIO de las preferencias de glyph.

**Qué no se puede reproducir y por qué:**

- **"Media Intelligence" de Dolby.** Es el análisis de contenido que guía el leveler, el dialog enhancer y el IEQ adaptativo. Es propietario y no hay datos suficientes para copiarlo con fidelidad.
  - Un leveler ciego al contenido ya se descartó en HDA (#25/#137): realzaba ~14 dB el fondo y metía picos al empezar el sonido. Aquí queda como fase opcional, protegida por un gate de medida con herramienta propia.
  - La supresión de lo que no es voz que hace el dialog enhancer no se puede reproducir.
- **El crossover de Windows: no existe en Dolby.** El XML de este portátil declara `total_count="2" has_subwoofer="0"` y `woofer-regulator-enable=0`. Si Windows separa tweeters y woofers, lo hace la capa Realtek, y eso NO está verificado porque el paquete extraído no incluye `RTAIODAT.DAT`. Lo que sí podemos copiar es el reparto de DACs (punto 2).
- **Un crossover real de 2 vías no es posible con la pila actual.**
  - El PCM analógico de SOF está fijado a 2 canales: el "4ch" del topology se refiere a los 4 micrófonos DMIC.
  - **Verificado en esta sesión:** el round-trip `alsatplg -d`/`-c` del topology **no es limpio**. Pierde los `min` de las escalas dB de volumen, así que no se puede editar el `.conf` descompilado y recompilarlo sin más.
  - Solo queda una vía experimental (Fase 7, con parche binario mínimo o con fuentes de topology). Si llegara a funcionar, iría **más allá de Windows**, no sería una copia.
- **Virtualizador, surround y Atmos.** Sobre contenido estéreo no aportan nada medible (+0,01 dB en las capturas del repo). Copiarlos sería inventar.

---

## 2. Fase 0: gate de viabilidad (solo lectura, riesgo mínimo, unos 30 min)

**Objetivo.** Antes de tocar nada, decidir si un crossover real tweeter/woofer es **imposible**, **candidato experimental** o **directamente posible**, y crear la copia de seguridad base. Esta fase no escribe nada en el sistema; solo usa tu `$HOME`.

### 0.0 Hechos ya verificados en la sesión (solo lectura)
- El kernel carga **IPC3** y `intel/sof-tplg/sof-hda-generic-4ch.tplg`.
- `alsatplg` 1.2.16: el round-trip **no es limpio**.
  - Recompilar pierde `min 0xffffe700` (−64 dB, 6 veces) y `min 0xffffec78` (−50 dB, 3 veces) en las 9 `SectionTLV`, incluida la de `1 Master Playback Volume` de PGA1.0.
  - El binario pasa de 44383 a 43915 bytes.
  - Aunque se reescriban los `min` en decimal (−6400/−5000) y el diff de texto salga vacío, siguen faltando 468 bytes.
  - Salida en `/tmp/claude-1000/-home-sajra/0426162f-a89c-458a-9e2e-9b69591f8317/scratchpad/rt/`.
- `CONFIG_SND_DEBUG_VERBOSE` está desactivado, así que el log de fixup por pin-match no muestra el nombre.
- `Master` = 87 (0 dB). PipeWire/ACP pone toda la atenuación en `Speaker` (58 = −21,75 dB con wpctl a 0,42).
- `Auto-Mute Mode` = Disabled, forzado por el `BootSequence` de UCM `HDA/init.conf`. Los altavoces se silencian al enchufar auriculares solo por el cambio de ruta de UCM.
- `/var/lib/alsa/asound.state` no tiene `DAC1`/`DAC2`. `alsa-restore.service` hace `restore` al arrancar y `alsactl store` en `ExecStop` (guarda lo que haya al apagar).
- Las teclas de volumen hacen `wpctl set-mute … 0` (`~/.config/hypr/hyprland/keybinds.lua:173,180`, con `-l 1.0`). `Sys.qml:32-33` pone `muted=false` y limita a 1,0. Tocar el volumen **quita el mute**, y el volumen real llega a **1,0**.
- `dolby_to_pipewire.py` escribe por defecto en `~/.config/pipewire/pipewire.conf.d` (`lib/pipewire/checks.py:83`) y reinicia PipeWire salvo que se pase `--no-activate` (líneas 146–151).

### 0.1 Copia de seguridad con fecha [U] (sin sudo)
```bash
B=~/x1sound-backup/$(date +%Y%m%d-%H%M); mkdir -p "$B"
cp -a ~/.config/pipewire/pipewire.conf.d "$B/"
cp -a ~/.config/wireplumber "$B/" 2>/dev/null
cp -a ~/.local/state/wireplumber "$B/wp-state" 2>/dev/null       # rutas, volúmenes, mutes y perfiles guardados
cp /var/lib/alsa/asound.state "$B/system-asound.state"            # el que se restaura de verdad al arrancar
amixer -c0 contents > "$B/amixer.txt"
cp /proc/asound/card0/codec#0 "$B/codec0.txt"
cp /etc/modprobe.d/x1c9-audio.conf "$B/" 2>/dev/null
alsactl -f "$B/asound.state" store 2>/dev/null || echo "alsactl store (user) falló; no bloquea"
echo "$B" > ~/x1sound-backup/LATEST
```
Las fases 1, 2, 3 y 7 repiten este bloque en un directorio nuevo antes de cambiar nada.

### 0.2 Comprobaciones de solo lectura [U] o [A]
```bash
S=~/sof-quad; mkdir -p "$S"
# (a) Ruta actual del codec
journalctl -k -b | grep -E 'ALC287: picked fixup|line_outs|hp_outs'
for n in 0x14 0x17 0x21; do echo "== $n"; grep -A22 "Node $n" /proc/asound/card0/codec#0 | grep -E 'Pin Default|Connection|0x0[2368]'; done
grep -A6 'Node 0x06' /proc/asound/card0/codec#0          # confirmar: sin Amp-Out (sin volumen)
cat /sys/class/sound/hwC0D0/init_pin_configs              # debe coincidir con el pin-quirk X1 Gen7:
#   0x14 0x90170110 · 0x17 0x90170111 · 0x19 0x03a11030 · 0x21 0x03211020
# (b) Topology e IPC (ya verificado: IPC3, intel/sof-tplg/sof-hda-generic-4ch.tplg); se registra igualmente
journalctl -k -b | grep -iE 'tplg|topology|ipc' | head -20
# (c) Canales del PCM analógico, en el driver y en el topology
cat /proc/asound/card0/pcm0p/info
pw-cli enum-params "$(pw-dump | jq '.[]|select(.info.props["node.name"]? and (.info.props["node.name"]|test("HiFi__Speaker__sink")))|.id')" EnumFormat | grep -A3 -i channels
T=/lib/firmware/intel/sof-tplg/sof-hda-generic-4ch.tplg
alsatplg -d "$T" -o "$S/orig.conf"
grep -n -A14 -E "'Playback (0|31)'" "$S/orig.conf" | grep -E "Playback|channels_(min|max)"
# (d) Round-trip: texto Y tamaño (ya se sabe que falla; se repite para dejarlo registrado)
alsatplg -c "$S/orig.conf" -o "$S/rt.tplg" && alsatplg -d "$S/rt.tplg" -o "$S/rt.conf"
diff <(grep -v '^#' "$S/orig.conf") <(grep -v '^#' "$S/rt.conf"); stat -c '%s %n' "$T" "$S/rt.tplg"
# (e) Permisos de mixer de usuario (ya verificado: user:sajra:rw-)
getfacl /dev/snd/controlC0 | grep sajra
# (f) Estado relevante para la seguridad
amixer -c0 sget 'Auto-Mute Mode'; grep -nE 'DAC|Bass Speaker' /var/lib/alsa/asound.state
systemctl cat alsa-restore.service | grep -E '^Exec'
```

### 0.3 Decisión: rama que sigue el plan

| Resultado | Condición | Rama |
|---|---|---|
| **D0-A** | `init_pin_configs` coincide con el pin-quirk **y** 0x17 lista `0x02 0x03` | La ruta dividida (Fase 2) está disponible. Es lo esperado. Si no se cumple, se prueba el fallback B (`alc245-fixup-bass-hp-dac`) con la secuencia completa de la Fase 2. Si tampoco funciona, el plan sigue en **rama E** sin balance hardware. |
| **D0-B** | `Playback 0` tiene `channels_max 2` (lo esperado) | Con la pila actual el crossover es **imposible**. Solo puede hacerse con un topology propio (Fase 7). |
| **D0-B'** | `channels_max ≥ 4` (por ejemplo, si una actualización de sof-firmware lo cambia) | En la Fase 7 se salta la modificación del topology. Basta con la ruta A más el perfil Pro Audio. |
| **D0-C-limpio** | Diff de texto vacío **y** binarios del mismo tamaño | La ruta C se puede construir descompilando. **No es el caso hoy.** |
| **D0-C-sucio** | Compila, pero el diff no está vacío o el tamaño cambia | **Resultado verificado hoy.** La ruta C no es viable sin trabajo adicional. La Fase 7 solo puede seguir por (iii) parche binario mínimo sobre el `.tplg` original, (i) `.conf` con todos los `min` de TLV en decimal con signo, diff vacío **y** la diferencia de tamaño explicada sección por sección, o (ii) compilar desde las fuentes topology1 de SOF. Sea cual sea, debe pasar G7.0 y G7.1. |
| **D0-C'** | `alsatplg` falta o falla | La ruta C no es viable. El crossover solo sería posible con el driver legacy (ruta D), que **pierde los micrófonos internos**. Se marca "no viable" y la Fase 7 se cierra salvo que aceptes explícitamente esa pérdida. |

**Ramas:**
- **Rama E (estéreo y balance hardware).** Se ejecuta **siempre**: Fases 1 a 6 (y la 8 si quieres).
- **Rama X (crossover).** Solo si G2.9 dice "seguir", D0-C-sucio tiene una vía (iii/i/ii) preparada y, después de la Fase 5, sigues queriendo más que el balance. Requiere pasar todos los gates de la Fase 7.

> Aviso honesto: ninguna prueba de solo lectura puede confirmar que los canales sean realmente independientes. Lo de "copy-front" (los dos DACs reciben la misma señal estéreo) solo se descarta con el test G7.3, que necesita reiniciar.

**Aceptación.** El backup existe y D0-A/B/C quedan anotados en `~/Projects/x1sound/docs/gates.md`.

**Rollback.** No hace falta: no se ha cambiado nada (`~/sof-quad` es inerte).

---

## 3. Fases

### Fase 1: quitar la cadena duplicada y fijar una base de escucha [U], unos 45 min más la escucha

**Objetivo.** Que haya exactamente un filtro antes del Speaker sink, decidir a propósito la variante IEQ y level-restore, y tener una base honesta con la que comparar.

**Pasos [U]:**
```bash
mkdir -p ~/.config/pipewire/disabled ~/x1sound-staging
mv ~/.config/pipewire/pipewire.conf.d/Dolby_Detailed.{conf,irs} ~/.config/pipewire/disabled/
systemctl --user restart pipewire pipewire-pulse wireplumber
pw-link -l | grep -B1 -A2 effect_output
wpctl status | sed -n '/Filters/,/Streams/p'
```

**Regla del conversor (vale para todo el plan).** `dolby_to_pipewire.py` se ejecuta **siempre** con `--output-dir ~/x1sound-staging/<variante> --no-activate`. Sin eso escribe en `conf.d` y reinicia PipeWire por su cuenta, y se vuelve a crear la cadena doble. Después tú copias **un solo** archivo a `conf.d`. `doctor` repite esta instrucción en su mensaje de remedio.

**Dos decisiones separadas, en orden.** Se anotan las dos en `$B/NOTES` con el comando exacto.
1. **Variante IEQ: Balanced o Detailed.** Las dos se generan **sin** level-restore. Cambian el IR del IEQ (`.irs`), no solo la ganancia.
2. **Level-restore: sí o no**, solo con la variante ganadora.
   - La investigación indica que la conf con level-restore (+16,2 dB) era Detailed, no Balanced; las notas de la sesión lo tenían al revés.
   - **Si level-restore gana**, se modela en la Fase 3 como una etapa propia `makeup_db`, separada del boost. Antes de la Fase 4 se redefine S5 sobre la **ganancia neta** medida (FIR + makeup + boost + …) y se repite la comprobación a volumen 1,0 (G4.8). No se recorta en silencio lo que elegiste.
   - Si no gana, la v1 va sin level-restore y así se registra.

Las variantes se generan así:
```bash
cd ~/Projects/speaker-tuning-to-easyeffects
python3 dolby_to_pipewire.py <tus argumentos; variante según --help> --output-dir ~/x1sound-staging/<variante>-nolr --no-activate --force
# con level-restore (solo la ganadora):
python3 dolby_to_pipewire.py <…> --enable level-restore --output-dir ~/x1sound-staging/<variante>-lr --no-activate --force
```
En cada A/B: se mueve a `disabled/` la conf que hay en `conf.d`, se copia **una** de staging y se reinicia PipeWire. **Nunca cargues dos.**

**Igualar el nivel con una medida, no a ojo.**
- [A] escribe `~/Projects/x1sound/tools/levelcmp.py` (código propio, solo stdlib, `python3 -I`). Calcula el RMS y la diferencia en dB entre dos WAV, alineados por correlación.
- [U] graba el monitor del sink con los altavoces silenciados por hardware. NO VERIFICADO: que el monitor sea pre-volumen y no dependa del mute hardware; se comprueba en la primera grabación.
  ```bash
  amixer -c0 sset Master mute
  pw-record --target <node.name del Speaker sink> -P '{ stream.capture.sink = true }' ~/x1sound-staging/<variante>.wav &
  pw-play ~/Projects/x1sound/testdata/ref.wav; kill %1
  amixer -c0 sset Master unmute
  ```
- [A] ejecuta `levelcmp.py a.wav b.wav` y te da el desfase.
- En hardware-volume (Fase 1), el volumen igualado es `vol_b = vol_a · 10^(Δ dB/60)`.

**Protocolo de escucha (vale para todo el plan):**
- empezar con `wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.20`;
- subir en pasos de 0,05;
- tope en las pruebas generales: **0,80**. La **única** excepción es la comprobación final de distorsión de la calibración (Fase 2, G4.8), que sube de 0,80 a **1,00** en pasos de 0,05, porque las teclas y glyph llegan a 1,0;
- material: 2 o 3 pistas de referencia, una de ellas con mucho grave, y ruido rosa a −30 dBFS;
- parar en cuanto haya zumbido, vibración o distorsión;
- no cambiar `Master` ni `DAC1`/`Speaker` con `amixer` mientras suena audio.

**Registro.** [A] crea `~/Projects/x1sound/docs/listening-log.md`. [U] anota volumen, balance arriba/abajo, encajonamiento, claridad de la voz y las dos decisiones. Esta es la **base B1**, solo con el routing yoga9; la base de comparación de la Fase 3 es la **B2**, que se graba tras la Fase 2.

**Aceptación:**
- La conf que conservas es el único filtro y `effect_output` enlaza directamente al sink.
- `NOTES` contiene `ieq=…`, `level_restore=…` y el comando exacto.
- El registro de escucha está completo.

**Rollback.** Devolver los archivos desde `disabled/` y reiniciar PipeWire.

---

### Fase 2: ruta A, woofers en su propio DAC con techo hardware y volumen software [U], unas 2–2,5 h con un reinicio

**Objetivo:**
- 0x14 (tweeters) en DAC 0x02, con `DAC1 Playback Volume` fijo en `tweeter_ceiling`;
- 0x17 (woofers) en DAC 0x03, con `DAC2 Playback Volume` fijo en `woofer_ceiling`, que hace de techo y de balance;
- el volumen en **software** (soft-mixer), así que no se mueve ningún DAC al cambiar el volumen.

Los nombres de los controles se deducen del código hasta que el listado R1 los confirme.

**Pre-gate:**
- Fase 1 hecha, D0-A cumplido y backup nuevo.
- Aceptas el compromiso de los auriculares: en la ruta A comparten DAC 0x03 con los woofers. Su nivel máximo queda limitado por el techo de los woofers (≈ −28 dB con DAC2=50) y no tendrán `Headphone Playback Volume`. Si se quedan cortos, la única salida es el rollback.

**Antes del reinicio, [A] escribe:**
- `~/.config/wireplumber/wireplumber.conf.d/51-x1c9-softmixer.conf`:
  ```
  monitor.alsa.rules = [
    { matches = [ { device.name = "~alsa_card.pci-0000_00_1f.3.*" } ]
      actions = { update-props = { api.alsa.soft-mixer = true } } }
  ]
  ```
  Así el sistema arranca directamente con volumen software. NO VERIFICADO: que la propiedad se aplique con este `match`, y que ACP no toque los elementos hardware en ese modo. Ambas cosas se comprueban en G2.3.
- `~/Projects/x1sound/hw/x1c9-dac2-clamp.sh` y `~/.config/systemd/user/x1c9-dac2-clamp.service` (oneshot, `Before=pipewire.service wireplumber.service`, `WantedBy=default.target`, sin depender del daemon). Lee `~/.config/x1sound/woofer_ceiling` (un entero; si falta o no es válido usa **50**; nunca más de **70**). Si `DAC2` está por encima, lo **baja**; nunca lo sube. En la Fase 4 se sustituye por `x1sound clamp`.

**Antes del reinicio, [U]:**
```bash
# 1. Desenchufa los auriculares.
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.15        # primero bajar…
wpctl set-mute   @DEFAULT_AUDIO_SINK@ 1           # …después silenciar
amixer -c0 sset 'Bass Speaker' off                # mute ALSA de los woofers (alsa-restore lo guarda al apagar)
amixer -c0 sset Master mute                       # mute ALSA del vmaster
# 2. Backup nuevo (bloque 0.1)
systemctl --user enable x1c9-dac2-clamp.service
# 3. (Opcional, recomendado) fijar DAC2 al añadir la tarjeta, antes de la sesión:
echo "ACTION==\"add\", SUBSYSTEM==\"sound\", KERNEL==\"controlC0\", RUN+=\"/usr/bin/amixer -c0 -q cset name='DAC2 Playback Volume' 50\"" | sudo tee /etc/udev/rules.d/89-x1c9-dac2.rules
sudo mv /etc/modprobe.d/x1c9-audio.conf /etc/modprobe.d/x1c9-audio.conf.off
systemctl reboot
```
- La regla udev pone 50 antes de que `alsa-restore` restaure un valor calibrado. Si el restore falla, se queda en 50. El orden no está verificado, pero es inocuo porque 50 es conservador.

**Después del reinicio, en este orden.** No toques las teclas de volumen ni el panel de glyph, porque quitan el mute. Si tu login lo permite, haz R1–R4 desde una TTY (Ctrl+Alt+F3) antes de entrar en Hyprland.

- **R1. Lectura.**
  ```bash
  amixer -c0 controls | grep -E 'DAC1|DAC2|Speaker|Headphone|Master|Auto-Mute'
  amixer -c0 cget name='DAC2 Playback Volume'      # anota en NOTES el valor por defecto real
  amixer -c0 sget Master; amixer -c0 sget 'Bass Speaker'
  systemctl --user status x1c9-dac2-clamp
  ```
  - Se espera ver volúmenes `DAC1`, `DAC2` y `Master`, e interruptores `Speaker`, `Bass Speaker` y `Headphone`.
  - Si los nombres no coinciden: **parar, no desmutear** y anotar. [A] adapta el plan.
- **R2. Mute ALSA.** Si ni `Master` ni `Bass Speaker` aparecen `[off]` (por ejemplo porque `alsactl restore` cayó en `alsactl init`), ejecuta `amixer -c0 sset 'Bass Speaker' off`.
- **G2.1 Fixup.** `journalctl -k -b | grep -E 'ALC287: picked fixup|line_outs'` debe mostrar `(pin match)`, con el nombre vacío porque no hay DEBUG_VERBOSE, y `line_outs=2 (0x14/0x17)`. El fixup se confirma por sus **efectos**: existen `DAC1`/`DAC2` (R1), 0x17 está conectado a `0x02 0x03*` (G2.2) y la lista ctl-led no está vacía (G2.6).
- **G2.2 Invariante de seguridad.** `grep -A20 'Node 0x17' /proc/asound/card0/codec#0` debe mostrar en la línea `Connection` **solo** `0x02 0x03`, con `0x03*` seleccionado.
  - Si 0x06 es alcanzable o está seleccionado: **parar y hacer rollback**.
- **R3. Fijar el techo de los woofers.** Si el clamp no lo hizo ya: `amixer -c0 cset name='DAC2 Playback Volume' 50` (−27,75 dB, con dB = (v−87)×0,75).
- **G2.0 El smart filter sigue enganchado.**
  - `wpctl status` y `pw-dump` deben mostrar el sink `…HiFi__Speaker__sink` con el **mismo** `node.name`.
  - `pw-link -l` debe mostrar `effect_output → Speaker sink`.
  - Si falla, no desmutear y hacer rollback. Sin filtro no hay HP4, regulador ni limitador.
- **G2.3 Volumen software.**
  - `wpctl inspect <id del device>` debe mostrar `api.alsa.soft-mixer = true`.
  - Con todo en silencio, poner `wpctl set-volume` a 0,2, 0,4, 0,6 y 0,8. En cada paso ejecutar `amixer -c0 sget Master; amixer -c0 cget name='DAC1 Playback Volume'; amixer -c0 cget name='DAC2 Playback Volume'`.
  - **Pasa** si ningún elemento hardware se mueve. Se registra qué elemento se movería sin soft-mixer: Master, DAC1 o ninguno.
  - **Falla** si se mueve `DAC1`: los woofers no seguirían el volumen y a volumen bajo sonarían graves fuertes. Si se mueve `Master`, falla igual, porque el soft-mixer no se aplicó. En ambos casos **no desmutear `Bass Speaker`**: [A] corrige el `match` y se repite.
- **R4. Fijar el hardware, en silencio:**
  ```bash
  amixer -c0 sset Master 0dB
  amixer -c0 cset name='DAC1 Playback Volume' 87          # tweeter_ceiling por defecto = máximo de serie
  wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.15
  wpctl set-mute @DEFAULT_AUDIO_SINK@ 0 && amixer -c0 sset Master unmute && amixer -c0 sset 'Bass Speaker' on
  ```
- **G2.4 Auriculares (NO VERIFICADO).** A volumen 0,15 comprobar:
  - al enchufar, la ruta cambia a auriculares y los altavoces se silencian (por UCM, porque Auto-Mute está desactivado);
  - las teclas de volumen funcionan;
  - al desenchufar vuelve a Speaker;
  - **criterio de nivel:** una pista de referencia suena cómoda al **70 % o menos**.

  Si no se cumple, solo queda aceptar el compromiso o hacer rollback. El fallback B no lo arregla, porque usa el mismo enrutado.
- **G2.5 Micrófono interno.** `pw-record --rate 48000 /tmp/m.wav` durante 5 s y luego `pw-play /tmp/m.wav`.
- **G2.6 LED de mute.** `cat /sys/class/sound/ctl-led/speaker/card0/list` ya no debe estar vacío. Es deseable pero no bloquea.
- **G2.7 Escritura de usuario en DAC2.** `amixer cset` sin sudo funciona (ACL `user:sajra:rw-`).

**Calibración [U].** Solo con G2.3 pasado, es decir, con el hardware fijo y el volumen software:
1. Música a 0,25 (software).
2. Ajustar `DAC2` en pasos de 2–3 (0,75 dB por paso; nunca por encima de 70) hasta que arriba y abajo suenen equilibrados. **No tocar `Master` ni `DAC1` mientras suena.** Si hay que bajar `DAC1`, primero pausa la reproducción.
3. **Distorsión a volumen máximo real:** con la pista de más grave, subir de 0,80 a **1,00** en pasos de 0,05. Si hay distorsión, bajar `DAC2` (o `DAC1` en pausa) y repetir.
4. El valor final es el **`woofer_ceiling`** (y `tweeter_ceiling` si bajaste DAC1). Persistirlo así:
   ```bash
   echo N > ~/.config/x1sound/woofer_ceiling
   sudo alsactl store
   ```
5. Anotarlo en `listening-log.md`.
6. **Al terminar cada sesión de pruebas con hardware:** volver a fijar los techos y repetir `sudo alsactl store`. `alsa-restore` guarda al apagar lo que haya en el mixer, aunque sean valores de prueba.
7. **Tras cada arranque, hasta la Fase 4:** `amixer -c0 cget name='DAC2 Playback Volume'` debe ser igual a `woofer_ceiling` antes de reproducir. El clamp solo garantiza el límite por arriba.

**Después de calibrar:**
- **G2.8 Decisión sobre la curva AO.** Al cambiar el balance puede que el FIR AO necesite ajuste. Hay tres opciones y la elección se anota en gates:
  - **(a) Regenerar con el conversor.** Solo cambia de variante; no adapta la curva al nuevo enrutado.
  - **(b) Corrección propia** con los nodos `pk*` / huecos del PEQ de la Fase 3, después del AO, con etiqueta `extra`.
  - **(c) Aceptar sin cambios.**
- **Base B2.** Escucha y grabación del monitor (método de la Fase 1) con la cadena conservada y el nuevo routing. Es la referencia de G3.5.
- **G2.9 Seguir o parar.** Puntúas contra una lista de quejas concretas: volumen, tweeters, encajonamiento, bombeo, voz. **Solo se pasa a la Fase 3** si queda alguna queja que las Fases 3–5 atacan: volumen bajo y comprimido, perfiles o boost. Si no, el plan termina aquí (con el clamp activo).

**Aceptación:**
- G2.0–G2.5 pasan.
- Los tweeters se oyen con claridad.
- Después de otro reinicio, DAC2 y DAC1 siguen en sus techos, y G2.0 y G2.3 siguen pasando.

**Fallback B.** Solo si D0-A, G2.1 o G2.2 fallan por pin-match. Se usa `echo 'options snd_sof_intel_hda_generic hda_model=alc245-fixup-bass-hp-dac' | sudo tee /etc/modprobe.d/x1c9-audio.conf` y se repite **toda** la secuencia de esta fase: preparación previa, mutes, reinicio, R1–R4 y G2.0–G2.7. El enrutado es deducido y DAC2 vuelve a arrancar en su valor por defecto.

**Nunca** usar `nofixup`, `hdajackretask`, `user_pin_configs` ni `reconfig`, porque pueden dejar los woofers en 0x06, que no tiene volumen.

**Rollback (en orden):**
```bash
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.15; wpctl set-mute @DEFAULT_AUDIO_SINK@ 1
amixer -c0 sset 'Bass Speaker' off; amixer -c0 sset Master mute
mv ~/.config/wireplumber/wireplumber.conf.d/51-x1c9-softmixer.conf ~/x1sound-backup/
systemctl --user disable x1c9-dac2-clamp.service
sudo rm -f /etc/udev/rules.d/89-x1c9-dac2.rules
sudo mv /etc/modprobe.d/x1c9-audio.conf.off /etc/modprobe.d/x1c9-audio.conf && systemctl reboot
# tras arrancar en yoga9, sin reproducir:
alsactl -f "$B/asound.state" restore && sudo alsactl store       # $B = backup previo a la Fase 2
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.15; wpctl set-mute @DEFAULT_AUDIO_SINK@ 0; amixer -c0 sset Master unmute; amixer -c0 sset 'Bass Speaker' on
```
El controlador sigue funcionando en modo `shared` y simplemente oculta el balance.

---

### Fase 3: una sola cadena consolidada `x1sound.conf` [A] escribe, [U] instala y reinicia; 0,5–1 día

**Objetivo.** Sustituir la conf generada por **una** cadena que suene igual con los valores por defecto, que exponga puntos de control en vivo y que tenga un perfil `off` **dentro del grafo**, de modo que el HP4, el regulador y el limitador sigan siempre activos.

**Archivos [A]:**
- `~/Projects/x1sound/pipewire/x1sound.conf.in`: plantilla. Se sustituyen `@IR_PATH@`, `@G_IN@` (y `@MAKEUP@` si level-restore ganó). Todos los valores se sacan de la conf **conservada en la Fase 1**, nunca de literales.
- `~/.local/share/x1sound/ir/<variante>.irs`: copia del `.irs` conservado. Se lee como dato.

**Grafo** (los valores de `peq`, `reg` y `limiter`, y los nombres de puertos LSP, se copian **tal cual** de la conf conservada):
```
context.modules = [
{ name = libpipewire-module-filter-chain
  flags = [ ifexists nofail ]          # solo en estéreo; la conf quad (Fase 7) NO lleva nofail
  args = {
    node.description = "X1 Speaker DSP"
    filter.graph = {
      nodes = [
        { type = builtin name = spL label = copy }   { type = builtin name = spR label = copy }
        { type = builtin name = conv_l label = convolver config = { filename = "@IR_PATH@" channel = 0 gain = 1.0 } }
        { type = builtin name = conv_r label = convolver config = { filename = "@IR_PATH@" channel = 1 gain = 1.0 } }
        # mezclador AO/seco: "Gain 1" = AO, "Gain 2" = seco (perfil off). Por defecto 1 / 0.
        { type = builtin name = mixL label = mixer control = { "Gain 1" = 1.0 "Gain 2" = 0.0 } }
        { type = builtin name = mixR label = mixer control = { "Gain 1" = 1.0 "Gain 2" = 0.0 } }
        { type = builtin name = lsL label = bq_lowshelf  control = { "Freq" = 180.0  "Q" = 0.7071 "Gain" = 0.0 } }
        { type = builtin name = lsR label = bq_lowshelf  control = { "Freq" = 180.0  "Q" = 0.7071 "Gain" = 0.0 } }
        { type = builtin name = hsL label = bq_highshelf control = { "Freq" = 9000.0 "Q" = 0.7071 "Gain" = 0.0 } }
        { type = builtin name = hsR label = bq_highshelf control = { "Freq" = 9000.0 "Q" = 0.7071 "Gain" = 0.0 } }
        # campana builtin libre (voice / corrección G2.8b / campana del perfil off del XML)
        { type = builtin name = pkL label = bq_peaking   control = { "Freq" = 2500.0 "Q" = 1.0 "Gain" = 0.0 } }
        { type = builtin name = pkR label = bq_peaking   control = { "Freq" = 2500.0 "Q" = 1.0 "Gain" = 0.0 } }
        # peq     : LSP para_equalizer_x16_lr  (HP4 100 Hz ← FUERA de la whitelist; −3 dB @5800 Q2.5; −2 dB @510 Q1.5; bandas 3–5 libres)
        # reg     : LSP mb_compressor_stereo   (g_in @G_IN@; umbrales de zona en vivo)
        # limiter : LSP limiter_stereo         (th 0.891 = −1 dBFS, lookahead 1 ms, ALR on)  ← FIJO, nunca escribible
      ]
      links = [ spL→conv_l→mixL:"In 1" · spL→mixL:"In 2" · mixL→lsL→hsL→pkL→peq(L)
                spR→conv_r→mixR:"In 1" · spR→mixR:"In 2" · mixR→lsR→hsR→pkR→peq(R) · peq→reg→limiter ]
      inputs  = [ "spL:In" "spR:In" ]
      outputs = [ "limiter:out_l" "limiter:out_r" ]
    }
    capture.props = {
      node.name = "effect_input.x1sound"  media.class = Audio/Sink
      audio.channels = 2  audio.position = [ FL FR ]
      filter.smart = true  filter.smart.name = "x1sound"
      filter.smart.target = { node.name = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink" }
    }
    playback.props = { node.name = "effect_output.x1sound" node.passive = true audio.channels = 2 audio.position = [ FL FR ] }
  } }
]
```
- Q siempre explícito, porque no está verificado cómo trata 1.6.10 un Q=0.
- Todas las ganancias positivas (shelves, `pk`, boost, makeup) van **antes** de `reg` y de `limiter`. **Nunca hay ganancia después de `reg`.**
- **Perfil `off`** (`dax`):
  - mezclador a 0/1 (señal seca, sin AO), shelves a 0 y boost a 0;
  - la campana de altavoz que el XML mantiene en `off`, según la investigación; los valores exactos se transcriben y se comprueban en el golden test;
  - **HP4, regulador y limitador se quedan**.
- Al conmutar AO y seco puede haber un breve efecto de peine si el FIR tiene latencia. Se hace en rampa (G4.6).

**Pasos [U]** (todos en el mismo paso, para que nunca coexistan dos cadenas):
```bash
mv ~/.config/pipewire/pipewire.conf.d/Dolby_* ~/.config/pipewire/disabled/
cp ~/Projects/x1sound/pipewire/x1sound.conf ~/.config/pipewire/pipewire.conf.d/   # renderizada por [A]
systemctl --user restart pipewire pipewire-pulse wireplumber
```

**Gates:**
- **G3.1 Carga.**
  - `journalctl --user -u pipewire --since -2min | grep -iE 'error|fail'` sale vacío.
  - `pw-dump` muestra los dos nodos `effect_*.x1sound`.
  - `pw-link -l` muestra un solo filtro.
- **G3.2 Inventario de controles (solo lectura).** [U] guarda `pw-cli enum-params <id effect_input.x1sound> Props` en `~/Projects/x1sound/docs/controls-snapshot.txt`.
  - La **whitelist** de escritura se genera a partir de este archivo, no de memoria.
  - Hay que confirmar los nombres exactos: `mixL:Gain 1/2`, `lsL:Gain`, `hsL:Gain`, `pkL:*`, `reg:g_in`, los umbrales del regulador (la investigación los llama `al_N`, NO VERIFICADO), `sf_N` y las bandas del PEQ.
  - Quedan excluidos siempre `limiter:*`, la banda HP4 del PEQ y `conv_*`/`sp*`.
- **G3.3 Escritura en tiempo real.** [U], a volumen 0,20:
  - Builtin: `pw-cli s <id> Props '{ params = [ "hsL:Gain" 4.0 "hsR:Gain" 4.0 ] }'` debe sonar más brillante. `mixL/R` a 0/1 debe sonar sin AO.
  - LV2 (NO VERIFICADO): `pw-cli s <id> Props '{ params = [ "reg:g_in" 1.0 ] }'` debe sonar unos 6 dB más bajo.
  - Después se restauran los valores.
  - **Si las escrituras LV2 no tienen efecto:**
    - el boost se hace con nodos builtin `linear` (`Mult`), uno por canal, **antes** de `reg`, y cuenta en S5;
    - **el regulador acoplado sale de la v1**: no hay compensación después de `reg`;
    - si `sf_N` o las bandas del PEQ no son escribibles, el perfil **music** sale de la v1;
    - **voice** usa `pk*`.

    El test de la conf renderizada (Fase 4) cubre también esta variante.
- **G3.4 Zipper.** Paso brusco de 6 dB frente a rampa de 0,5 dB cada 50 ms. Del resultado sale el tamaño de paso de las rampas.
- **G3.5 Equivalencia (objetiva).** Con todos los valores por defecto, se graba el monitor del sink (método de la Fase 1, altavoces silenciados por hardware) para `x1sound.conf` y se compara con la **base B2**. [A] compara con código propio, alineando por correlación.
  - **Pasa** si el residuo es < −60 dB o la diferencia es ±0,1 dB en cada banda de tercio de octava.
  - La escucha A/B es complementaria, con el nivel igualado según la medida.
- **G3.6 CPU.** En `pw-top` durante la reproducción, el uso no debe superar al de la cadena conservada sola, y no debe haber xruns en 10 minutos.

**Aceptación.** G3.1, G3.2, G3.5 y G3.6 pasan, y el resultado de G3.3 y G3.4 queda registrado.

**Rollback.** Mover `x1sound.conf` a `disabled/`, devolver la conf conservada y reiniciar PipeWire.

---

### Fase 4: el binario `x1sound` en Rust (CLI y daemon), 3,5–4,5 días

**Prerrequisito [U].** `sudo pacman -S rust` (unos 309 MiB). **No hace falta clang.**

**Sin crates externos.** Solo `std`: no se descarga ni se ejecuta código de terceros (build scripts ni proc-macros). Así [A] puede compilar `--offline`. Si el clasificador bloqueara igualmente `cargo`, compilas tú. El precio es más código propio: un parser JSON (~300 líneas, con tests), `sd_notify` escrito a mano y tests exhaustivos en rejilla en lugar de proptest.

#### 4.1 Estructura `~/Projects/x1sound/` (repo git; commits en una rama, solo cuando lo pidas)
```
Cargo.toml        # [dependencies] vacío. Sin build.rs.
src/main.rs       # daemon [--dry-run] | status | set <k> <v> | profile <p> | volume up|down|set <v> | reset | doctor | clamp
                  # bypass-diag on|off   (solo CLI, diagnóstico, marca "protección reducida", RECHAZADO en quad)
                  # install [--ir <path>] | uninstall (RECHAZADO en quad) | gate pass|fail|list <G>
                  # calibrate --woofer-ceiling N [--tweeter-ceiling M] [--fc-min F] [--allow-above-hard-max]
                  # snapshot-controls | testsignal … | analyze … | tplg-patch … (Fase 7) | glyph-install
src/json.rs       # parser/serializador JSON propio, con lectura en streaming para pw-dump
src/notify.rs     # sd_notify (UnixDatagram a $NOTIFY_SOCKET)
src/config.rs     # schema v1, defaults, CLAMPS DUROS en código, escritura atómica, fallback al último config válido
src/pw.rs         # lector `pw-dump -m -N` (hilo); nodos resueltos POR NOMBRE; supresión del eco propio
                  # actuador: UN `pw-cli` persistente alimentado por stdin (NO VERIFICADO) o, si no, un `pw-cli s` por lote cada ≥ 50 ms
src/alsa.rs       # parseo de /proc/asound/card0/codec#0 → routing {split|shared|quad|unsafe|unknown};
                  # amixer get/set DAC1/DAC2 (solo bajar, salvo calibrate); jack; Auto-Mute
src/policy.rs     # función PURA (config, calibración, vol_db, routing, profile, hp_active) → parámetros objetivo
src/budget.rs     # S5: boost + makeup + loudness + tono + perfil + RELAJACIÓN del regulador ≤ +12 dB
src/ramp.rs       # asimétrico: protector = inmediato; relajante = paso de G3.4 cada ≥ 50 ms
src/profiles.rs   # deltas por perfil (dynamic, music, voice, off) transcritos del XML DAX3, con referencias de línea
src/doctor.rs     # autodiagnóstico (§4.5)
src/gates.rs      # ~/.config/x1sound/gates.json
src/state.rs      # $XDG_RUNTIME_DIR/x1sound/state.json (ts, health, routing, vol_db, aplicado, gates, latencias)
src/audio.rs      # WAV propio: testsignal y analyze (RMS, tercios de octava, alineación); sustituye a levelcmp.py
pipewire/{x1sound.conf.in, x1sound-quad.conf.in}   systemd/{x1sound.service, x1sound-clamp.service}
glyph/{Sound.qml, Speakers.qml, mount.patch, volume.patch}   hypr/volume-keys.patch
tests/{policy.rs, budget.rs, golden_xml.rs, pwdump_fixture.rs, render.rs, fixtures/*.json}
```

#### 4.2 Configuración
`~/.config/x1sound/config.json` la escriben la UI y la CLI y la lee el daemon:
```json
{ "version": 1, "enabled": true, "profile": "dynamic",
  "boost_db": 6,
  "regulator_coupling": { "enabled": false, "vsafe_db": -12, "max_relax_db": 6 },
  "loudness": { "enabled": false, "amount": 0.3, "ref_db": -10, "max_bass_db": 8, "max_treble_db": 4 },
  "tone": { "bass_db": 0, "treble_db": 0 },
  "balance": { "dac2": null },
  "auto_profile": false, "app_rules": {} }
```
- `balance.dac2: null` significa "igual a `woofer_ceiling`": el balance se deriva del techo, no de un literal.
- `boost_db` por defecto es el `@G_IN@` conservado. Si ganó level-restore, va aparte como `makeup_db`, fijo y fuera de la UI.

Archivos aparte:
- `~/.config/x1sound/calibration.json` (`woofer_ceiling`, `tweeter_ceiling`, `f_tw_min`, `fc_min`): **solo** lo escribe `x1sound calibrate`, nunca la UI.
- `gates.json`: solo lo escribe `x1sound gate pass|fail`.

**Sin calibración** (archivo ausente o corrupto):
- health = **degraded**;
- el daemon **nunca sube** DAC2 ni aplica balance;
- si DAC2 supera el valor conservador por defecto (**50**), solo lo baja.

**Clamps duros en código:**

| Ajuste | Límite |
|---|---|
| `boost_db` | 0…+8 (techo `voice` del XML) |
| shelves totales | −6…+10 dB |
| `tone` | ±6 dB |
| `max_relax_db` | 0…6 dB |
| `woofer_ceiling` | ≤ **70** (−12,75 dB) salvo `--allow-above-hard-max`, que queda registrado en gates y en `doctor` |
| `dac2` | ≤ `woofer_ceiling`; sin calibración, ≤ 50 |
| `tweeter_ceiling` (DAC1) | ≤ 87 |
| budget S5 | ≤ +12 dB en total, **incluida la relajación** |
| `limiter:*`, HP4 | no direccionables |

**Etiquetas de fidelidad:**

| Función | Etiqueta | Por defecto |
|---|---|---|
| AO FIR, PEQ, regulador estático, boost | `dax` | on |
| Perfil `off` dentro del grafo | `dax` | — |
| Regulador acoplado al volumen | `dax (no verificado en DAX3)` | off hasta pasar G4.7; fuera de la v1 si G3.3 falla en LV2 |
| Perfiles | `dax` | dynamic |
| Balance DAC2 | `realtek` (deducido) | = techo calibrado |
| Loudness | `extra` | **off** (el volume modeler de DAX está desactivado aquí) |
| Tono, corrección G2.8b | `extra` | 0 |
| Bypass por metadata | diagnóstico | solo CLI, nunca en quad |
| Crossover (Fase 7) | `extra` / "más allá de Windows" | off |

#### 4.3 Política
- **Volumen.** Con el soft-mixer, `V_dB = 20·log10(media(softVolumes))` del Speaker sink. Si `softVolumes` no está presente, se usa `channelVolumes`. El mute se lee aparte.
- **Regulador acoplado** (`dax`, no verificado en DAX3): `thr_N = base_N + min(−V_dB, max_relax_db)`, con tope de 0 dBFS. **Si `V_dB > vsafe_db` (−12 dB), se fuerza `thr_N = base_N`.** La relajación cuenta en S5.
- **Loudness** (`extra`):
  - `bass = clamp(amount·(ref_db − V_dB), 0, max_bass_db)`; el agudo funciona igual.
  - Por encima de Vsafe, 0 dB.
  - Se suma al tono y se escribe en `ls*:Gain` y `hs*:Gain`.
- **Boost.** `reg:g_in = 10^(boost_db/20)`, o el nodo `linear` previo a `reg` si se usa el fallback de G3.3.
- **Perfiles:**
  - `dynamic` = base.
  - `music` = umbrales del regulador más profundos (solo si G3.2 confirma los puertos).
  - `voice` = campana de presencia en `pk*` y boost hasta +8 dentro del budget.
  - `off` = señal seca dentro del grafo, como se describe en la Fase 3.
- **Budget S5.** boost + makeup + loudness positivo + tono positivo + deltas del perfil + relajación ≤ +12 dB. Si se supera, se recorta primero el loudness, luego el tono, después la relajación y por último el boost.
- **Rampas.** Lo que protege (subir el volumen, bajar realces, devolver umbrales) se aplica **al instante**. Lo que relaja se aplica en rampa, con ticks de 50 ms o más.
- **Volumen con protección previa.** `x1sound volume up|down|set` calcula el volumen destino, escribe **primero** los parámetros protectores que le corresponden y espera a que se apliquen. Solo después llama a `wpctl set-volume -l 1.0` (y desmutea, como hace hoy la tecla). Las teclas de Hyprland y `Sys.setVol` de glyph pasan a usarlo (Fase 5), con `|| wpctl …` como reserva. Los cambios hechos desde otras apps siguen siendo reactivos y los limitan el budget, el limitador y el techo.
- **Balance.** Escribe `DAC2` (≤ `woofer_ceiling`) **solo** si se cumplen las cuatro condiciones:
  - `routing == split`;
  - el sink por defecto es Speaker;
  - los auriculares no están activos;
  - hay calibración.

  En DAC2 manda el 0x03, que comparten los auriculares, así que mover el balance cambiaría también su nivel.
- **Modo quad.** `bypass-diag` y `uninstall` se rechazan. `off` sigue dentro del grafo y conserva el HP de tweeters y los limitadores.

#### 4.4 Bucle del daemon
Un solo hilo, más el hilo lector de `pw-dump -m`, conectados por un canal mpsc. Hace esto:
- comprueba el mtime de la config cada 200 ms;
- emite ticks de rampa cada 50 ms o más, solo mientras hay una rampa en curso;
- **supresión de eco:** recuerda los valores que acaba de escribir y descarta los eventos de Props que coinciden por valor; los eventos de Props propios nunca disparan `reconcile` ni `doctor`;
- reconcilia cuando un nodo aparece o reaparece, porque los ids cambian;
- ejecuta `doctor` al arrancar, cada 60 s y cuando cambian nodos o enlaces (no Props);
- registra en `state.json` la marca de tiempo del evento de volumen y la de la escritura aplicada;
- envía `WATCHDOG=1` cada 5 s.

#### 4.5 `doctor` (solo lectura, salvo los puntos 4, 5 y 6)
1. **Exactamente un** smart filter con destino el Speaker sink: se cuenta en `pw-dump` y se buscan otras confs con `filter.smart.target` en `conf.d/`. Si hay más de uno, health = **degraded**, el daemon **no escribe nada** y el remedio dice: "regenera solo con `--output-dir ~/x1sound-staging --no-activate`".
2. `effect_input.x1sound` existe y todos los controles de la whitelist coinciden con `controls-snapshot.txt`. Si no, degraded.
3. El routing se obtiene del codec. **0x17 no debe seleccionar ni poder alcanzar 0x06.** Si puede, health = **unsafe**, la UI muestra un banner rojo y se oculta el balance.
4. Si `DAC2 > woofer_ceiling` (o > 50 sin calibración), **se baja al momento**. Si `DAC1 > tweeter_ceiling`, también.
5. **Modo quad:**
   - `Master`, `DAC1` y `DAC2` no superan los techos validados en estéreo;
   - `Auto-Mute Mode` = Enabled, y si no lo está se vuelve a activar;
   - existe el enlace `effect_output.x1sound_quad → sink Pro Audio`;
   - **ningún otro nodo** enlaza con el sink crudo.

   Si se detecta un enlace ajeno, se elimina con `pw-link -d` y la tarjeta vuelve a HiFi (`wpctl set-profile`). Si falta el filtro, la tarjeta pasa a HiFi al momento.
6. Ruta de auriculares activa: balance desactivado.
7. `bypass-diag` activo: health = **reduced**, con aviso en la UI ("sin HP4, regulador ni limitador; solo protege el techo DAC2").
8. Calibración presente, `soft-mixer` activo y versiones de PipeWire y del kernel. También el estado de los gates, los archivos de glyph y los parches.

**Apagar sin el daemon:**
- `x1sound profile off` y `x1sound reset` escriben los Props directamente con `pw-cli`, sin necesidad del daemon.
- `x1sound bypass-diag on` es diagnóstico, solo por CLI y rechazado en quad.
- `x1sound uninstall` (rechazado en quad) mueve la conf a `~/.config/x1sound/disabled/` y te indica que reinicies PipeWire.

#### 4.6 systemd
`~/.config/systemd/user/x1sound.service`:
```ini
[Unit]
Description=x1sound speaker controller
After=pipewire.service wireplumber.service
PartOf=pipewire.service
[Service]
Type=notify
ExecStart=%h/.local/bin/x1sound daemon
ExecStopPost=-%h/.local/bin/x1sound reset
Restart=on-failure
RestartSec=2
WatchdogSec=15
Nice=5
[Install]
WantedBy=pipewire.service
```
`x1sound-clamp.service` sustituye a `x1c9-dac2-clamp.service`: oneshot con `ExecStart=%h/.local/bin/x1sound clamp`, `Before=pipewire.service`. Es independiente del daemon y solo baja los DACs. En quad también activa Auto-Mute.

**Compilar [A]:** `cd ~/Projects/x1sound && cargo test --offline && cargo install --offline --path . --root ~/.local`. Si se bloquea, lo hace [U].

**Activación [U], en este orden:**
1. `x1sound calibrate --woofer-ceiling <log> [--tweeter-ceiling <log>]`. Crea `calibration.json`.
2. `x1sound doctor` → 0.
3. `x1sound daemon --dry-run` a mano durante 10 min (G4.3).
4. `systemctl --user enable --now x1sound`.
5. `systemctl --user disable x1c9-dac2-clamp && systemctl --user enable x1sound-clamp`.

#### 4.7 Gates y tests
- **Tests unitarios:**
  - clamps;
  - rampas asimétricas;
  - **test exhaustivo en rejilla de S5**: ninguna combinación (boost, makeup, loudness, tono, perfil, relajación) supera +12 dB;
  - **test de la conf renderizada**, en las variantes normal, fallback `linear` y quad: toda ganancia positiva va antes de `reg` y del limitador, y no hay ganancia después de `reg`;
  - la whitelist nunca contiene `limiter:*` ni la banda HP4.
- **Golden test (`golden_xml.rs`):** el lector propio de atributos lee `DEV_0287_SUBSYS_17AA22D5_PCI_SUBSYS_22D517AA.xml` como dato. Comprueba lo siguiente contra `profiles.rs` y contra la conf renderizada:
  - PEQ: HP4 a 100 Hz, −3 dB a 5,8 kHz con Q 2,5, −2 dB a 510 Hz con Q 1,5;
  - `threshold_high`: −6,5 / −11 / −8 / −5 dB a 141 / 234 / 328 / 469 Hz;
  - volmax 96/16 = +6 dB; voice 128 = +8;
  - la campana del perfil `off`.
- **G4.1 Formato del stream.** [U] `timeout 30 pw-dump -m -N > tests/fixtures/volume_sweep.json` mientras se mueve el volumen. El test extrae una serie monótona de `V_dB`.
- **G4.2 Mapeo de volumen frente a la atenuación real.** En un barrido del 10 al 100 %, `V_dB` debe quedar a menos de 1 dB de la atenuación aplicada de verdad: dB de `Master` + `DAC1` (leídos con `amixer`, que deben quedarse fijos) + `20·log10(softVolumes)`.
- **G4.3 `--dry-run`.** 10 minutos de uso normal registrando las escrituras previstas, antes de `enable --now`.
- **G4.4 Resiliencia.**
  - `kill -9`: el audio continúa, `ExecStopPost` hace el reset (comprobado en `pw-dump`) y systemd reinicia el daemon.
  - Reiniciar PipeWire y WirePlumber: health vuelve a ok en menos de 5 s.
  - Suspender y reanudar: los parámetros se vuelven a aplicar.
- **G4.5 Seguridad y latencia.** Con el loudness y la relajación al máximo que permita el budget, contenido con mucho grave, saltar de **0,10 a 1,00**. Se prueba de dos formas:
  - con `x1sound volume set 1.0`: los parámetros protectores se aplican antes que el volumen;
  - con `wpctl` directo: la latencia entre el evento y la escritura aplicada, según las marcas de `state.json`, debe ser **< 150 ms**.

  En ningún caso debe haber distorsión.
- **G4.6 Conmutación a `off`.** El corte o peine al conmutar debe ser corto (por oído, menos de unos 200 ms).
- **G4.7 Escucha del acoplamiento del regulador.** On frente a off a 0,20 y 0,60, con el nivel igualado. Se activa por defecto solo si suena igual o mejor.
- **G4.8 Recalibración con el peor caso.** Con la configuración que agota el budget (por ejemplo voice +8 y el resto hasta 12), repetir la comprobación de distorsión subiendo de 0,80 a 1,00.
  - Si distorsiona, se baja `woofer_ceiling` (`calibrate`) o el tope de S5.
  - Se repite cada vez que cambien los clamps, los perfiles o el makeup.
- **G4.9 Reposo.** Durante 60 s sin cambios, el daemon no hace ninguna escritura y el CPU está prácticamente a 0: no hay bucle de eco.

**Aceptación:**
- `cargo test` en verde y G4.1–G4.6, G4.8 y G4.9 pasados.
- `x1sound doctor` sale con 0.

**Rollback.** `systemctl --user disable --now x1sound` y volver a activar `x1c9-dac2-clamp`. `ExecStopPost` deja la cadena en sus valores por defecto, que suenan igual que en la Fase 3.

---

### Fase 5: panel **Speakers** en las preferencias de glyph (sección AUDIO) e IPC, 1–1,5 días

**G5.0, lectura previa [A] (solo lectura):**
- `prefs/Prefs.qml` (alrededor de las líneas 1100–1140, `Page { k: 7; Audio {…} }`);
- `prefs/Audio.qml` (dos `Side` de 470 px);
- `Sys.qml` (líneas 32–33);
- cómo se registran los singletons;
- `~/.config/hypr/hyprland/keybinds.lua` (líneas 173 y 180).

Con eso se decide entre una **franja bajo las dos columnas** de AUDIO o una sección propia `SPEAKERS` en `sections`.

**Aislamiento.** Solo hay dos archivos nuevos y tres parches pequeños, guardados en el repo:
- `glyph/mount.patch`: monta el panel;
- `glyph/volume.patch`: `Sys.setVol` pasa por `x1sound volume set`, con reserva en `wpctl`;
- `hypr/volume-keys.patch`: las teclas usan `x1sound volume up|down || wpctl …`.

`x1sound glyph-install` vuelve a aplicarlos y `doctor` avisa si falta alguno.

**Archivos [A]:**
- `~/.local/share/glyph/config/quickshell/glyph/services/Sound.qml` (singleton):
  - `FileView` + `JsonAdapter` sobre `~/.config/x1sound/config.json`, con el mismo patrón que `settings/Rules.qml`;
  - un segundo `FileView` (`watchChanges`) sobre `$XDG_RUNTIME_DIR/x1sound/state.json`;
  - `online = (now − state.ts) < 10 s`;
  - `run(args)` → `Quickshell.execDetached(["x1sound", ...args])`;
  - `IpcHandler { target: "sound"; function toggle(): void; function profile(p: string): void; function loudness(on: bool): void }`. `toggle` alterna entre el perfil activo y **`off`** dentro del grafo, nunca bypass.
- `.../prefs/Speakers.qml`, hecho con los widgets existentes `Toggle`, `Pick` y `Dial`:
  - un toggle **DSP** que llama a `x1sound profile off|<anterior>`. Funciona aunque el daemon no esté y nunca quita HP4 ni el limitador;
  - un `Pick` de **perfil**, solo con los perfiles que el daemon declare disponibles;
  - un `Dial` de **balance woofer↔tweeter**, visible solo con routing `split`, el sink Speaker activo, sin auriculares y con calibración; rango de 30 a `woofer_ceiling`;
  - un toggle de **Loudness** y su `Dial` de cantidad, con la etiqueta `extra`;
  - un `Dial` de **Boost** de 0 a 8 (el budget puede recortarlo; la UI lo muestra);
  - una **línea de estado** con routing, health (ok / degraded / reduced / unsafe / offline), V dB, gates pendientes y la etiqueta de fidelidad de cada control.
  - Todo el panel aparece en gris con el aviso "auriculares/HDMI/BT activos" si el sink por defecto no es el Speaker sink (o el filtro quad).
  - **No hay bypass en la UI.**
- **Bind de Hyprland (Lua), por ejemplo:** `SUPER+ALT+S` → `qs ipc call sound toggle` (alterna con `off`, que es seguro).

**Gates:**
- **G5.1.** Comprobar si `FileView` recarga un archivo reemplazado con tmp + rename (NO VERIFICADO). Si no, el daemon escribe `state.json` en el sitio.
- **G5.2.** Arrastrar un `Dial` no debe castigar el disco. Si hace falta, se aplica un debounce de 150 ms a `writeAdapter`.
- **G5.3.** Las teclas de volumen siguen funcionando con el daemon parado (camino de reserva `wpctl`) y con `x1sound` ausente.

**Aceptación:**
- Cada control se oye en unos 300 ms.
- Con el daemon parado el panel muestra "offline" y el toggle DSP sigue funcionando.
- Reiniciar Quickshell no afecta al audio.
- `qs ipc call sound profile voice` funciona.

**Rollback.** Revertir los tres parches y borrar los dos QML. El daemon y la CLI no se ven afectados.

---

### Fase 6 (opcional, unos 1 día): perfil automático por aplicación
- `auto_profile: false` por defecto.
- Se leen `application.process.binary`, `application.name` y `media.role` de los streams enlazados a `effect_input.x1sound`, del mismo `pw-dump`.
- Se comparan con `app_rules`, por ejemplo `{"spotify":"music","mpv":"dynamic","discord":"voice"}`.
- Permanencia mínima de 5–8 s y transiciones en rampa. El budget S5 se aplica en cada perfil.

**Aceptación:**
- Spotify cambia a music en menos de 5 s y una llamada de Discord cambia a voice.
- No hay oscilación cuando suena una notificación.

**Rollback.** `auto_profile=false`.

---

### Fase 7 (rama X, experimental, "más allá de Windows"): crossover real de 2 vías, 3–5 días, puede acabar en G7.0, G7.1 o G7.3

**Pre-gates:**
- G2.9 = "seguir" y Fases 1–5 escuchadas y registradas; sigues queriendo más que el balance;
- D0-C-sucio con una vía elegida: (iii) parche binario, preferida; (i) `.conf` con TLV restaurado; o (ii) fuentes topology1;
- Fase 2 activa (0x17→0x03, soft-mixer) y **techos estéreo validados a 1,0** (calibración y G4.8);
- aceptas que, si falla, no habrá audio analógico hasta quitar la opción y reiniciar;
- backup nuevo, incluidos `system-asound.state` y `wp-state`.

**Principio de seguridad de la rama.** En quad **ningún techo hardware supera el validado en estéreo con contenido de banda completa** (`Master` 0 dB, `DAC1` ≤ `tweeter_ceiling`, `DAC2` ≤ `woofer_ceiling`). Si el filtro desaparece por el motivo que sea, lo peor que llega a los altavoces equivale a la ruta A estéreo a volumen 1,0, que ya está validada. Lo que se necesite de más nivel en tweeters se consigue **bajando** woofers, nunca subiendo hardware.

**Construcción** ([A] prepara, [U] instala):
1. **Vía (iii), preferida.** [A] escribe `x1sound tplg-patch`, código propio basado en las estructuras de `uapi/sound/asoc.h`, con modo `--dump` de solo lectura. Modifica **en el sitio**, sin cambiar el tamaño, solo esto:
   - `channels_max` 2→4 de `'Playback 0'` y `'Playback 31'`;
   - `token100` 768→1536 en BUF1.x, BUF30.x y BUF31.x.

   **Vía (i).** `.conf` descompilado con **todos** los `min` de TLV escritos en decimal con signo (−6400 / −5000).
2. **G7.1 Verificación del build.**
   - **(iii):** mismo tamaño; `cmp -l` lista solo los offsets previstos; `alsatplg -d` de los dos y `diff` muestra solo las líneas previstas (la pérdida de TLV del descompilador afecta igual a los dos lados).
   - **(i):** diff de texto vacío frente al original **y** la diferencia de tamaño explicada sección por sección. Si no se puede explicar, la vía (i) se descarta.
3. **G7.0 Arranque de control (solo vía i o ii).** Se instala el `.tplg` recompilado **sin** cambiar canales, con la misma secuencia de mute de la Fase 2, y se reinicia.
   - Antes de cualquier audio, `amixer -c0 controls | grep -i pga`. El rango dB del volumen PGA de reproducción (por ejemplo `PGA1.0 1 Master Playback Volume`; nombre NO VERIFICADO) debe ser **−64…0 dB**.
   - Si `min` vale 0 (lo que daría unos +64 dB de ganancia digital), **rollback inmediato**.
   - HiFi, micrófono y HDMI deben funcionar.
4. [U], con la secuencia de mute de la Fase 2 (volumen 0,15, mute, `Bass Speaker off`, `Master mute`):
   ```bash
   sudo install -m644 sof-hda-generic-4ch-quad.tplg /lib/firmware/intel/sof-tplg/
   echo 'options snd_sof tplg_filename=sof-hda-generic-4ch-quad.tplg' | sudo tee /etc/modprobe.d/x1c9-sof-quad.conf
   systemctl reboot
   ```

**Gates:**
- **G7.2 Arranque.**
  - Antes de cualquier audio, el rango del PGA debe ser −64…0 dB (como en G7.0) y los techos Master/DAC1/DAC2 deben ser los de la Fase 2.
  - `journalctl -k -b | grep -iE 'sof|topology|error'` sin errores de IPC ni de pipeline.
  - La reproducción en HiFi funciona.
  - El micrófono interno graba (5 s).
  - HDMI sigue funcionando.
- **Preparación de Pro Audio [U]:**
  ```bash
  amixer -c0 sset 'Auto-Mute Mode' Enabled          # el kernel silencia los altavoces al enchufar, sin daemon
  wpctl set-profile <id tarjeta> <índice Pro Audio>
  pw-cli enum-params <id nodo pro-output-0> EnumFormat   # anotar channels (4) y posiciones (AUX0..AUX3)
  ```
- **G7.3 Canales independientes**, con niveles concretos que se oyen y son seguros:
  - **Control positivo primero:** en HiFi, con los techos de la Fase 2 y el volumen software a 1,0, `pw-cat --playback --target <Speaker sink> fl_fr_pink.wav` (ruido rosa a −30 dBFS RMS, unos −20 dBFS de pico, HP 150 Hz) **tiene que oírse**. Si no se oye, la prueba no es válida.
  - En Pro Audio: `Master` 0 dB, `DAC1` = `tweeter_ceiling`, `DAC2` = `woofer_ceiling` (leídos con `amixer` antes de empezar) y el volumen del nodo Pro Audio a 1,0. [A] genera con `x1sound testsignal` dos archivos de 4 canales con la misma señal, uno solo en AUX0/AUX1 y otro solo en AUX2/AUX3. [U] los reproduce:
    ```bash
    pw-cat --playback --target <node.name pro-output-0> --channels 4 --channel-map AUX0,AUX1,AUX2,AUX3 ~/Projects/x1sound/hw/aux23_pink.wav &
    cat /proc/asound/card0/pcm0p/sub0/hw_params     # debe decir channels: 4
    ```
  - **Pasa** si cada archivo suena por un solo par. Se anota qué pareja AUX corresponde a qué pin; lo esperado, no verificado, es AUX0/1 = tweeters (0x14).
  - **Inaudible:** subir 6 dB y repetir. Tope documentado: −18 dBFS RMS. Si sigue sin oírse, la prueba no es concluyente y la rama X se cierra.
  - **Falla** si suenan los dos pares (copy-front) o hay errores: hacer el rollback de la Fase 7. **Aquí se acaba la rama X.** La ruta D (`snd_intel_dspcfg dsp_driver=1`) solo se ofrece como compromiso documentado, porque pierde los micrófonos internos.
- **G7.4 Suelo de los tweeters (S4).** Barrido senoidal solo por el par de tweeters a −30 dBFS, **de 8 kHz bajando hasta 200 Hz**. Anotas dónde dejan de sonar con limpieza: `f_tw_min`. Después `x1sound calibrate --fc-min`, con `fc_min = max(400 Hz, 1,5 × f_tw_min)`.
- **G7.5 Auriculares en modo 4ch.** Comparten el DAC 0x03 con el par de woofers.
  - **Primera barrera, sin daemon:** `Auto-Mute Mode` = Enabled. El kernel silencia los pines de altavoz al enchufar. Se persiste con `sudo alsactl store`, y `x1sound clamp` y `doctor` lo vuelven a activar si UCM lo desactiva.
  - **Segunda barrera:** el daemon cambia a **HiFi 2ch** al enchufar y vuelve a Pro Audio al desenchufar, con los techos aplicados **antes**.
  - **Comprobación con el daemon parado:** al enchufar, los altavoces se callan. Los auriculares reciben la señal de woofers, que es incorrecta pero no peligrosa.
  - **Comprobación con el daemon activo:** los auriculares nunca reciben solo graves.

**Si pasa todo, la conf quad:**
- [A] escribe `x1sound-quad.conf.in`, con **filter-chain normal (no smart) y sin `nofail`**. Si falla la carga, PipeWire no arranca: un fallo visible, no audio crudo.
  - `capture.props`: `node.name = effect_input.x1sound_quad`, `media.class = Audio/Sink`, `audio.position = [ FL FR ]`, `priority.session` la más alta.
  - `playback.props`: `node.name = effect_output.x1sound_quad`, `target.object` = el `node.name` del sink Pro Audio, `audio.channels = 4`, `audio.position` = las **AUX reales** leídas con EnumFormat y en el orden de G7.3, `stream.dont-remix = true`, `node.passive = true`.
- Regla de WirePlumber: el sink crudo Pro Audio con `priority.session` mínima. Si falta el filtro, el sink por defecto pasa a HDMI y no al crudo (NO VERIFICADO; lo comprueba G7.6).
- La cadena:
  - etapas frontales de la Fase 3;
  - nodos `copy`;
  - LR4 con dos Butterworth en cascada, Q 0,7071;
  - `fc` de partida de 1,2 kHz, ajustable entre `fc_min` y 2 kHz;
  - **tweeters:** high-pass en `fc` más un **high-pass fijo de 4.º orden en `fc_min`** que el daemon no puede tocar;
  - **woofers:** low-pass en `fc` más el HP4 de Dolby a 100 Hz;
  - trim por par de ±6 dB, que solo atenúa por encima del techo estéreo;
  - retardo de tweeter de 0–1 ms;
  - **un limitador fijo por par.**
- El volumen pasa a ser software en el nodo filtro y el daemon lo usa como `V_dB`. Los techos hardware no cambian respecto a la Fase 2.
- En quad, `bypass-diag` y `uninstall` se rechazan, y el toggle DSP, `off` y el bind siguen siendo seguros.
- En la UI aparecen los `Dial` de `fc` (clamp ≥ `fc_min`) y de retardo, con la etiqueta `extra`. `doctor` pasa a informar routing `quad`.

**Gates de la conf quad:**
- **G7.6 Sink por defecto y enlaces.**
  - `wpctl status` muestra el filtro como sink por defecto.
  - `pw-link -l` muestra que ninguna app enlaza con el sink crudo.
  - **Prueba de enlace ajeno:** `pw-cat --target <sink crudo>` con ruido a −40 dBFS. Pasa si el enlace no llega a crearse, o si `doctor` lo detecta y lo corta (con `pw-link -d` o pasando a HiFi) en **< 500 ms**.
  - En ningún caso el nivel puede superar el del estéreo validado, por el principio de techos.
- **G7.7 Nada de grave en los tweeters.** Ruido rosa con LP a 300 Hz y −30 dBFS a través del filtro: no debe oírse desde la zona de los tweeters.
- **G7.8 Fallo ruidoso.** Con los altavoces silenciados por hardware, renombrar el IR temporalmente y reiniciar PipeWire: no debe haber audio en ningún sink. Se restaura el IR después.

Ajuste por oído con el protocolo de escucha, primero por pares y luego con música.

**Rollback de la Fase 7 (en orden, antes de reiniciar):**
```bash
wpctl set-profile <id tarjeta> <índice HiFi>
mv ~/.config/pipewire/pipewire.conf.d/x1sound-quad.conf ~/.config/x1sound/disabled/ && x1sound install
alsactl -f "$B/asound.state" restore && sudo alsactl store      # $B = backup previo a la Fase 7
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.15; wpctl set-mute @DEFAULT_AUDIO_SINK@ 1
amixer -c0 sset 'Bass Speaker' off; amixer -c0 sset Master mute
sudo rm /etc/modprobe.d/x1c9-sof-quad.conf && systemctl reboot
```
Tras arrancar, se repiten R1–R4 y G2.0/G2.3 de la Fase 2. El `.tplg` no hace nada sin la opción.

---

### Fase 8 (opcional, posterior): leveler bajo gate
- Solo si después de todo lo anterior el "Windows suena más alto" sigue siendo la queja principal. La investigación estima un hueco de unos +9 dB por el leveler.
- Cadena dentro del grafo: `ebur128 → lufs2gain → linear`, antes de `reg`. Si esos enlaces de control no funcionan (NO VERIFICADO), se pasa a cálculo en el daemon mediante una captura del monitor, lo que necesita backend nativo y `clang`.
- Características:
  - puerta de silencio a −50 dB;
  - integración de 3–10 s;
  - release de 1 dB/s como máximo;
  - la ganancia baja rápido y sube despacio;
  - su ganancia cuenta en S5.
- **G8.1 con herramienta propia.** `tools/measure_ee/autogain_dynamics.py` del repo externo mide EasyEffects, no esta cadena, así que no sirve. [A] añade a `x1sound testsignal` y `analyze` las dos señales del protocolo:
  1. silencio seguido de una ráfaga;
  2. fondo bajo con voz.

  [U] las reproduce a través de `effect_input.x1sound` y graba el monitor del sink con los altavoces silenciados por hardware. Si el sobrepico es > 1 dB o el realce del fondo bajo es > 6 dB, se queda **off**. Si la herramienta no está lista, G8.1 = "sin herramienta" y la Fase 8 queda bloqueada.
- Etiqueta `dax (aproximado)`. Off por defecto.
- **Rollback:** toggle.

*(Investigación opcional aparte: [U] hace un `innoextract` completo de `n32a134w.exe` en un directorio nuevo y vacío, y [A] escribe un lector propio de solo lectura para `RTAIODAT.DAT` 17AA:22D5. Si aparece EQ o DRC por pin, se reproduce con la etiqueta `realtek`.)*

---

## 4. Seguridad

### 4.1 Los woofers nunca reciben audio a escala completa sin atenuar
| # | Medida | Dónde se aplica |
|---|---|---|
| W1 | 0x17 solo conectado a `0x02 0x03`; **0x06 (sin amplificador de volumen) nunca alcanzable**. Prohibidos `nofixup`, `hdajackretask`, `user_pin_configs` y `reconfig`. | G2.2; `doctor` → `unsafe` |
| W2 | `DAC2 ≤ woofer_ceiling` (≤ 70 en código; 50 sin calibración). Antes del reinicio: volumen 0,15, mute de wpctl y mutes ALSA (`Bass Speaker`, `Master`). Tras el reinicio, DAC2 se fija antes de desmutear. La regla udev (opcional) y el clamp oneshot lo bajan sin depender del daemon. Se persiste con `alsactl store` al final de cada sesión, porque `alsa-restore` guarda al apagar. Hasta la Fase 4 se comprueba a mano en cada arranque. | Fase 2; clamp; `doctor` |
| W3 | Limitador final a −1 dBFS fijo, fuera de la whitelist, que se genera desde el snapshot. **Activo en todos los perfiles, incluido `off`.** Solo `bypass-diag` (CLI, prohibido en quad) lo quita; en ese estado la única protección es el techo DAC2, y `doctor` y la UI muestran "reduced". | Conf; test; `doctor` |
| W4 | Todas las ganancias positivas van antes del regulador y del limitador, y nunca hay ganancia después de `reg`. **Budget S5 ≤ +12 dB, incluida la relajación del regulador** (≤ 6 dB). | `budget.rs`, test de la conf renderizada (también la variante fallback) |
| W5 | HP4 de Dolby a 100 Hz no escribible y activo en todos los perfiles; misma excepción de `bypass-diag` que W3. | Conf |
| W6 | Por encima de Vsafe (−12 dB) se fuerzan los umbrales afinados y shelves a 0 dB. Lo que protege se aplica al instante, y `x1sound volume` lo aplica **antes** de subir. Latencia del camino reactivo < 150 ms (G4.5). | `policy.rs`, `ramp.rs`, teclas |
| W7 | Modo 4ch: limitador por par; HP fijo de tweeters ≥ `fc_min`; techos hardware ≤ los validados en estéreo; Auto-Mute Enabled; filtro sin `nofail`; sink crudo con prioridad mínima y vigilado (enlace ajeno → corte o HiFi); bypass y uninstall prohibidos; posiciones AUX explícitas y `dont-remix`. | Fase 7, G7.5–G7.8 |
| W8 | Pruebas: arranque a 0,15–0,20, pasos de 0,05 y tope de 0,80. La única excepción es la comprobación final de distorsión, que sube hasta 1,00. Ruido rosa a −30 dBFS con HP a 150 Hz y barridos de tweeter de agudo a grave. | Protocolo |
| W9 | Sin `hda-verb` ni escrituras hwdep en ningún caso. | Regla |
| W10 | Nunca se cambia `Master` ni `DAC1` con `amixer` mientras suena audio. La calibración solo empieza con el soft-mixer confirmado (G2.3). | Regla, Fase 2 |
| W11 | El conversor externo solo se ejecuta con `--output-dir ~/x1sound-staging --no-activate`. | Fase 1, `doctor` |

### 4.2 Auriculares, HDMI y Bluetooth
- El filtro estéreo apunta **solo** al Speaker sink por `node.name`. HDMI (otros PCM) y Bluetooth no pasan por él.
- El daemon no hace nada si el sink por defecto no es Speaker, y el panel aparece en gris.
- **Ruta A:** los auriculares comparten DAC 0x03 con los woofers, así que reciben Master × DAC2 y su máximo es el techo de los woofers (G2.4). No hay `Headphone Playback Volume`: el volumen es software. El balance queda **desactivado** mientras la ruta de auriculares esté activa. En HiFi, Auto-Mute está desactivado y el silencio de los altavoces lo hace la ruta UCM.
- **Modo 4ch:** con Auto-Mute Enabled el kernel silencia los altavoces aunque no haya daemon, y el hook del jack pasa a HiFi 2ch (G7.5).

### 4.3 Si el daemon se cae
| Caso | Qué pasa |
|---|---|
| Caída o `kill -9` | El DSP sigue en PipeWire. `ExecStopPost=x1sound reset` devuelve los valores por defecto de la conf (sin realces y con los umbrales afinados) y systemd lo reinicia. |
| Cuelgue | El watchdog (15 s) lo mata y se aplica el caso anterior. |
| Reinicio de PipeWire | La conf vuelve a sus valores por defecto, que son seguros, y el daemon resuelve los nodos de nuevo por nombre. |
| Daemon desactivado | `profile off`, `reset` y `uninstall` funcionan por CLI sin daemon. El clamp oneshot sigue limitando DAC1 y DAC2 en cada login. |
| Arranque con fallo de `alsactl restore` | La regla udev y el clamp bajan DAC2 a ≤ 50 (o al techo) sin daemon. Hasta la Fase 4 se comprueba también a mano. |
| `bypass-diag` activo | Sin HP4, regulador ni limitador. Solo protege el techo DAC2 (estado de serie de Linux). Health = reduced. Prohibido en quad. |
| Peor caso | Salto de volumen desde una app que no es `x1sound` con parámetros de volumen bajo activos. Lo cubren el budget (que incluye la relajación, ≤ +12 dB), la latencia < 150 ms, el limitador fijo y el techo DAC2 validado a 1,0 con el budget agotado (G4.8). |

### 4.4 Límites de volumen
| Elemento | Límite |
|---|---|
| `Master` | ≤ 0 dB (fijo con soft-mixer) |
| `DAC1` (tweeters) | ≤ `tweeter_ceiling` (por defecto 87) |
| `DAC2` (woofers y auriculares) | ≤ `woofer_ceiling` ≤ 70 (50 sin calibración) |
| Software | boost 0…+8 dB, shelves −6…+10, tono ±6, relajación ≤ 6; total ≤ +12 dB |
| Salida digital | ≤ −1 dBFS |
| Quad | techos hardware ≤ los validados en estéreo |

---

## 5. Arquitectura del controlador

**Se recomienda Rust**, que es lo que pediste, **sin crates externos** y con un **backend de subprocesos**: `pw-dump -m`, un `pw-cli` persistente, `pw-metadata`, `wpctl` y `amixer`. Motivos:
- un único binario que hace de CLI y de daemon, sin tokio ni bindgen;
- solo hace falta `pacman -S rust`, **sin clang**, y no se ejecuta código de terceros al compilar;
- tipos y tests (rejilla exhaustiva de S5, golden del XML, conf renderizada) para la parte de seguridad;
- todos los comandos se pueden repetir a mano en la terminal.

Rust y cargo **no están instalados**: el primer paso de la Fase 4 lo ejecutas tú.

**Alternativas descartadas o de reserva:**

| Opción | Ventaja | Por qué no es la principal |
|---|---|---|
| Python | No hay que instalar nada | Peor para empaquetar y probar. Se usa solo para las herramientas de medida antes de la Fase 4. |
| C | gcc ya está instalado | JSON y seguridad de memoria más frágiles |
| Script Lua de WirePlumber | Corre dentro del gestor de sesión | Un fallo puede romper el enrutado de todo el audio |
| Solo QML | No necesita daemon | Sin acoplamiento al volumen fiable |
| Backend nativo `pipewire` 0.10 | Más preciso y sin latencia de procesos | Necesita clang y crates. Solo si G4.5 no baja de 150 ms, o en la Fase 8. |

**DSP:** todo dentro de PipeWire. El daemon **no toca nunca muestras de audio**.

**Flujo de datos:**
```
 teclas Hyprland / glyph Sys.setVol ──► x1sound volume … (protección primero) ──► wpctl set-volume
 glyph prefs/Speakers.qml ──escribe──► ~/.config/x1sound/config.json ◄── x1sound CLI / qs ipc call sound …
        ▲ lee (FileView)                         │ mtime 200 ms
        │                                        ▼
 $XDG_RUNTIME_DIR/x1sound/state.json ◄── x1sound daemon ──► gates.json · calibration.json (solo CLI)
   (heartbeat, health, routing, V dB,     │  observador: pw-dump -m -N (volumen soft, sink default, enlaces, nodos), sin eco propio
    latencias)                            │  alsa.rs: codec#0, amixer DAC1/DAC2/Master, jack, Auto-Mute
                                          │  policy → budget S5 (con relajación) → ramp (protector inmediato / relajante ≥ 50 ms)
                                          │  actuador: pw-cli persistente {params=[whitelist]} · amixer (solo bajar) · wpctl set-profile (quad)
                                          ▼  (solo parámetros)
 apps ─► effect_input.x1sound [copy → (FIR AO | seco) → shelves → pk → PEQ (HP4 fijo) → regulador → LIMITADOR FIJO] ─► Speaker sink (vol. software)
        ─► DAC 0x02 (DAC1 = techo tweeters) → 0x14      DAC 0x03 (DAC2 = techo woofers) → 0x17 (+ auriculares 0x21)
 x1sound-clamp.service (oneshot, sin daemon): baja DAC1/DAC2 a sus techos en cada login; en quad activa Auto-Mute
```

**Integración con glyph (sección AUDIO):**
- singleton `services/Sound.qml`;
- página `prefs/Speakers.qml`, montada como franja en `Audio.qml` o como sección propia según G5.0;
- `IpcHandler target "sound"` para los binds de Hyprland;
- `volume.patch` y `volume-keys.patch` para que el volumen pase por `x1sound`;
- las ediciones de archivos existentes están aisladas en parches y `x1sound glyph-install` las vuelve a aplicar.

---

## 6. Esfuerzo y orden recomendado

| Fase | Contenido | Esfuerzo | sudo / reinicio | Sesiones tuyas (escucha, reinicio o medida) |
|---|---|---|---|---|
| 0 | Gate de viabilidad y backup | 30 min | no | 1 |
| 1 | Quitar duplicado, decisión IEQ y level-restore con nivel medido, base B1 | 45 min + escucha | no | 3 |
| 2 | Ruta A, soft-mixer, techos, calibración a 1,0, B2, G2.8, G2.9 | 2–2,5 h + escucha | sí, 1–2 reinicios | 3–4 |
| 3 | Cadena consolidada, perfil `off`, snapshot, equivalencia medida | 0,5–1 día | no | 2 |
| 4 | Binario Rust: daemon, doctor, clamp, gates, tests | 3,5–4,5 días | `pacman -S rust` | 3 (dry-run, G4.5, G4.7/4.8) |
| 5 | Panel de glyph, IPC, binds y teclas de volumen | 1–1,5 días | no | 1 |
| 6 | Perfil automático (opcional) | 1 día | no | 1 |
| 7 | Crossover 4ch (rama X, opcional) | 3–5 días, puede acabar en G7.0/G7.1/G7.3 | sí: firmware + 2–3 reinicios | 4–5 |
| 8 | Leveler bajo gate con herramienta propia (opcional) | 3–5 días | quizá `pacman -S clang` | 2 |

El núcleo (Fases 0–5) son unos 6,5–8 días de trabajo del asistente, más unas **13–14 sesiones tuyas de 15–30 min** (unas 4–6 h).

**Orden:** 0 → 1 → *escuchar y medir* → 2 → *calibrar, B2, G2.9 (seguir o parar)* → 3 → 4 → 5 → (6) → decidir la rama X → (7) → (8).

Las fases 1 y 2 dan la mayor parte de la mejora audible sin escribir código. G2.9 es el punto explícito para parar si ya no queda ninguna queja que el controlador ataque.

---

## 7. Preguntas abiertas y cosas sin verificar

1. **Nombres en la ruta A:** ¿aparecen `DAC1 Playback Volume`/`DAC2 Playback Volume` y los interruptores `Speaker`/`Bass Speaker`/`Headphone` tal como se deduce del código (R1)? ¿Cuál es el valor por defecto real de DAC2 al arrancar (¿0 dB?)?
2. **Soft-mixer:** ¿se aplica `api.alsa.soft-mixer` con ese `match`? ¿ACP deja los elementos hardware sin tocar en ese modo? Sin él, ¿qué elemento movería ACP: `Master` o nada? (G2.3)
3. **`alsactl restore`** con controles que faltan en el state: ¿sigue o cae en `alsactl init`? ¿En qué orden se aplican la regla udev y `alsa-restore`?
4. **Auriculares en la ruta A:** ¿nivel suficiente con el techo DAC2 y solo volumen software? (G2.4) ¿Merece la pena en el futuro un modo "auriculares" que suba DAC2 con los altavoces silenciados? Hoy queda descartado por la ventana de riesgo al desenchufar.
5. ¿El "EQ secreto" que el comentario del kernel atribuye al DAC 0x02 afecta al timbre de los tweeters? (G2.8)
6. ¿Se pueden escribir en tiempo real los controles LV2 con `pw-cli s … Props`? ¿LSP suaviza los cambios? ¿Hay zipper en los biquads y en el `mixer` builtin? (G3.3, G3.4) ¿Cómo se llaman de verdad los puertos de umbral (`al_N`) y si `sf_N` es escribible?
7. ¿El monitor del sink se graba antes del volumen y con independencia del mute hardware (`stream.capture.sink`)? Es la base de G3.5, de la Fase 1 y de G8.1.
8. ¿DAX3 acopla de verdad el regulador al volumen, como dice el white paper de PCEE v4? (G4.7)
9. ¿Acepta `pw-cli` comandos por stdin de forma persistente sin TTY? ¿Cuál es la latencia real entre el evento y la escritura? (G4.5) Formato exacto de `pw-dump -m -N` (G4.1). ¿`FileView` recarga tras un rename atómico? (G5.1)
10. **Topology:** ¿el parche binario (iii) basta, o el kernel o el firmware validan algo más (checksums, tamaños de buffer)? ¿Acepta SOF 4 canales en el DAI HDA0 analógico de TGL, o sigue haciendo copy-front? ¿Cuál es el nombre exacto del control PGA y su rango dB tras el cambio? (G7.0–G7.3)
11. **Modo 4ch:** ¿se puede impedir de verdad que un cliente enlace con el sink crudo, o solo detectarlo y cortarlo? ¿Respeta `stream.dont-remix` el mapeo por índice con posiciones AUX? ¿El `BootSequence` de UCM vuelve a desactivar Auto-Mute en Pro Audio? ¿Es robusto el cambio de perfil al enchufar el jack? (G7.5, G7.6)
12. ¿Qué hace la capa Realtek de Windows (`RTAIODAT.DAT` 17AA:22D5: `RTEQEX`, `RTHDAEQ`, `RTKHDRC`)? ¿Hay EQ o DRC por par de altavoces?
13. ¿Qué perfil Dolby usa Windows en tu unidad (Dolby Access)? ¿Ejecuta VBE? ¿Qué campana exacta conserva el perfil `off` del XML?
14. ¿El leveler pasa el protocolo de G8.1 con la herramienta propia?
15. Sin micrófono de medida, el ajuste acústico (DAC2, `fc`, retardos, cantidades) depende del oído: es repetible solo hasta cierto punto. Las comparaciones digitales (G3.5, niveles) sí son objetivas.

---

## Cambios tras la revisión

**Controles y volumen en la ruta A**
- Se cambió todo el volumen de `Speaker` por **`DAC1 Playback Volume`**; el interruptor `Speaker` se mantiene. Los nombres se marcan como deducidos del código y se confirman con el listado R1. `tweeter_ceiling` pasa a referirse a DAC1.
- **Soft-mixer desde el primer arranque:** se prepara antes del reinicio de la Fase 2. G2.3 pasa a comprobar que ningún DAC se mueve, y se registra qué elemento movería ACP sin soft-mixer.
- G2.1 ya no confía en el nombre del fixup en el log, porque `CONFIG_SND_DEBUG_VERBOSE` está desactivado. Se confirma por sus efectos: existen DAC1/DAC2, 0x17 está en `0x02 0x03*` y la lista ctl-led no está vacía.
- G4.2 ya no es tautológico: compara `V_dB` con la atenuación real (dB de `amixer` más `softVolumes`).

**Seguridad del reinicio de la Fase 2**
- Antes de reiniciar: auriculares fuera, volumen 0,15 **antes** del mute, y mutes ALSA de `Bass Speaker` y `Master`.
- Se añaden la regla udev opcional y el clamp oneshot sin daemon. El nuevo orden R1–R4 registra el valor real de DAC2, re-mutea si hace falta y fija DAC2 antes del volumen y del unmute.
- Aviso de no tocar las teclas de volumen ni glyph, que quitan el mute. Se recomienda hacer R1–R4 desde una TTY.
- Nuevo **G2.0**: el smart filter sigue enganchado antes de desmutear.

**Calibración y techos**
- Solo con soft-mixer confirmado, y nunca se cambia Master/DAC1 con audio sonando (W10).
- La comprobación final de distorsión sube a **1,0**, porque las teclas y glyph llegan ahí.
- Nuevo G4.8: recalibración con el budget agotado.
- `woofer_ceiling` tiene un valor por defecto de 50, un máximo duro de 70 con flag de override y un `calibrate` obligatorio antes de activar el daemon. Sin calibración, health = degraded y DAC2 solo se baja. `balance.dac2` se deriva del techo.
- `alsactl store` explícito al final de cada sesión, porque `alsa-restore` guarda al apagar, y comprobación manual de DAC2 en cada arranque hasta la Fase 4.

**Backups y rollbacks**
- El backup incluye `/var/lib/alsa/asound.state` y `~/.local/state/wireplumber`.
- El rollback de la Fase 2 retira el soft-mixer, el clamp y la regla udev, y restaura el mixer antes de `alsactl store`.
- El rollback de la Fase 7 va en orden: perfil HiFi → conf → mixer → store → mute → reinicio.
- El fallback B repite toda la secuencia de la Fase 2, ya no aparece como salida de G2.4 y se deja solo para fallos de pin-match.

**Bypass y perfil `off`**
- `flat = bypass` pasa a ser el perfil **`off` dentro del grafo**: mezclador AO/seco, la campana del XML, y HP4, regulador y limitador conservados.
- El bypass por metadata queda como `bypass-diag`, solo por CLI, con estado "reduced" y prohibido en quad. W3 y W5 se reformulan en consecuencia.
- El toggle DSP, el bind y la IPC usan `off`.

**Budget y latencia**
- La relajación del regulador cuenta en S5 y `max_relax_db` baja a 6.
- Se elimina la compensación después de `reg` del fallback de G3.3: si LV2 no es escribible, el acoplamiento sale de la v1. El test de la conf renderizada cubre la variante fallback.
- `x1sound volume` aplica la protección antes de subir y las teclas y glyph pasan por él.
- G4.5 va de 0,10 a **1,00** con un criterio de latencia < 150 ms.
- Se añaden `pw-cli` persistente o lotes ≥ 50 ms, supresión de eco y G4.9 de reposo.

**Fase 1 y Fase 3**
- La Fase 1 separa dos decisiones (variante IEQ y level-restore) y aclara qué pasa si gana level-restore (`makeup_db` y S5 redefinido).
- La Fase 3 saca el IR y `g_in` de la conf conservada.
- El conversor se ejecuta siempre con `--output-dir ~/x1sound-staging --no-activate` (W11 y `doctor`).
- G3.5 es objetivo: se graba el monitor y se compara contra la nueva base **B2**, ya con el routing de la Fase 2. Los A/B subjetivos igualan el nivel con una medida.
- Nuevo G2.8 (decisión sobre la curva AO) y G2.9 (seguir o parar). El calendario incluye tus sesiones de escucha.

**Rust y compilación**
- Proyecto **sin crates externos**: JSON y `sd_notify` propios, tests en rejilla. Se compila `--offline`; si se bloquea, compilas tú.
- Se añade `daemon --dry-run`, y G4.3 se ejecuta antes de `enable --now`.

**Fase 0 y topology**
- D0-C queda registrado como **fallido hoy** (round-trip no limpio, verificado). Se añade el resultado "compila pero diff ≠ vacío".
- La ruta C solo sigue por parche binario mínimo, por TLV restaurado con la diferencia de tamaño explicada, o por fuentes topology1.
- Nuevo G7.0: arranque de control y rango dB del PGA −64…0 dB antes de cualquier audio.

**Modo quad (Fase 7)**
- Los techos hardware nunca superan los validados en estéreo.
- Auto-Mute Enabled, mantenido por clamp y `doctor`, y probado con el daemon parado.
- Filter-chain no smart sin `nofail`, con `priority.session` alta y `target.object`. El sink crudo queda con prioridad mínima y vigilado.
- Nuevos gates: G7.6 (sink por defecto y enlace ajeno cortado en < 500 ms), G7.7 (nada de grave en tweeters) y G7.8 (fallo ruidoso).
- Bypass y uninstall prohibidos en quad.
- G7.3 usa `--target` explícito, posiciones AUX reales, control positivo, niveles concretos y audibles, y un resultado "inaudible" con tope de −18 dBFS RMS.

**Fase 8**
- G8.1 usa una herramienta propia, porque la del repo mide EasyEffects. Sin herramienta, la fase queda bloqueada.