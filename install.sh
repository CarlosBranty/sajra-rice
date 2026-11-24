#!/usr/bin/env bash
# Glyph: installs everything on a clean Arch and links the configs from this repo.
#   ./install.sh                       packages + services + symlinks; asks which optional components to add
#   ./install.sh --with telegram       same, components picked up front (--with "" installs only the rice)
#   ./install.sh --with hanami         same, with the Hanami assistant
#   ./install.sh --hanami-build        same, building Hanami from hanami/ in this repo (no release needed)
#   ./install.sh --links               symlinks only (on an already set-up system, any distro)
#   ./install.sh --sddm                login theme only (sudo); run again after editing config/sddm
#   ./install.sh --dry-run             prints every action, changes nothing
#   ./install.sh --help                all the flags
# The UI uses gum (Arch: extra/gum) when it is there and the terminal is interactive; without it, plain text.
# Full command output goes to a log file, shown at the end.
set -euo pipefail

DOTS="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%F_%H-%M-%S)"
BACKUP="$HOME/.dots-backup-$STAMP"
LOG="${XDG_STATE_HOME:-$HOME/.local/state}/glyph/install-$STAMP.log"

PACMAN=(
    # base
    base-devel git curl jq python
    # session
    hyprland hypridle hyprsunset hyprpicker xdg-desktop-portal-hyprland xdg-desktop-portal-gtk
    sddm quickshell polkit-gnome gnome-keyring geoclue upower xdg-user-dirs
    # sound, network, bluetooth
    pipewire pipewire-pulse pipewire-alsa wireplumber networkmanager bluez bluez-utils power-profiles-daemon
    # tools the binds and the shell call
    brightnessctl playerctl wl-clipboard cliphist grim slurp swappy imagemagick libvips libqalculate
    gpu-screen-recorder ydotool libnotify trash-cli
    # terminal and console
    kitty fish starship fastfetch btop cava eza zoxide direnv
    # apps from variables.lua
    thunar pavucontrol
    # music panel and musica (mpv over MPRIS, ffprobe/ffmpeg for the index), downloads panel, keystroke overlay
    mpv mpv-mpris ffmpeg aria2 showmethekey
    # printing: the PRINT page of Prefs (glyph-print over the CUPS tools). ghostscript: cups-filters' other
    # rasteriser (pdftoraster) gives the thermal driver an inverted page
    cups cups-filters ghostscript
    # fonts (cjk: kaomoji in Charms), icons (Papirus-Dark: the base of Rice's folder theme), dark base for gtk.css
    ttf-jetbrains-mono-nerd noto-fonts noto-fonts-cjk noto-fonts-emoji papirus-icon-theme adw-gtk-theme
)

AUR=(
    qtengine darkly-bin bibata-cursor-theme-bin
    zen-browser-bin
    zj-58 # thermal ticket printers (ESC/POS, 58 and 80 mm): the driver glyph-print adds them with
)

# Optional components, like caelestia's. What the special-workspace binds open: apps in hypr/variables.lua
declare -A EXTRA=(
    [telegram]="telegram-desktop"                                        # Super+D
    [spotify]="spotify-launcher spicetify-cli spicetify-marketplace-bin" # Super+M
    [vault]="rbw rofi rofi-rbw wtype"                                    # Super+Alt+P (Vaultwarden via glyph-vault)
    [clash]="clash-verge-rev-bin"                                        # VPN panel, Super+P
    [tok]="qt6-webengine cmake"                                          # glyph-tok, built from apps/glyph-tok
)
# Picker order and descriptions (no commas: gum's --selected splits on them). hanami is not an EXTRA: it has its
# own steps (package, enable links, fprintd)
COMPONENTS=(hanami tok telegram spotify vault clash)
declare -A DESC=(
    [hanami]="Asistente de voz Hanami: habla (Ctrl+Alt+Espacio) · dicta (Ctrl+Alt+D) · controla el escritorio · ~1 GB de modelos de voz al primer uso"
    [tok]="glyph-tok: TikTok o Netflix en una ventana tipo celular fija a la derecha (Super+Alt+T) · se compila aquí"
    [telegram]="Telegram Desktop (Super+D)"
    [spotify]="Spotify con Spicetify (Super+M)"
    [vault]="Contraseñas: Vaultwarden con rbw y rofi (Super+Alt+P)"
    [clash]="Clash Verge para el panel VPN (Super+P)"
)

