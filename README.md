# Smart Brightness for GNOME

A GNOME Shell extension that routes brightness keys to the correct monitor based on which window is focused.

- **Focused on external monitor** — brightness keys adjust the external display via DDC/CI (`ddcutil`)
- **Focused on built-in display** — brightness keys work as usual (backlight)

## Requirements

- GNOME Shell 46 (Ubuntu 24.04 LTS)
- An external monitor that supports DDC/CI (most modern monitors do)
- `ddcutil` — DDC/CI control tool

## Install

```sh
chmod +x install.sh
./install.sh
```

Then **log out and back in**.

## Uninstall

```sh
chmod +x uninstall.sh
./uninstall.sh
```

## Configuration

Edit the constants at the top of `extension.js`:

| Constant | Default | Description |
|---|---|---|
| `BUILTIN_CONNECTOR` | `eDP-1` | Connector name of the laptop's built-in display. Find yours with `ddcutil detect`. |
| `DDC_STEP` | `5` | Brightness change per keypress (0-100 scale). |
| `DEBOUNCE_MS` | `150` | Milliseconds to wait before sending DDC command. Coalesces rapid keypresses. |
| `DDC_SLEEP_MULTIPLIER` | `0.5` | ddcutil I2C timing. Lower = faster but may cause write errors. |

## How it works

1. `gsd-power` (GNOME's power daemon) handles brightness keys and adjusts the built-in backlight
2. This extension monitors those brightness changes via D-Bus (`org.gnome.SettingsDaemon.Power.Screen`)
3. When a change is detected and the focused window is on the **external** monitor:
   - The built-in backlight change is **reverted** (set back to its previous value)
   - The external monitor brightness is adjusted via **DDC/CI** (`ddcutil setvcp 10`)
   - An **OSD** (on-screen brightness indicator) is shown on the external monitor
4. When focused on the built-in display, brightness keys work normally

The I2C bus number for the external monitor is **auto-detected** at startup (it can change across reboots).

## Debugging

```sh
# Check extension status
gnome-extensions show smart-brightness@local

# View logs
journalctl -b _COMM=gnome-shell | grep SmartBrightness

# Test ddcutil manually
ddcutil detect
ddcutil --bus <N> getvcp 10         # read brightness
ddcutil --bus <N> setvcp 10 50      # set to 50%
```

## Caveats

- **DDC/CI is slow.** The I2C protocol has inherent latency (~0.5s per write). There's a small delay between pressing the key and the monitor actually changing. The OSD appears instantly, but the physical brightness change lags slightly.

- **I2C bus number is not stable.** It changes across reboots and when monitors are plugged/unplugged. The extension auto-detects it on startup and on monitor hotplug events.

- **`ddcutil` sleep multiplier tuning.** The default of `0.5` is conservative. Some monitors work fine with `0.3` (faster). If you get `DDCRC_NULL_RESPONSE` errors in the logs, increase it. If it feels too slow, try lowering it.

- **ACPI brightness switch.** On many Intel laptops, the kernel's ACPI subsystem intercepts brightness keys before they reach GNOME. The install script disables this via `/etc/modprobe.d/brightness.conf` (`brightness_switch_enabled=0`). The uninstall script restores it.

- **Single external monitor.** The extension currently picks the first non-eDP DDC monitor it finds. Multi-external-monitor setups are not handled.

- **GNOME 46 only.** Uses ESM imports and Mutter 14 APIs. Other GNOME versions will need `shell-version` and potentially API adjustments.

## License

MIT
