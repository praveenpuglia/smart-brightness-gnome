#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="smart-brightness@local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "=== Smart Brightness — Install ==="
echo

# 1. Dependencies
echo "[1/5] Installing dependencies..."
if command -v apt >/dev/null 2>&1; then
    sudo apt install -y ddcutil
elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y ddcutil
else
    echo "Error: neither apt nor dnf found. Install ddcutil manually and re-run." >&2
    exit 1
fi

# 2. Create i2c group if missing
if ! getent group i2c >/dev/null; then
    echo "[2/5] Creating i2c group..."
    sudo groupadd --system i2c
else
    echo "[2/5] i2c group already exists."
fi

# 3. Add user to i2c group
if ! groups "$USER" | grep -qw i2c; then
    echo "[3/5] Adding $USER to the i2c group..."
    sudo usermod -aG i2c "$USER"
    echo "      You MUST log out and back in for this to take effect."
else
    echo "[3/5] Already in i2c group."
fi

# 4. Disable kernel ACPI brightness handling (so keys reach GNOME)
MODPROBE_CONF="/etc/modprobe.d/brightness.conf"
if [ ! -f "$MODPROBE_CONF" ]; then
    echo "[4/5] Disabling kernel ACPI brightness switch..."
    echo 'options video brightness_switch_enabled=0' | sudo tee "$MODPROBE_CONF" > /dev/null
    echo 0 | sudo tee /sys/module/video/parameters/brightness_switch_enabled > /dev/null 2>&1 || true
else
    echo "[4/5] ACPI brightness switch already configured."
fi

# 5. Install extension
echo "[5/5] Installing GNOME Shell extension..."
mkdir -p "$EXT_DIR"
cp extension.js metadata.json "$EXT_DIR/"

# Enable the extension
gnome-extensions enable "$EXT_UUID" 2>/dev/null || \
    gsettings set org.gnome.shell enabled-extensions \
        "$(gsettings get org.gnome.shell enabled-extensions | sed "s/]/, '$EXT_UUID']/")"

echo
echo "=== Done ==="
echo "Log out and back in to activate the extension."
echo "Then press your brightness keys — they'll route to whichever"
echo "monitor has your focused window."