G=config/quickshell/glyph
# repo path → path in $HOME
LINKS=(
    "config/hypr                                .config/hypr"
    "$G                                         .config/quickshell/glyph"
    "config/quickshell/rice                     .config/quickshell/rice"
    "config/quickshell/rice/rice                .local/bin/rice"
    "config/kitty                               .config/kitty"
    "config/qtengine                            .config/qtengine"
    "$G/term/qtengine.colors                    .config/qtengine.colors"
    "$G/term/starship.toml                      .config/starship.toml"
    "config/starship/starship-pure.toml         .config/starship-pure.toml"
    "config/wireplumber/52-um2-mono-mic.conf    .config/wireplumber/wireplumber.conf.d/52-um2-mono-mic.conf"
    "$G/term/fastfetch                          .config/fastfetch"
    "$G/term/btop                               .config/btop"
    "$G/term/cava                               .config/cava"
    "$G/term/gtk-3.0/gtk.css                    .config/gtk-3.0/gtk.css"
    "$G/term/gtk-4.0/gtk.css                    .config/gtk-4.0/gtk.css"
    "config/fish/config.fish                    .config/fish/config.fish"
    "config/fish/functions/fish_greeting.fish   .config/fish/functions/fish_greeting.fish"
    "config/fonts                               .local/share/fonts/glyph"
    "config/rofi                                .config/rofi"
    "config/rofi/rofi-rbw.rc                    .config/rofi-rbw.rc"
    "config/bin/glyph-vault                     .local/bin/glyph-vault"
    "config/bin/musica                          .local/bin/musica"
    "config/bin/musica-index                    .local/bin/musica-index"
    "config/bin/musica-remote                   .local/bin/musica-remote"
    "config/bin/glyph-charge-setup              .local/bin/glyph-charge-setup"
    "config/bin/glyph-dl                        .local/bin/glyph-dl"
    "config/bin/glyph-print                     .local/bin/glyph-print"
)

# Hanami is on when these gitignored links exist (user.lua and kitty.conf read them only then)
HANAMI_HYPR="config/hypr/hanami-enabled.lua"   # → hanami.lua
HANAMI_KITTY="config/kitty/hanami.conf"        # → hanami-remote.conf
HANAMI_PKGBUILD="packaging/hanami-bin/PKGBUILD"
HANAMI_SRC="hanami/showcase/tauri"             # Hanami's source, built by --hanami-build
HANAMI_AEC="config/pipewire/hanami-echo-cancel.conf" # the echo-cancelled mic Hanami listens to
HANAMI_AEC_DST=".config/pipewire/pipewire.conf.d/hanami-echo-cancel.conf"

# ── options ──────────────────────────────────────────────────────────────────────────────────────────────────────────

MODE=full DRY=0 YES=0 WITH_SET=0 WITH="" NO_HANAMI=0 HANAMI_BUILD=0
HANAMI_DEB="${HANAMI_DEB:-}" # the environment variable works like --hanami-deb

usage() {
    cat <<EOF
Uso: $0 [opciones]

  (sin opciones)          instalación completa en Arch: paquetes, AUR, componentes, enlaces, servicios,
                          tema de inicio de sesión
  --with <nombres>        componentes opcionales sin preguntar, con comas o espacios: ${COMPONENTS[*]}
                          (--with "" instala solo el rice)
  --no-hanami             sin Hanami; si estaba activado, lo desactiva (quita sus enlaces)
  --hanami-deb <ruta>     instala Hanami desde un .deb local (Hanami_<versión>_amd64.deb) en vez de la release;
                          implica --with hanami. También: HANAMI_DEB=<ruta> ./install.sh
  --hanami-build          compila Hanami desde hanami/ (Rust, Node y tauri-cli; tarda) y lo instala;
                          implica --with hanami
  --links                 solo los enlaces simbólicos (cualquier distribución)
  --sddm                  solo el tema de inicio de sesión (sudo)
  --yes, -y               sin preguntas: valores por defecto y texto plano
  --dry-run               muestra cada acción sin cambiar nada (ni sudo)
  --help, -h              esta ayuda
EOF
}

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --with) WITH_SET=1; shift
                # space-separated names until the next flag, as before (--with telegram spotify); commas work too
                while [ $# -gt 0 ] && [[ "$1" != --* ]]; do WITH+=" $1"; shift; done
                continue ;;
            --with=*) WITH_SET=1; WITH+=" ${1#--with=}" ;;
            --no-hanami) NO_HANAMI=1 ;;
            --hanami-deb) [ $# -ge 2 ] || die "--hanami-deb needs a path"; HANAMI_DEB="$2"; shift ;;
            --hanami-deb=*) HANAMI_DEB="${1#--hanami-deb=}" ;;
            --hanami-build) HANAMI_BUILD=1 ;;
            --links) MODE=links ;;
            --sddm) MODE=sddm ;;
            --yes|-y) YES=1 ;;
            --dry-run) DRY=1 ;;
            --help|-h) usage; exit 0 ;;
            *) usage >&2; exit 1 ;;
        esac
        shift
    done
    WITH="${WITH//,/ }"
}

# ── output ───────────────────────────────────────────────────────────────────────────────────────────────────────────

RED='#d71921'
R=$'\e[38;2;215;25;33m' D=$'\e[2m' B=$'\e[1m' N=$'\e[0m'
GUM=0          # gum UI: gum present, interactive terminal, not --yes
ASK=0          # questions allowed: interactive terminal, not --yes
TTY=0          # stdout is a terminal: colours and the plain spinner

setup_ui() {
    if [ -t 1 ]; then TTY=1; else R='' D='' B='' N=''; fi
    if [ -t 0 ] && [ -t 1 ] && [ "$YES" -eq 0 ]; then ASK=1; fi
    if [ "$ASK" -eq 1 ] && command -v gum >/dev/null; then GUM=1; fi
    export GUM_SPIN_SPINNER_FOREGROUND="$RED" GUM_CHOOSE_CURSOR_FOREGROUND="$RED" GUM_CHOOSE_SELECTED_FOREGROUND="$RED" \
        GUM_CHOOSE_HEADER_FOREGROUND="#8c8c8c" GUM_CONFIRM_PROMPT_FOREGROUND="#f2f2f2" \
        GUM_CONFIRM_SELECTED_BACKGROUND="$RED" GUM_CONFIRM_SELECTED_FOREGROUND="#f2f2f2"
}

