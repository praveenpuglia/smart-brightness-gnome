#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="smart-brightness@local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "=== Smart Brightness — Install ==="
echo

# 1. Dependencies
echo "[1/4] Installing dependencies..."
sudo apt install -y ddcutil

# 2. i2c group
if ! groups "$USER" | grep -qw i2c; then
    echo "[2/4] Adding $USER to the i2c group..."
    sudo usermod -aG i2c "$USER"
    echo "      You MUST log out and back in for this to take effect."
else
    echo "[2/4] Already in i2c group."
fi

# 3. Disable kernel ACPI brightness handling (so keys reach GNOME)
MODPROBE_CONF="/etc/modprobe.d/brightness.conf"
if [ ! -f "$MODPROBE_CONF" ]; then
    echo "[3/4] Disabling kernel ACPI brightness switch..."
    echo 'options video brightness_switch_enabled=0' | sudo tee "$MODPROBE_CONF" > /dev/null
    echo 0 | sudo tee /sys/module/video/parameters/brightness_switch_enabled > /dev/null 2>&1 || true
else
    echo "[3/4] ACPI brightness switch already configured."
fi

# 4. Install extension
echo "[4/4] Installing GNOME Shell extension..."
mkdir -p "$EXT_DIR"
cp extension.js metadata.json "$EXT_DIR/"

# Enable the extension.
#
# The global "user extensions" switch overrides enabled-extensions entirely.
# If it is on, the extension installs and loads but enable() is never called,
# leaving it stuck in State: INITIALIZED with no error anywhere.
if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = "true" ]; then
    echo "      User extensions are globally disabled — enabling them."
    gsettings set org.gnome.shell disable-user-extensions false
fi

gnome-extensions enable "$EXT_UUID"

echo
echo "=== Done ==="
echo "Log out and back in to activate the extension."
echo "Then press your brightness keys — they'll route to whichever"
echo "monitor has your focused window."
