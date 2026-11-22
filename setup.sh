#!/usr/bin/env bash
# sajra-rice in one command: clones the repo (or updates the clone already there), then runs its installer.
#   curl -fsSL https://raw.githubusercontent.com/cbranty/sajra-rice/main/setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/cbranty/sajra-rice/main/setup.sh | bash -s -- --with hanami tok
# Everything after -- goes to install.sh as is (see ./install.sh --help). The installer links the configs into the
# clone, so the clone stays: by default in ~/.local/share/sajra-rice.
#   SAJRA_DIR     where the clone lives          (default ~/.local/share/sajra-rice)
#   SAJRA_REPO    the git URL to clone           (default https://github.com/cbranty/sajra-rice.git)
#   SAJRA_BRANCH  the branch to clone and follow (default main)
# The whole script is inside main(), run on the last line: if curl stops halfway, bash runs nothing.
set -euo pipefail

main() {
    local repo="${SAJRA_REPO:-https://github.com/cbranty/sajra-rice.git}"
    local branch="${SAJRA_BRANCH:-main}"
    local dir="${SAJRA_DIR:-$HOME/.local/share/sajra-rice}"

    [ "$EUID" -ne 0 ] || die "run it as your user, not root: sudo asks when it needs to"

    if ! command -v git >/dev/null; then
        command -v pacman >/dev/null || die "git is missing: install it and run this again"
        say "Instalando git"
        sudo pacman -S --needed --noconfirm git
    fi

    if [ -d "$dir/.git" ]; then
        say "Actualizando $dir"
        git -C "$dir" pull --ff-only origin "$branch" \
            || die "$dir has local changes or diverged from $branch: sort it out with git, then run this again"
    elif [ -e "$dir" ]; then
        die "$dir exists and isn't a git clone: move it away or pick another place with SAJRA_DIR"
    else
        say "Clonando sajra-rice en $dir"
        mkdir -p "$(dirname "$dir")"
        git clone --depth 1 --branch "$branch" "$repo" "$dir"
    fi

    say "Ejecutando el instalador"
    # Under `curl | bash` stdin is the script itself, not the keyboard: hand the installer the terminal so gum and
    # its questions work. No terminal (CI, ssh without -t): it runs as is and asks nothing, like --yes.
    if (exec </dev/tty) 2>/dev/null; then
        exec "$dir/install.sh" "$@" </dev/tty
    fi
    exec "$dir/install.sh" "$@" </dev/null
}

say() { printf '\e[38;2;130;99;170m●\e[0m %s\n' "$*"; }
die() { printf 'setup.sh: %s\n' "$*" >&2; exit 1; }

main "$@"