say() { printf '%s●%s %s\n' "$R" "$N" "$*"; }
dim() { printf '%s%s%s\n' "$D" "$*" "$N"; }

# Notes for the summary card. A file, not an array: steps run in a subshell
NOTES="$(mktemp)"
note() { printf '%s\n' "$*" >>"$NOTES"; }

KEEPALIVE=""
cleanup() { rm -f "$NOTES"; [ -z "$KEEPALIVE" ] || kill "$KEEPALIVE" 2>/dev/null || true; }
trap cleanup EXIT

card() { # card <text>: a bordered box in the theme red
    if [ "$GUM" -eq 1 ]; then
        local w; w=$(( $(tput cols 2>/dev/null || echo 80) - 8 )); [ "$w" -le 88 ] || w=88
        gum style --border rounded --border-foreground "$RED" --padding "1 2" --margin "0 2" --width "$w" "$1"
    else printf '%s\n' "$1" | sed 's/^/  /'; fi
}

confirm() { # confirm <question> <default: yes|no>; without questions the default stands
    if [ "$ASK" -eq 0 ]; then [ "$2" = yes ]; return; fi
    if [ "$GUM" -eq 1 ]; then
        local def=true; [ "$2" = yes ] || def=false
        gum confirm --default="$def" --affirmative "Sí" --negative "No" "$1"
        return
    fi
    local a hint="[S/n]"; [ "$2" = yes ] || hint="[s/N]"
    read -rp "  $1 $hint " a || true
    case "${a,,}" in s|si|sí|y|yes) return 0 ;; n|no) return 1 ;; *) [ "$2" = yes ] ;; esac
}

# x: every change goes through here. With --dry-run it is printed instead of run
x() {
    if [ "$DRY" -eq 1 ]; then printf '    %s→%s %s\n' "$D" "$N" "$*"; return 0; fi
    "$@"
}
# write a file (as root when sudo=1): x can't carry a redirection
write_file() { # write_file <sudo: 0|1> <path> <content>
    if [ "$DRY" -eq 1 ]; then printf '    %s→%s write %s\n' "$D" "$N" "$2"; return 0; fi
    if [ "$1" -eq 1 ]; then printf '%s' "$3" | sudo tee "$2" >/dev/null; else printf '%s' "$3" >"$2"; fi
}

# ── detection ────────────────────────────────────────────────────────────────────────────────────────────────────────

