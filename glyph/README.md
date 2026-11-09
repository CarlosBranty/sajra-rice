# Panel SPEAKERS para glyph

`Speakers.qml` y `EqBand.qml` van en `~/.local/share/glyph/config/quickshell/glyph/prefs/`.
En `prefs/Prefs.qml` hacen falta dos cambios:

1. Añadir `"SPEAKERS"` al final de `sections`:
   ```qml
   readonly property var sections: [..., "IDLE", "SHELL", "SPEAKERS"]
   ```
2. Añadir la página detrás de la de SHELL (`k` = posición en `sections`):
   ```qml
   // ---- SPEAKERS: x1sound — Dolby profile, bass/treble/gain, loudness, top/bottom balance (prefs/Speakers) ----
   Page {
       k: 12
       caption: spk.caption
       Speakers { id: spk }
   }
   ```
El panel lee y escribe `~/.config/x1sound/config.json` y `eq-presets.json`; el daemon aplica los cambios.
