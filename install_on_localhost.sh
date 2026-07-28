#!/usr/bin/env sh
set -eu

porterminal_installer_source=$0
case "$porterminal_installer_source" in
    */*) ;;
    *)
        porterminal_installer_source=$(command -v "$porterminal_installer_source")
        ;;
esac

while [ -L "$porterminal_installer_source" ]; do
    porterminal_installer_link_dir=$(
        CDPATH= cd -P -- "$(dirname -- "$porterminal_installer_source")" && pwd
    )
    porterminal_installer_link_target=$(readlink "$porterminal_installer_source")
    case "$porterminal_installer_link_target" in
        /*)
            porterminal_installer_source=$porterminal_installer_link_target
            ;;
        *)
            porterminal_installer_source=$(
                printf '%s/%s\n' \
                    "$porterminal_installer_link_dir" \
                    "$porterminal_installer_link_target"
            )
            ;;
    esac
done

porterminal_repo_dir=$(
    CDPATH= cd -P -- "$(dirname -- "$porterminal_installer_source")" && pwd
)
porterminal_launcher=$porterminal_repo_dir/run_on_localhost.sh
porterminal_bin_dir=${PORTERMINAL_BIN_DIR:-"$HOME/.local/bin"}
porterminal_command_name=${PORTERMINAL_COMMAND_NAME:-porterminal}

porterminal_installer_usage() {
    cat <<EOF
Usage: ./install_on_localhost.sh [BIN_DIR]
       ./install_on_localhost.sh [--bin-dir BIN_DIR] [--name COMMAND]

Installs the localhost launcher as a symlink in a directory intended to be on
PATH. The default installation is:

  $HOME/.local/bin/porterminal -> $porterminal_launcher

Options:
  --bin-dir DIR  Directory in which to create the symlink
  --name NAME    Installed command name (default: porterminal)
  -h, --help     Show this help

Environment:
  PORTERMINAL_BIN_DIR       Default bin directory
  PORTERMINAL_COMMAND_NAME  Default installed command name
EOF
}

porterminal_positional_bin_dir_seen=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --bin-dir)
            if [ "$#" -lt 2 ]; then
                echo "Missing value for --bin-dir" >&2
                exit 1
            fi
            porterminal_bin_dir=$2
            porterminal_positional_bin_dir_seen=1
            shift 2
            ;;
        --name)
            if [ "$#" -lt 2 ]; then
                echo "Missing value for --name" >&2
                exit 1
            fi
            porterminal_command_name=$2
            shift 2
            ;;
        -h|--help)
            porterminal_installer_usage
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            porterminal_installer_usage >&2
            exit 1
            ;;
        *)
            if [ "$porterminal_positional_bin_dir_seen" = "1" ]; then
                echo "Only one bin directory may be specified" >&2
                exit 1
            fi
            porterminal_bin_dir=$1
            porterminal_positional_bin_dir_seen=1
            shift
            ;;
    esac
done

if [ -z "$porterminal_bin_dir" ]; then
    echo "Bin directory must not be empty" >&2
    exit 1
fi

case "$porterminal_command_name" in
    ""|*/*)
        echo "Command name must be a non-empty filename without '/'" >&2
        exit 1
        ;;
esac

if [ ! -x "$porterminal_launcher" ]; then
    echo "Launcher is missing or not executable: $porterminal_launcher" >&2
    exit 1
fi

if [ -e "$porterminal_bin_dir" ] && [ ! -d "$porterminal_bin_dir" ]; then
    echo "Install path exists but is not a directory: $porterminal_bin_dir" >&2
    exit 1
fi

if ! mkdir -p "$porterminal_bin_dir"; then
    echo "Could not create install directory: $porterminal_bin_dir" >&2
    exit 1
fi

porterminal_bin_dir=$(CDPATH= cd -P -- "$porterminal_bin_dir" && pwd)

if [ ! -w "$porterminal_bin_dir" ]; then
    echo "Install directory is not writable: $porterminal_bin_dir" >&2
    exit 1
fi

porterminal_link_path=$porterminal_bin_dir/$porterminal_command_name

if [ -e "$porterminal_link_path" ] || [ -L "$porterminal_link_path" ]; then
    if [ "$porterminal_link_path" -ef "$porterminal_launcher" ]; then
        echo "Already installed: $porterminal_link_path"
    else
        echo "Refusing to replace existing path: $porterminal_link_path" >&2
        exit 1
    fi
else
    ln -s "$porterminal_launcher" "$porterminal_link_path"
    echo "Installed: $porterminal_link_path -> $porterminal_launcher"
fi

case ":${PATH:-}:" in
    *":$porterminal_bin_dir:"*)
        echo "Run: $porterminal_command_name"
        ;;
    *)
        echo "Warning: install directory is not on PATH: $porterminal_bin_dir" >&2
        echo "Add it to PATH before running: $porterminal_command_name" >&2
        ;;
esac