detect() {
    OS="?"
    # shellcheck disable=SC1091 # the system's file
    [ -r /etc/os-release ] && OS="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$ID}")"
    IS_ARCH=0; command -v pacman >/dev/null && IS_ARCH=1
    GPU="?"
    if command -v lspci >/dev/null; then
        local g; g="$(lspci 2>/dev/null | grep -Ei 'vga|3d|display' || true)"
        GPU=""
        [[ "$g" != *NVIDIA* ]] || GPU+="NVIDIA "
        [[ "$g" != *AMD* && "$g" != *ATI* ]] || GPU+="AMD "
        [[ "$g" != *Intel* ]] || GPU+="Intel "
        GPU="${GPU% }"; [ -n "$GPU" ] || GPU="?"
    fi
    LAPTOP=0; ! compgen -G '/sys/class/power_supply/BAT*' >/dev/null || LAPTOP=1
    # fingerprint reader: fprintd sees one, or a USB device from a fingerprint vendor (Goodix, Validity, FPC,
    # LighTuning, Synaptics; Elan only when its name says so: it makes touchscreens too)
    FPRINT=0
    if command -v fprintd-list >/dev/null && fprintd-list "$USER" 2>/dev/null | grep -qi 'fingerprints for user\|found'; then
        FPRINT=1
    else
        local d v p
        for d in /sys/bus/usb/devices/*; do
            [ -r "$d/idVendor" ] || continue
            v="$(cat "$d/idVendor")"; p="$(cat "$d/product" 2>/dev/null || true)"
            case "$v" in
                27c6|138a|10a5|1c7a|06cb) FPRINT=1 ;;
                04f3) [[ "${p,,}" != *finger* ]] || FPRINT=1 ;;
            esac
        done
    fi
    HAS_FPRINTD=0; ! command -v fprintd-enroll >/dev/null || HAS_FPRINTD=1
    HANAMI_ON=0; [ ! -L "$DOTS/$HANAMI_HYPR" ] || HANAMI_ON=1
}

# ── screens ──────────────────────────────────────────────────────────────────────────────────────────────────────────

logo() {
    local l lines=(
        '┏━╸╻  ╻ ╻┏━┓╻ ╻'
        '┃╺┓┃  ┗┳┛┣━┛┣━┫'
        '┗━┛┗━╸ ╹ ╹  ╹ ╹'
    )
    echo
    for l in "${lines[@]}"; do
        printf '  %s%s%s\n' "$R" "$l" "$N"
        [ "$TTY" -eq 0 ] || sleep 0.06
    done
    printf '  %s· · ·  un rice Nothing OS para Hyprland%s\n\n' "$D" "$N"
}

welcome() {
    logo
    local yn=(no sí) t
    t="Sistema    $OS"
    [ "$IS_ARCH" -eq 1 ] || t+=" (no es Arch)"
    t+="
GPU        $GPU
Portátil   ${yn[$LAPTOP]}
Huella     ${yn[$FPRINT]}"
    [ "$FPRINT" -eq 0 ] || [ "$HAS_FPRINTD" -eq 1 ] || t+=" (sin fprintd)"
    [ "$HANAMI_ON" -eq 0 ] || t+="
Hanami     activado"
    case "$MODE" in
        full) t+="

Se instalarán los paquetes (pacman y AUR) y los componentes que elijas,
se enlazarán los configs (los anteriores van a ~/.dots-backup-<fecha>/)
y se activarán los servicios y el tema de inicio de sesión." ;;
        links) t+="

Solo enlaces simbólicos (los anteriores van a ~/.dots-backup-<fecha>/)." ;;
        sddm) t+="

Solo el tema de inicio de sesión (sddm, con sudo)." ;;
    esac
    [ "$DRY" -eq 0 ] || t+="
Simulación (--dry-run): se muestra cada acción, no se cambia nada."
    card "$t"
    echo
}

# components → PICK (names), EXT (packages from EXTRA), HANAMI (1 install and enable, 0 leave as is, -1 disable)
pick_components() {
    local w picked names=() parts=()
    if [ "$WITH_SET" -eq 0 ] && [ "$ASK" -eq 1 ]; then
        if [ "$GUM" -eq 1 ]; then
            local opts=() sel=() o selected
            for w in "${COMPONENTS[@]}"; do
                [ "$w" != hanami ] || [ "$NO_HANAMI" -eq 0 ] || continue
                o="$(printf '%-9s %s' "$w" "${DESC[$w]}")"; opts+=("$o")
                if [ "$w" = hanami ] && { [ "$HANAMI_ON" -eq 1 ] || [ -n "$HANAMI_DEB" ] || [ "$HANAMI_BUILD" -eq 1 ]; }; then sel+=("$o"); fi
            done
            selected="$(IFS=,; printf '%s' "${sel[*]-}")"
            picked="$(gum choose --no-limit --height 12 --selected "$selected" \
                --header "Componentes opcionales · espacio marca · enter confirma" "${opts[@]}")" || picked=""
            while read -r w _; do [ -z "$w" ] || names+=("$w"); done <<<"$picked"
        else
            say "¿Qué componentes opcionales añadir? Nombres separados por espacio, Enter para ninguno"
            for w in "${COMPONENTS[@]}"; do printf '    %-9s %s\n' "$w" "${DESC[$w]}"; done
            read -rp "  > " picked || true
            read -ra names <<<"${picked//,/ }"
        fi
    else
        read -ra names <<<"$WITH"
    fi

    PICK=() EXT=() EXT_NAMES=() HANAMI=0
    [ -z "$HANAMI_DEB" ] && [ "$HANAMI_BUILD" -eq 0 ] || HANAMI=1
    for w in "${names[@]+"${names[@]}"}"; do
        if [ "$w" = hanami ]; then HANAMI=1; continue; fi
        [ -n "${EXTRA[$w]-}" ] || die "no such component: $w (available: ${COMPONENTS[*]})" # typed in the plain prompt
        EXT_NAMES+=("$w")
        read -ra parts <<<"${EXTRA[$w]}"; EXT+=("${parts[@]}")
    done
    # unticked in the gum picker (where it starts ticked when on): turn it off
    if [ "$WITH_SET" -eq 0 ] && [ "$GUM" -eq 1 ] && [ "$HANAMI_ON" -eq 1 ] && [ "$HANAMI" -eq 0 ]; then HANAMI=-1; fi
    # --no-hanami always wins
    if [ "$NO_HANAMI" -eq 1 ]; then HANAMI=0; [ "$HANAMI_ON" -eq 0 ] || HANAMI=-1; fi
    PICK=("${EXT_NAMES[@]+"${EXT_NAMES[@]}"}")
    [ "$HANAMI" -ne 1 ] || PICK=(hanami "${PICK[@]+"${PICK[@]}"}")

    if [ "$HANAMI" -eq 1 ] && [ "$FPRINT" -eq 1 ] && [ "$HAS_FPRINTD" -eq 0 ]; then
        confirm "Hay un lector de huellas: ¿instalar fprintd para confirmar los cambios protegidos de Hanami con el dedo?" yes \
            && FPRINT_INSTALL=1
    fi
    confirm "¿Instalar el tema de inicio de sesión (sddm)?" yes || SDDM=0
}

# ── steps (each runs with set -e: the first failing command fails the step) ────────────────────────────────────────

pulse_modules() { # pulseaudio modules need pulseaudio itself, so pacman couldn't replace it with pipewire-pulse.
    # A list, not grep '^pulseaudio-': pulseaudio-alsa and pulseaudio-qt live fine with pipewire
    pacman -Qq pulseaudio-{bluetooth,jack,lirc,rtp,zeroconf,equalizer,equalizer-ladspa} 2>/dev/null || true
}

st_pacman() {
    local pa; pa="$(pulse_modules)"
    # shellcheck disable=SC2086 # one word per package
    [ -z "$pa" ] || x sudo pacman -R --noconfirm $pa
    x sudo pacman -Syu --needed --noconfirm "${PACMAN[@]}"
}

# with pulseaudio installed pacman asks "Remove pulseaudio?" and --noconfirm would answer no, so it runs on screen
st_pacman_interactive() {
    local pa; pa="$(pulse_modules)"
    # shellcheck disable=SC2086 # one word per package
    [ -z "$pa" ] || x sudo pacman -R --noconfirm $pa
    say "pacman preguntará \"Remove pulseaudio?\": responde y, pipewire-pulse lo reemplaza"
    x sudo pacman -Syu --needed "${PACMAN[@]}"
}

st_yay() {
    local tmp="<tmp>"
    [ "$DRY" -eq 1 ] || tmp="$(mktemp -d)"
    x git clone --depth 1 https://aur.archlinux.org/yay-bin.git "$tmp/yay-bin"
    if [ "$DRY" -eq 1 ]; then x cd "$tmp/yay-bin" "&&" makepkg -si --noconfirm
    else (cd "$tmp/yay-bin" && makepkg -si --noconfirm); fi
    x rm -rf "$tmp"
}

# The AUR is optional: a failed package doesn't stop services and links (the step can be continued past)
st_aur() { x yay -S --needed --noconfirm "${AUR[@]}"; }
# separately: if spicetify fails to build, the core AUR packages don't suffer
st_extras() { x yay -S --needed --noconfirm "${EXT[@]}"; }

st_links() {
    local l src dst
    for l in "${LINKS[@]}"; do
        read -r src dst <<<"$l"
        src="$DOTS/$src" dst="$HOME/$dst"
        [ "$(readlink "$dst" 2>/dev/null)" != "$src" ] || continue
        if [ -e "$dst" ] || [ -L "$dst" ]; then
            x mkdir -p "$BACKUP/$(dirname "${dst#"$HOME"/}")"
            x mv "$dst" "$BACKUP/${dst#"$HOME"/}"
        fi
        x mkdir -p "$(dirname "$dst")"
        x ln -s "$src" "$dst"
    done
    # the shell creates rules.json and kitty.conf itself; rice brings up glyph and builds the folder theme
    local state="${XDG_STATE_HOME:-$HOME/.local/state}/rice"
    x mkdir -p "$HOME/.config/demonshot" "$state"
    write_file 0 "$state/shell" $'glyph\n'
    x mkdir -p "$HOME/Pictures/Wallpapers" # the wallpaper picker (Super+Shift+W) looks here
    x fc-cache -f
    command -v gsettings >/dev/null || return 0 # --links on a system without the GNOME schemas
    # dark mode for Zen, Electron and libadwaita (through the portal) and the dark gtk3 base under our gtk.css
    x gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    x gsettings set org.gnome.desktop.interface gtk-theme adw-gtk3-dark
}

st_services() {
    x sudo systemctl enable NetworkManager bluetooth power-profiles-daemon cups.socket
    systemctl is-enabled -q display-manager.service 2>/dev/null || x sudo systemctl enable sddm
    x systemctl --user enable pipewire-pulse.socket wireplumber ydotool
    x sudo usermod -aG input,video "$USER" # ydotool (uinput), brightnessctl
    x xdg-user-dirs-update
    # ThinkPads: the lock screen lights the LED next to the fingerprint reader (tpacpi::power), writable by video
    if [ -e /sys/class/leds/tpacpi::power ]; then
        x sudo install -Dm644 "$DOTS/system/udev/90-thinkpad-power-led.rules" /etc/udev/rules.d/90-thinkpad-power-led.rules
        x sudo udevadm control --reload
        x sudo udevadm trigger --subsystem-match=leds
    fi
}

# Hanami's version: from the .deb's name (Hanami_<version>_amd64.deb), else from its control file
deb_version() {
    local v; v="$(basename "$1")"
    if [[ "$v" =~ _([0-9][^_]*)_amd64\.deb$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; return; fi
    bsdtar -xOf "$1" 'control.tar.*' 2>/dev/null | bsdtar -xOf - ./control control 2>/dev/null \
        | sed -n 's/^Version: *//p' | head -1
}

