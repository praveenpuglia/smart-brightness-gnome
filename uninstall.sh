#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="smart-brightness@local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "=== Smart Brightness — Uninstall ==="
echo

# Disable extension
gnome-extensions disable "$EXT_UUID" 2>/dev/null || true

# Remove extension files
if [ -d "$EXT_DIR" ]; then
    rm -rf "$EXT_DIR"
    echo "Removed $EXT_DIR"
fi

# Restore ACPI brightness switch
MODPROBE_CONF="/etc/modprobe.d/brightness.conf"
if [ -f "$MODPROBE_CONF" ]; then
    echo "Restoring ACPI brightness switch..."
    sudo rm "$MODPROBE_CONF"
    echo 1 | sudo tee /sys/module/video/parameters/brightness_switch_enabled > /dev/null 2>&1 || true
fi

echo
echo "Done. Log out and back in to complete removal."
