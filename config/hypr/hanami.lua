-- Hanami (the voice assistant, an optional component of these dots). install.sh turns it on by linking
-- hanami-enabled.lua → hanami.lua (the link is gitignored); user.lua loads it only when that link exists.
-- To turn it off by hand: rm ~/.config/hypr/hanami-enabled.lua
--
-- The binary: the installed package first (/usr/bin/hanami, or ~/.local/bin/hanami), else the development build in
-- ~/Projects/Roamies (named hanami, or roamies before the rename), else nothing is bound.

local home = os.getenv("HOME")

local function exists(path)
    local f = io.open(path)
    if f then f:close(); return true end
    return false
end

local bin
for _, path in ipairs({
    "/usr/bin/hanami",
    home .. "/.local/bin/hanami",
    home .. "/Projects/Roamies/showcase/tauri/src-tauri/target/debug/hanami",
    home .. "/Projects/Roamies/showcase/tauri/src-tauri/target/debug/roamies",
}) do
    if exists(path) then bin = path; break end
end
if not bin then return end

-- Ctrl+Alt+Space to talk to it. One press starts listening; another (or a pause after you finish speaking) sends it
hl.bind("CTRL + ALT + Space", hl.dsp.exec_cmd(bin .. " --talk"))
-- Hold Ctrl+Alt+D to dictate. What you say while holding it is pasted where the cursor is (terminal, browser…) when
-- you release it, or typed as you speak with "Type as I speak" on (Voice page), without going through the AI. Pauses
-- don't cut it
hl.bind("CTRL + ALT + D", hl.dsp.exec_cmd(bin .. " --dictate"))
hl.bind("CTRL + ALT + D", hl.dsp.exec_cmd(bin .. " --dictate-end"), { release = true })

-- Ctrl+Alt+H opens its settings as a glyph side panel (the shell's hanami/ module, over Hanami's panel socket); Esc or a
-- click beside it closes it
hl.bind("CTRL + ALT + H", hl.dsp.global("shell:hanami"))

-- Start it at login. Hyprland doesn't read ~/.config/autostart, so it starts here
hl.on("hyprland.start", function()
    -- Hyprland always has layer-shell: said outright, so Hanami never takes X11 windows when the compositor is still
    -- too busy at login to answer its question (a tiled, blurred see-through window)
    hl.exec_cmd("env ROAMIES_LAYER_SHELL=1 " .. bin)
end)