# Hanami, prebuilt: packaging/hanami-bin/PKGBUILD repacks the fork's release .deb (or the local one) with makepkg
st_hanami_package() {
    local repo ver build="<tmp>"
    repo="$(sed -n 's/^_repo=//p' "$DOTS/$HANAMI_PKGBUILD")"
    # built here, in the same step: each step runs in its own subshell, so HANAMI_DEB can't come from another one
    [ "$HANAMI_BUILD" -eq 0 ] || st_hanami_build || return 1
    if [ -n "$HANAMI_DEB" ]; then
        if [ "$DRY" -eq 1 ] && [ "$HANAMI_BUILD" -eq 1 ]; then
            ver="<version>"
        elif [ "$DRY" -eq 1 ] && [ ! -f "$HANAMI_DEB" ]; then
            echo "    (--dry-run: $HANAMI_DEB doesn't exist; a real install would stop before starting)"
            ver="<version>"
        else
            ver="$(deb_version "$HANAMI_DEB")"
            [ -n "$ver" ] || { echo "can't read the version of $HANAMI_DEB"; return 1; }
        fi
    elif [ "$repo" = OWNER/REPO ]; then
        note "Hanami: aún no hay release publicada (falta OWNER/REPO en $HANAMI_PKGBUILD). Compílalo con ./install.sh --hanami-build o usa --hanami-deb <ruta>; sus atajos ya quedan activados."
        echo "    no release repository yet (OWNER/REPO placeholder): package skipped"
        return 0
    elif [ "$DRY" -eq 1 ]; then
        ver="<latest release of $repo>"
    else
        ver="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r '.tag_name // empty' || true)"
        ver="${ver#v}"
        if [ -z "$ver" ]; then
            note "Hanami: $repo aún no publica una release. Compílalo desde este repo con ./install.sh --hanami-build; sus atajos ya quedan activados."
            echo "    no release found in $repo: package skipped"
            return 0
        fi
    fi
    [ "$DRY" -eq 1 ] || build="$(mktemp -d)"
    x cp "$DOTS/$HANAMI_PKGBUILD" "$build/"
    # a file already named like the source is used as is: makepkg doesn't download it
    [ -z "$HANAMI_DEB" ] || x cp "$HANAMI_DEB" "$build/Hanami_${ver}_amd64.deb"
    if [ "$DRY" -eq 1 ]; then x cd "$build" "&&" HANAMI_VERSION="$ver" makepkg -si --needed --noconfirm
    else (cd "$build" && HANAMI_VERSION="$ver" makepkg -si --needed --noconfirm); fi
    x rm -rf "$build"
}

