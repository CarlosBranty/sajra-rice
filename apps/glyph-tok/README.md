# glyph-tok

TikTok (o Netflix) en una ventana tipo celular (9:19.5) con el estilo de glyph. Qt WebEngine (motor de Chrome) + QML.
Quickshell no puede cargar WebEngine, por eso es un proceso aparte que lee la paleta que exporta glyph
(`~/.local/state/rice/glyph/palette.json`, escrita por `shell.qml`).

## Uso
- **Perfiles**: el botón con el icono del sitio (barra, a la derecha) abre el menú TikTok / Netflix / Crunchyroll (torii) / Dailymotion (D); o `glyph-tok tiktok`, `glyph-tok crunchyroll`, `glyph-tok dailymotion`,
  `glyph-tok netflix` (lo abre si está cerrado). Se recuerda el último. Cada perfil tiene sus atajos en la barra, su modo
  (TikTok fijo, Netflix flotante 16:9 por defecto) y su ancho en fijo (`dockRatio` / `dockRatio_netflix`). Cookies compartidas
- **Modo esquina** (Netflix, por defecto): flotante 16:9 arriba a la derecha y las ventanas en mosaico la rodean en L —
  arriba llegan hasta su borde, debajo ocupan todo el ancho (una sola ventana toma el rectángulo más grande). Es un
  layout en Lua de Hyprland, `lua:glyph-corner` en `~/.config/hypr/user.lua`; glyph-tok pone `general.layout` a ese
  mientras está en esquina y visible, y devuelve el anterior (dwindle) al ocultar, cambiar de modo o cerrar.
  Botón de modo: Netflix esquina → flotante → fijo; TikTok fijo ⇄ flotante (`glyph-tok mode|corner|float|dock`)
- **Netflix / DRM**: Widevine no viene con Arch; `main.cpp` enlaza el CDM que bajó Zen/Firefox
  (`gmp-widevinecdm/<ver>/libwidevinecdm.so`, el más nuevo) en `~/.local/share/glyph-tok/WidevineCdm/` y lo pasa con
  `--widevine-path`. En Linux Netflix da hasta 720p. Pantalla completa del reproductor = pantalla completa de hypr
  (se desfija mientras dura: hypr no deja una ventana fijada en pantalla completa)
- **Super+Alt+T** — mostrar / ocultar (`glyph-tok` = toggle; también `show`, `hide`, `quit`, `mode`, `dock`, `float`)
- **Super+↓ / Super+↑** — video siguiente / anterior, mientras TikTok se ve; oculto o cerrado, Super+↑/↓ mueven
  el foco como siempre (`user.lua`). El cliente habla por un socket Unix sin levantar Qt: ~40 ms
- **Super+Alt+Shift+T** o el botón de la barra — modo **fijo** ⇄ **flotante**
  - fijo: franja a la derecha reservada por glyph (`glyph/tok/TokDock.qml`): las ventanas en mosaico no la tapan,
    sigue en todos los escritorios. La franja va en la capa Overlay: hypr reparte las zonas exclusivas por capas y
    así el bar de glyph (Top) se calcula antes y ocupa todo el ancho. El ancho es una proporción del alto (`dockRatio`, 0.52 por defecto), así se ve igual en cualquier monitor; estirar su borde izquierdo la cambia (se guarda). Oculta → se libera el espacio
  - flotante: 420×910 abajo a la derecha, encima de todo; el 📌 decide si te sigue entre escritorios
- **Transparencia** propia, en foco y sin foco: glyph → Ajustes → WINDOWS → `tiktok` / `tiktok idle` (100/100 por defecto:
  video opaco aunque las demás ventanas sean translúcidas). Lo aplica `Theme.apply()` de glyph con la regla nombrada
  `glyph-tok-opacity` (override); en modo juego, opaca
- Estado en `~/.local/state/glyph-tok/state.json` (`mode`, `dockRatio`, y `dockWidth` = px en el monitor actual, que lee glyph); se escribe en el mismo archivo, no con
  rename, porque el FileView de glyph vigila el inodo
- Ocultar pausa el video y congela la página (~4 % CPU frente a ~40 % visible)
- Barra: atrás · buscar (Ctrl+F) · Para ti · Siguiendo · Explorar · Perfil … silenciar · fijar en todos los escritorios · ocultar
- Esc oculta (o cierra la búsqueda); Ctrl+R recarga; ↑/↓ cambian de video (TikTok)
- Sesión guardada en `~/.local/share/glyph/glyph-tok/QtWebEngine/glyph-tok`

## Compilar / instalar
(`set_source_files_properties(... SINGLETON)` va antes de `qt_add_qml_module`: si no, el qmldir sale sin
`singleton Theme` y los colores de glyph quedan undefined)
```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$HOME/.local
cmake --build build -j8 && cmake --install build
```
Ventana flotante, tamaño y posición: reglas por class `glyph-tok` en `~/.config/hypr/user.lua`.

## Archivos
- `main.cpp` — init de WebEngine, instancia única (socket local), paleta → QML, VA-API
- `qml/Main.qml` — ventana, barra glyph, WebEngineView, popups de login
- `qml/inject.js` — CSS/JS dentro de tiktok.com (oculta la barra lateral; solo selectores `data-e2e`)
- `qml/Theme.qml`, `qml/Btn.qml` — colores/fuentes de glyph, botón redondo

## Depurar
`QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222 glyph-tok` y DevTools en http://127.0.0.1:9222 — solo para depurar:
mientras está abierto, cualquier proceso local puede controlar la sesión.

Si TikTok cambia su web y algo se ve mal, el arreglo casi siempre va en `qml/inject.js`.

## Bloqueador de anuncios (motor de Brave)

glyph-tok bloquea anuncios con **adblock-rust**, el motor de Brave (`adblock/`, crate Rust enlazado como librería
estática; `adblock.h`/`adblock.cpp` lo conectan a Qt):

- **Red**: cada petición del perfil pasa por el motor → bloqueada, redirigida a un stub inofensivo (p. ej. el SDK de
  anuncios de video de Google, para que el reproductor no se rompa) o permitida.
- **Cosmético + scriptlets**: por dominio, reglas para ocultar elementos y los scriptlets de uBlock Origin / Brave
  (los que quitan los anuncios de YouTube del reproductor), inyectados al crear el documento en todos los frames.
- **Listas**: las mismas que Brave activa por defecto en escritorio (de su `list_catalog.json`): uBlock filters,
  EasyList, EasyPrivacy, listas de Brave, cookies. Actualizar:

```sh
glyph-tok-adblock-update   # listas + scriptlets en ~/.local/share/glyph-tok/adblock; luego: glyph-tok quit
```

  Los scriptlets de uBlock se generan desde el código fuente de su última versión con `tools/ubo-resources.py`, que lo
  **lee como texto** (no ejecuta nada de uBlock). El motor compilado se guarda en caché (`engine.dat`, ~7 ms al abrir).
- Sin listas descargadas no hace nada (la app funciona igual que antes).
- Límites: no aplica las reglas cosméticas genéricas por clase/id ni las procedurales (`:has-text`…), solo las
  específicas de cada sitio y los scriptlets. Requiere `cargo` para compilar.
- Pruebas: `cd adblock && cargo test`.

