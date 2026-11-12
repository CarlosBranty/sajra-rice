local vars = require("variables")

hl.config({
    decoration = {
        rounding = vars.windowRounding,

        -- прозрачность окон; glyph переписывает её из Prefs → WINDOWS (Theme.apply). Не window_rule с override:
        -- он перекрыл бы эти значения навсегда
        active_opacity     = vars.windowOpacity,
        inactive_opacity   = vars.windowOpacity,
        fullscreen_opacity = 1,

        blur = {
            enabled           = vars.blurEnabled,
            xray              = vars.blurXray,
            special           = vars.blurSpecialWs,
            ignore_opacity    = true, -- Allows opacity blurring
            new_optimizations = true,
            popups            = vars.blurPopups,
            input_methods     = vars.blurInputMethods,
            size              = vars.blurSize,
            passes            = vars.blurPasses,
        },

        shadow = {
            enabled      = vars.shadowEnabled,
            range        = vars.shadowRange,
            render_power = vars.shadowRenderPower,
            color        = vars.shadowColour,
            color_inactive = "rgba(00000000)",
        },
    },
})