# Hanami from source: hanami/showcase/tauri/build.sh with only the .deb bundle, which st_hanami_package then
# repacks like a release one. Needs Rust, Node (the sidecar is bundled with esbuild from npm) and tauri-cli 2
st_hanami_build() {
    local src="$DOTS/$HANAMI_SRC" deb pkgs=()
    # only what's missing: rust would conflict with an installed rustup
    command -v cargo >/dev/null || pkgs+=(rust)
    command -v node >/dev/null || pkgs+=(nodejs)
    command -v npm >/dev/null || pkgs+=(npm)
    [ ${#pkgs[@]} -eq 0 ] || x sudo pacman -S --needed --noconfirm "${pkgs[@]}"
    if ! cargo tauri --version >/dev/null 2>&1; then x cargo install tauri-cli --version "^2" --locked; fi
    x npm ci --prefix "$src/sidecar"
    if [ "$DRY" -eq 1 ]; then
        x TAURI_BUNDLES=deb "$src/build.sh"
        HANAMI_DEB="$src/src-tauri/target/release/bundle/deb/Hanami_<version>_amd64.deb"
        return 0
    fi
    TAURI_BUNDLES=deb "$src/build.sh"
    deb="$(ls -t "$src"/src-tauri/target/release/bundle/deb/Hanami_*_amd64.deb 2>/dev/null | head -1)"
    [ -n "$deb" ] || { echo "the build finished without a Hanami_*_amd64.deb"; return 1; }
    HANAMI_DEB="$deb"
}

st_hanami_enable() {
    x ln -sfn hanami.lua "$DOTS/$HANAMI_HYPR"
    x ln -sfn hanami-remote.conf "$DOTS/$HANAMI_KITTY"
    local aec="$HOME/$HANAMI_AEC_DST"
    if [ "$(readlink "$aec" 2>/dev/null)" != "$DOTS/$HANAMI_AEC" ]; then
        if [ -e "$aec" ] || [ -L "$aec" ]; then
            x mkdir -p "$BACKUP/$(dirname "$HANAMI_AEC_DST")"
            x mv "$aec" "$BACKUP/$HANAMI_AEC_DST"
        fi
        x mkdir -p "$(dirname "$aec")"
        x ln -s "$DOTS/$HANAMI_AEC" "$aec"
        note "Hanami: el micrófono con cancelación de eco aparece tras reiniciar PipeWire (systemctl --user restart pipewire) o la sesión; en Hanami → Voz → Dispositivos elige \"Microphone (echo cancelled)\"."
    fi
    # Hyprland reloads when a file it read is saved, not on a new link: ask it
    [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] || x hyprctl reload
}

st_hanami_disable() {
    x rm -f "$DOTS/$HANAMI_HYPR" "$DOTS/$HANAMI_KITTY"
    [ "$(readlink "$HOME/$HANAMI_AEC_DST" 2>/dev/null)" != "$DOTS/$HANAMI_AEC" ] || x rm -f "$HOME/$HANAMI_AEC_DST"
    [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] || x hyprctl reload
}

# glyph-tok from apps/glyph-tok: Qt WebEngine app plus Brave's ad blocker (adblock-rust, built by cargo), installed
# to ~/.local/bin, where user.lua's binds look for it
st_tok() {
    local src="$DOTS/apps/glyph-tok" build="<tmp>"
    command -v cargo >/dev/null || x sudo pacman -S --needed --noconfirm rust
    [ "$DRY" -eq 1 ] || build="$(mktemp -d)"
    x cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$HOME/.local"
    x cmake --build "$build" -j"$(nproc)"
    x cmake --install "$build"
    x rm -rf "$build"
    # the ad-block lists: downloaded once here, glyph-tok rebuilds its engine from them
    x "$HOME/.local/bin/glyph-tok-adblock-update" || note "glyph-tok: no se pudieron bajar las listas de bloqueo; corre glyph-tok-adblock-update luego"
}

st_fprintd() { x sudo pacman -S --needed --noconfirm fprintd; }

# Login theme. A copy, not a link: the sddm user can't read a closed $HOME. fonts in the theme is a link to
# config/fonts; -L copies the files themselves
st_greeter() {
    [ -d /usr/share/sddm/themes ] || { note "sddm no está instalado: tema de inicio de sesión omitido"; return 0; }
    # rm: files deleted from the repo don't linger in the theme; chmod: with umask 077 the copy would be 600 and
    # sddm couldn't read it
    x sudo rm -rf /usr/share/sddm/themes/glyph
    x sudo cp -rLT "$DOTS/config/sddm/glyph" /usr/share/sddm/themes/glyph
    x sudo chmod -R a+rX /usr/share/sddm/themes/glyph
    # the shell's palette (Theme.greeter): this one file is the user's, rewritten whenever the colours change
    x sudo install -o "$USER" -m 644 /dev/null /usr/share/sddm/themes/glyph/theme.conf.user
    # empty InputMethod: sddm's default is qtvirtualkeyboard, and with this theme a full-screen keyboard pops up
    x sudo mkdir -p /etc/sddm.conf.d
    # zz-: conf.d files are read alphabetically and each overrides the previous; ours goes last, over others'
    # (astronaut's virtualkbd.conf)
    write_file 1 /etc/sddm.conf.d/zz-glyph.conf $'[Theme]\nCurrent=glyph\n\n[General]\nInputMethod=\n'
    # /etc/sddm.conf wins over conf.d
    if grep -qsE '^\s*Current=' /etc/sddm.conf && ! grep -qsE '^\s*Current=glyph\s*$' /etc/sddm.conf; then
        note "/etc/sddm.conf fija su propio tema y manda sobre conf.d: pon Current=glyph allí"
    fi
}

# ── step runner ──────────────────────────────────────────────────────────────────────────────────────────────────────

PLAN=() # "critical|foreground|function|title"; foreground=1 runs on screen (it asks), not under a spinner
plan() { PLAN+=("$1|$2|$3|$4"); }

spin() { # spin <title> <function>: runs it in the background into the log, a spinner on screen
    local title="$1" fn="$2" pid rc
    set +e
    ( set -e; "$fn" ) >>"$LOG" 2>&1 </dev/null &
    pid=$!
    if [ "$GUM" -eq 1 ]; then
        gum spin --spinner dot --title "$title" -- bash -c "while kill -0 $pid 2>/dev/null; do sleep 0.1; done"
    elif [ "$TTY" -eq 1 ]; then
        local f='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
        while kill -0 "$pid" 2>/dev/null; do
            printf '\r  %s%s%s %s' "$R" "${f:i%${#f}:1}" "$N" "$title"; i=$((i + 1)); sleep 0.1
        done
        printf '\r\e[K'
    else
        printf '  … %s\n' "$title"
    fi
    wait "$pid"; rc=$?
    set -e
    return "$rc"
}

foreground() { # foreground <function>: on screen (it may ask) and into the log
    local rc
    set +e
    ( set -e; "$1" ) 2>&1 | tee -a "$LOG"; rc=${PIPESTATUS[0]}
    set -e
    return "$rc"
}

run_plan() {
    local i=0 n=${#PLAN[@]} p crit fg fn title label choice rc
    for p in "${PLAN[@]}"; do
        i=$((i + 1)); IFS='|' read -r crit fg fn title <<<"$p"
        label="[$i/$n] $title"
        if [ "$DRY" -eq 1 ]; then printf '%s●%s %s%s%s\n' "$R" "$N" "$B" "$label" "$N"; "$fn"; continue; fi
        printf '\n=== %s ===\n' "$label" >>"$LOG"
        while :; do
            rc=0
            if [ "$fg" = 1 ]; then say "$label"; foreground "$fn" || rc=$?
            else spin "$label" "$fn" || rc=$?; fi
            if [ "$rc" -eq 0 ]; then printf '  %s✓%s %s\n' "$R" "$N" "$label"; break; fi
            printf '  %s✗ %s%s  (código %s)\n' "$R" "$label" "$N" "$rc"
            tail -n 12 "$LOG" | sed "s/^/    ${D}│${N} /"
            if [ "$ASK" -eq 1 ]; then
                if [ "$GUM" -eq 1 ]; then
                    choice="$(gum choose --header "Falló: $title" "Reintentar en pantalla" "Continuar" "Abortar")" || choice=Abortar
                else
                    read -rp "  ¿[r]eintentar en pantalla, [c]ontinuar o [a]bortar? " choice || choice=a
                    case "${choice,,}" in r*) choice="Reintentar en pantalla" ;; c*) choice=Continuar ;; *) choice=Abortar ;; esac
                fi
            elif [ "$crit" = 1 ]; then choice=Abortar
            else choice=Continuar
            fi
            case "$choice" in
                Reintentar*) fg=1 ;;
                Continuar) note "Falló: $title (detalles en el log)"; break ;;
                *) printf '\n  Abortado. Log completo: %s\n' "$LOG"; exit 1 ;;
            esac
        done
    done
}

