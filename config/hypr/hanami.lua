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
-- Hold Ctrl+Alt+D to dictate. What you say while holding it is typed where the cursor is (terminal, browser…) when
-- you release it, without going through the AI. Pauses don't cut it
hl.bind("CTRL + ALT + D", hl.dsp.exec_cmd(bin .. " --dictate"))
hl.bind("CTRL + ALT + D", hl.dsp.exec_cmd(bin .. " --dictate-end"), { release = true })

-- Start it at login. Hyprland doesn't read ~/.config/autostart, so it starts here
hl.on("hyprland.start", function()
    hl.exec_cmd(bin)
end)
