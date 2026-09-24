# Smart Brightness for GNOME

A GNOME Shell extension that routes brightness keys to the correct monitor based on which display the pointer is on.

- **Pointer on an external monitor** — brightness keys adjust that display via DDC/CI (`ddcutil`)
- **Pointer on the built-in display** — brightness keys work as usual (backlight)
- **Multiple external monitors** — each DDC-capable display is controlled independently

## Requirements

- GNOME Shell 49 or 50 (e.g. Fedora 43/44)
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

1. GNOME Shell's `BrightnessManager` (since GNOME 49) handles brightness keys for displays with a `Meta.Backlight` (typically the laptop panel)
2. This extension intercepts the Shell brightness key handlers (`screen-brightness-up` / `down` / `cycle`, and the per-monitor variants)
3. When the pointer is on an **external** DDC/CI monitor:
   - The built-in backlight is left unchanged
   - That monitor's brightness is adjusted via **DDC/CI** (`ddcutil setvcp 10`)
   - An **OSD** is shown on that monitor via `OsdWindowManager.showOne()`
4. When the pointer is on the built-in display, brightness keys work normally through `BrightnessManager`

All DDC-capable external monitors are **auto-detected** at startup (I2C bus numbers can change across reboots).

## Debugging

```sh
# Check extension status — it must say ENABLED.
#
# INITIALIZED means the extension loaded but enable() never ran. The usual
# cause is the global user-extensions switch, which silently overrides
# enabled-extensions:
#   gsettings get org.gnome.shell disable-user-extensions   # must be false
#
# OUT OF DATE means shell-version in metadata.json does not cover your
# GNOME Shell. gnome-extensions enable refuses to enable it in that state.
gnome-extensions info smart-brightness@local

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

- **GNOME 49+ only.** Relies on `Main.brightnessManager` and the GNOME 49+ OSD API (`showOne`). GNOME 46–48 need the older `gsd-power` integration.

- **Logitech MX Keys brightness keys.** With **Set OS** = Windows, Fn brightness keys often emit no keycodes under Linux. Prefer keeping Windows (so modifiers stay correct) and in [Solaar](https://pwr-solaar.github.io/Solaar/) set **Key/Button Diversion** → Brightness Up/Down to **Diverted**. Solaar’s built-in rules then emit `XF86MonBrightnessUp`/`Down` (Solaar must be running; on Wayland it needs write access to `/dev/uinput`). Avoid **Set OS** = MacOS unless you want Mac-style modifier swapping (Opt/Win ↔ Cmd/Alt).

## License

MIT