need_sudo() { # one password up front, kept fresh while the steps run (a spinner can't show sudo's prompt)
    say "sudo: la contraseña se pide una vez para todos los pasos"
    sudo -v || die "sudo failed"
    ( while kill -0 $$ 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done ) &
    KEEPALIVE=$!
}

summary() {
    local t l
    if [ "$DRY" -eq 1 ]; then t="Simulación terminada: no se cambió nada."; else t="Listo."; fi
    if [ "$MODE" = full ]; then
        t+="

Siguientes pasos
  · Reinicia y elige Hyprland en sddm"
        if [ "$HANAMI" -eq 1 ]; then
            t+="
  · Hanami: Ctrl+Alt+Espacio para hablarle · mantén Ctrl+Alt+D para dictar
  · En el panel de Hanami, inicia sesión con Claude
  · La primera vez descarga los modelos de voz (~1 GB)"
            [ "$FPRINT_INSTALL" -eq 0 ] || t+="
  · Registra tu huella: fprintd-enroll"
        fi
        [ "$HANAMI" -ne -1 ] || t+="
  · Hanami desactivado (enlaces quitados; el paquete sigue instalado)"
        [[ " ${PICK[*]-} " != *" spotify "* ]] || t+="
  · Spotify: ábrelo, inicia sesión y luego
    spicetify config custom_apps marketplace && spicetify backup apply"
    fi
    if [ -s "$NOTES" ]; then
        t+="

Avisos"
        while IFS= read -r l; do t+="
  · $l"; done <"$NOTES"
    fi
    if [ "$DRY" -eq 0 ]; then
        [ ! -d "$BACKUP" ] || t+="

Configs anteriores: $BACKUP"
        t+="
Log: $LOG"
    fi
    echo
    card "$t"
}

# ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

main() {
    parse_args "$@"
    [ "$EUID" -ne 0 ] || die "run as your user, not root: sudo asks when it needs to"
    setup_ui

    # gum for the animated UI: offered before anything else, with a plain question
    if [ "$ASK" -eq 1 ] && ! command -v gum >/dev/null && command -v pacman >/dev/null; then
        if [ "$DRY" -eq 1 ]; then
            dim "  (--dry-run: gum no está instalado; se ofrecería instalarlo con sudo pacman -S gum)"
        elif confirm "El instalador usa gum para su interfaz animada. ¿Instalarlo ahora (sudo pacman -S gum)?" yes; then
            if sudo pacman -S --needed --noconfirm gum; then GUM=1; fi
        fi
    fi

    local w names=()
    read -ra names <<<"$WITH"
    for w in "${names[@]+"${names[@]}"}"; do
        [ "$w" = hanami ] || [ -n "${EXTRA[$w]-}" ] || die "no such component: $w (available: ${COMPONENTS[*]})"
    done
    detect
    [ "$MODE" != full ] || [ "$IS_ARCH" -eq 1 ] || [ "$DRY" -eq 1 ] \
        || die "packages install on Arch only; on another distro: $0 --links"
    if [ -n "$HANAMI_DEB" ] && [ "$DRY" -eq 0 ] && [ "$MODE" = full ]; then
        [ -f "$HANAMI_DEB" ] || die "--hanami-deb: no such file: $HANAMI_DEB"
        HANAMI_DEB="$(realpath "$HANAMI_DEB")"
    fi

    welcome
    PICK=() EXT=() EXT_NAMES=() HANAMI=0 FPRINT_INSTALL=0 SDDM=1
    case "$MODE" in
        links) plan 0 0 st_links "Enlaces simbólicos" ;;
        sddm) plan 1 0 st_greeter "Tema de inicio de sesión (sddm)" ;;
        full)
            pick_components
            if pacman -Q pulseaudio &>/dev/null; then plan 1 1 st_pacman_interactive "Paquetes (pacman)"
            else plan 1 0 st_pacman "Paquetes (pacman)"; fi
            command -v yay >/dev/null || plan 1 0 st_yay "yay (ayudante del AUR)"
            plan 0 0 st_aur "Paquetes del AUR"
            [ ${#EXT[@]} -eq 0 ] || plan 0 0 st_extras "Componentes: ${EXT_NAMES[*]}"
            [[ " ${EXT_NAMES[*]-} " != *" tok "* ]] || plan 0 0 st_tok "glyph-tok (compilación)"
            plan 1 0 st_links "Enlaces simbólicos"
            plan 0 0 st_services "Servicios"
            if [ "$HANAMI" -eq 1 ]; then
                plan 0 0 st_hanami_package "Hanami: paquete"
                plan 0 0 st_hanami_enable "Hanami: atajos, control de kitty y micrófono"
                [ "$FPRINT_INSTALL" -eq 0 ] || plan 0 0 st_fprintd "Hanami: lector de huellas (fprintd)"
            elif [ "$HANAMI" -eq -1 ]; then
                plan 0 0 st_hanami_disable "Hanami: desactivar"
            fi
            [ "$SDDM" -eq 0 ] || plan 0 0 st_greeter "Tema de inicio de sesión (sddm)"
            ;;
    esac

    local p t
    say "Plan"
    for p in "${PLAN[@]}"; do IFS='|' read -r _ _ _ t <<<"$p"; printf '    · %s\n' "$t"; done
    echo
    if [ "$DRY" -eq 0 ]; then
        [ "$MODE" != full ] || confirm "¿Empezar?" yes || { echo "  Nada cambiado."; exit 0; }
        mkdir -p "$(dirname "$LOG")"; : >"$LOG"
        dim "  Log: $LOG"
        [ "$MODE" = links ] || need_sudo
    fi
    run_plan
    summary
}

main "$@"
