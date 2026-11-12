-- Tus atajos y ajustes personales. Este archivo está en .gitignore:
-- `git pull` del rice nunca lo sobrescribe. Se carga al final de hyprland.lua.
-- Descomenta (quita el "--") lo que quieras usar y guarda.

local vars = require("variables")
local apps = vars.apps

-- Cambiar apps por defecto (los binds las leen al pulsar la tecla)
-- vars.terminal = "kitty"
-- apps.editor = "code"            -- Super+Shift+K
-- apps.todo   = "planify"         -- Super+R

-- Atajos nuevos: hl.bind("MODS + TECLA", acción)
-- hl.bind("SUPER + B", hl.dsp.exec_cmd("firefox"))
-- hl.bind("SUPER + G", hl.dsp.global("shell:game"))   -- modo juego

-- Apps de Flatpak (Flathub) en el lanzador y en "Abrir con": Hyprland arranca sin XDG_DATA_DIRS,
-- y sin ella solo se buscan apps en /usr/share
hl.env("XDG_DATA_DIRS", os.getenv("HOME") .. "/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share")

-- Música (~/.local/bin/musica: mpv en segundo plano → widget de medios de glyph vía MPRIS)
-- El rice usa Super+M para el workspace especial "music" (vacío → solo oscurece la pantalla): se quita
hl.unbind("SUPER + M")
hl.bind("SUPER + M", hl.dsp.global("shell:launcherInterrupt"), { non_consuming = true }) -- que no abra el lanzador al soltar Super
hl.bind("SUPER + M", hl.dsp.exec_cmd(os.getenv("HOME") .. "/.local/bin/musica"))                 -- reproducir / pausa
hl.bind("SUPER + ALT + M", hl.dsp.global("shell:music"))   -- panel de música de glyph (lista, búsqueda, álbumes/carpetas)

-- TikTok estilo glyph (~/Projects/glyph-tok), en todos los escritorios. Modo fijo: la app se coloca en la franja que
-- reserva glyph (tok/TokDock.qml); modo flotante: 420x910 abajo a la derecha. Esto es solo la posición inicial
hl.window_rule({
    match = { class = "^(glyph-tok)$" },
    float = true,
    pin   = true,
    size  = "420 910",
    move  = "(monitor_w-window_w-16) (monitor_h-window_h-16)",
})
hl.bind("SUPER + ALT + T", hl.dsp.exec_cmd(os.getenv("HOME") .. "/.local/bin/glyph-tok"))   -- mostrar / ocultar TikTok
hl.bind("SUPER + ALT + SHIFT + T", hl.dsp.exec_cmd(os.getenv("HOME") .. "/.local/bin/glyph-tok mode"))   -- TikTok: fijo ⇄ flotante
-- Super+↓/↑: si TikTok (glyph-tok) se ve, video siguiente/anterior; si está oculto o cerrado, foco como siempre
local function tok_visible()
    for _, w in ipairs(hl.get_windows()) do
        if w.class == "glyph-tok" and w.mapped and not w.hidden then return true end
    end
    return false
end
local tok = os.getenv("HOME") .. "/.local/bin/glyph-tok"
for key, dir in pairs({ up = "prev", down = "next" }) do
    hl.unbind("SUPER + " .. key)
    hl.bind("SUPER + " .. key, hl.dsp.global("shell:launcherInterrupt"), { non_consuming = true }) -- que no abra el lanzador
    hl.bind("SUPER + " .. key, function()
        if tok_visible() then hl.exec_cmd(tok .. " " .. dir)
        else hl.dispatch(hl.dsp.focus({ direction = key })) end
    end)
end

-- glyph-tok en modo esquina (Netflix): flotante arriba a la derecha y las ventanas en mosaico la rodean en forma de L —
-- arriba llegan hasta su borde izquierdo, debajo de ella ocupan todo el ancho. Una ventana sola es un rectángulo:
-- toma el más grande (a su izquierda de alto completo, o debajo de ancho completo). glyph-tok pone general.layout =
-- "lua:glyph-corner" mientras está en esquina y visible (y vuelve a dwindle al salir); sin la ventana en la esquina de
-- un monitor, ahí se reparte como dwindle (cada ventana nueva parte a la anterior por su lado largo)
local function glyph_box(x, y, w, h) return { x = math.floor(x), y = math.floor(y), w = math.floor(w), h = math.floor(h) } end
local function glyph_dwindle(b, T, from, to)
    for j = from, to do
        if j == to then T[j]:place(b)
        elseif b.w >= b.h then
            T[j]:place(glyph_box(b.x, b.y, b.w / 2, b.h)); b = glyph_box(b.x + b.w / 2, b.y, b.w - math.floor(b.w / 2), b.h)
        else
            T[j]:place(glyph_box(b.x, b.y, b.w, b.h / 2)); b = glyph_box(b.x, b.y + b.h / 2, b.w, b.h - math.floor(b.h / 2))
        end
    end
end
-- m ventanas en fila (o columna si la zona es alta), partes iguales
local function glyph_row(b, T, from, to)
    local m = to - from + 1
    for j = from, to do
        local i = j - from
        if b.w >= b.h then T[j]:place(glyph_box(b.x + b.w * i / m, b.y, b.w / m, b.h))
        else T[j]:place(glyph_box(b.x, b.y + b.h * i / m, b.w, b.h / m)) end
    end
end
-- la ventana de glyph-tok si está pegada a la esquina superior derecha de esta zona
local function glyph_hole(A)
    for _, w in ipairs(hl.get_windows()) do
        if w.class == "glyph-tok" and w.mapped and not w.hidden and w.floating and w.fullscreen == 0 then
            local x, y, ww, wh = w.at.x, w.at.y, w.size.x, w.size.y
            if math.abs(x + ww - (A.x + A.w)) < 40 and math.abs(y - A.y) < 40 then return { x = x, y = y, w = ww, h = wh } end
        end
    end
end
pcall(hl.layout.register, "glyph-corner", {
    recalculate = function(ctx)
        local A, T = ctx.area, ctx.targets
        local n = #T
        if n == 0 then return end
        local h = glyph_hole(A)
        local gap = 5
        local g = hl.get_config("general.gaps_in")
        if type(g) == "table" and g.left then gap = g.left end
        local leftW = h and (h.x - gap - A.x) or 0
        local botY = h and (h.y + h.h + gap) or 0
        if not h or leftW < 200 or A.y + A.h - botY < 150 then return glyph_dwindle(glyph_box(A.x, A.y, A.w, A.h), T, 1, n) end
        local top = glyph_box(A.x, A.y, leftW, botY - A.y)
        local bot = glyph_box(A.x, botY, A.w, A.y + A.h - botY)
        if n == 1 then
            local left = glyph_box(A.x, A.y, leftW, A.h)
            return T[1]:place(left.w * left.h >= bot.w * bot.h and left or bot)
        end
        -- arriba la mitad (redondeando hacia abajo), debajo el resto: la franja de abajo es la más ancha
        local k = math.max(1, math.floor(n / 2))
        glyph_row(top, T, 1, k)
        glyph_row(bot, T, k + 1, n)
    end,
})

-- Contraseñas (Vaultwarden vía rbw + rofi): Super+Alt+P abre el buscador (Super+P es el panel VPN de glyph)
hl.bind("SUPER + ALT + P", hl.dsp.exec_cmd(os.getenv("HOME") .. "/.local/bin/glyph-vault"))
-- Ventana donde se escribe la clave maestra (pinentry): flotante y centrada
hl.window_rule({ match = { class = "^([Pp]inentry.*|gcr-prompter)$" }, float = true, center = true })
-- rofi (gestor de contraseñas): blur detrás del fondo translúcido y animación suave
hl.layer_rule({ match = { namespace = "rofi" }, blur = true, ignore_alpha = 0.2, animation = "popin 90%" })

-- Roamies: Ctrl+Alt+Espacio para hablarle. Una pulsación empieza a escuchar; otra (o una pausa al terminar de hablar)
-- envía lo dicho. Es la compilación de desarrollo (~/Projects/Roamies); si vuelves a la AppImage, cambia la ruta
hl.bind("CTRL + ALT + Space", hl.dsp.exec_cmd(os.getenv("HOME") .. "/Projects/Roamies/showcase/tauri/src-tauri/target/debug/roamies --talk"))

-- Roamies al iniciar sesión (la compilación de desarrollo). Hyprland no lee ~/.config/autostart, así que se arranca aquí
hl.on("hyprland.start", function()
    hl.exec_cmd(os.getenv("HOME") .. "/Projects/Roamies/showcase/tauri/src-tauri/target/debug/roamies")
end)
