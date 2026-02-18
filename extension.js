import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ── Configuration ──────────────────────────────────────────────────
// The connector name for the built-in laptop display.
// Run `ddcutil detect` or check GNOME Display settings to find yours.
const BUILTIN_CONNECTOR = 'eDP-1';

// Brightness step per keypress (0-100 scale).
const DDC_STEP = 5;

// Debounce interval in ms — rapid keypresses are coalesced into a
// single DDC write to avoid flooding the slow I2C bus.
const DEBOUNCE_MS = 150;

// ddcutil sleep multiplier for writes. Lower = faster but may cause
// DDCRC_NULL_RESPONSE errors. 0.5 is a safe default; try 0.3 if your
// monitor handles it.
const DDC_SLEEP_MULTIPLIER = '0.5';
// ───────────────────────────────────────────────────────────────────

export default class SmartBrightnessExtension extends Extension {
    enable() {
        this._lastBrightness = -1;
        this._reverting = false;
        this._pendingDelta = 0;
        this._debounceId = null;
        this._ddcRunning = false;
        this._ddcBus = null;
        this._ddcBrightness = -1;
        this._externalMonitorIndex = -1;

        const monitorManager = global.backend.get_monitor_manager();
        this._builtinMonitorIndex = monitorManager.get_monitor_for_connector(BUILTIN_CONNECTOR);
        this._updateExternalIndex();

        // Re-detect monitors on hotplug (dock/undock)
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            const mgr = global.backend.get_monitor_manager();
            this._builtinMonitorIndex = mgr.get_monitor_for_connector(BUILTIN_CONNECTOR);
            this._updateExternalIndex();
            this._ddcBus = null;
            this._ddcBrightness = -1;
            this._detectBus();
        });

        // Auto-detect the I2C bus for the external DDC monitor
        this._detectBus();

        // Listen for brightness changes from gsd-power via D-Bus.
        // Using signal_subscribe (not Gio.DBusProxy) so it works even
        // if gsd-power starts after the extension.
        this._signalId = Gio.DBus.session.signal_subscribe(
            'org.gnome.SettingsDaemon.Power',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/gnome/SettingsDaemon/Power',
            'org.gnome.SettingsDaemon.Power.Screen',
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                this._onBrightnessChanged(params);
            });

        log('[SmartBrightness] Enabled');
    }

    _updateExternalIndex() {
        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            if (i !== this._builtinMonitorIndex) {
                this._externalMonitorIndex = i;
                return;
            }
        }
        this._externalMonitorIndex = -1;
    }

    // ── DDC bus detection ──────────────────────────────────────────

    _detectBus() {
        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', 'detect', '--brief'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            proc.wait_async(null, (proc_, result) => {
                try {
                    proc_.wait_finish(result);
                    const [, stdout] = proc_.communicate_utf8(null, null);
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        const match = line.match(/I2C bus:\s+\/dev\/i2c-(\d+)/);
                        if (match) {
                            const idx = lines.indexOf(line);
                            const context = lines.slice(Math.max(0, idx - 2), idx + 5).join(' ');
                            if (!context.includes('eDP') && !context.includes('Invalid')) {
                                this._ddcBus = match[1];
                                log(`[SmartBrightness] DDC bus: ${this._ddcBus}`);
                                this._readDDCBrightness();
                                return;
                            }
                        }
                    }
                    log('[SmartBrightness] No DDC display found');
                } catch (e) {
                    logError(e, 'SmartBrightness detect');
                }
            });
        } catch (e) {
            logError(e, 'SmartBrightness detect');
        }
    }

    // ── Read current DDC brightness (for accurate OSD) ─────────────

    _readDDCBrightness() {
        if (!this._ddcBus) return;
        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', '--bus', this._ddcBus, '--sleep-multiplier', '0.1',
                 '--terse', 'getvcp', '10'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            proc.wait_async(null, (proc_, result) => {
                try {
                    proc_.wait_finish(result);
                    const [, stdout] = proc_.communicate_utf8(null, null);
                    // Terse format: VCP 10 C <current> <max>
                    const match = stdout.match(/VCP\s+10\s+C\s+(\d+)\s+(\d+)/);
                    if (match) {
                        this._ddcBrightness = parseInt(match[1]);
                        log(`[SmartBrightness] DDC brightness: ${this._ddcBrightness}`);
                    }
                } catch (e) {
                    logError(e, 'SmartBrightness read');
                }
            });
        } catch (e) {
            logError(e, 'SmartBrightness read');
        }
    }

    // ── OSD ────────────────────────────────────────────────────────

    _showOSD(monitorIndex, level) {
        const icon = Gio.ThemedIcon.new_with_default_fallbacks('display-brightness-symbolic');
        Main.osdWindowManager.show(monitorIndex, icon, null, level / 100);
    }

    // ── Brightness change handler ──────────────────────────────────

    _onBrightnessChanged(params) {
        // Ignore signals triggered by our own revert
        if (this._reverting)
            return;

        const [iface_, changed, invalidated_] = params.recursiveUnpack();
        if (!('Brightness' in changed))
            return;

        const newVal = changed['Brightness'];
        const oldVal = this._lastBrightness;
        this._lastBrightness = newVal;

        if (oldVal < 0 || newVal === oldVal)
            return;

        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return;

        const monitorIndex = focusWindow.get_monitor();

        // If focused on the built-in display, let gsd-power handle it
        if (monitorIndex === this._builtinMonitorIndex)
            return;

        const step = newVal > oldVal ? DDC_STEP : -DDC_STEP;

        // Revert the built-in backlight change (async)
        this._reverting = true;
        Gio.DBus.session.call(
            'org.gnome.SettingsDaemon.Power',
            '/org/gnome/SettingsDaemon/Power',
            'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', [
                'org.gnome.SettingsDaemon.Power.Screen',
                'Brightness',
                GLib.Variant.new_int32(oldVal),
            ]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            () => {
                this._lastBrightness = oldVal;
                this._reverting = false;
            });

        // Show OSD immediately on the external monitor with predicted value
        if (this._ddcBrightness >= 0) {
            this._ddcBrightness = Math.max(0, Math.min(100, this._ddcBrightness + step));
            this._showOSD(this._externalMonitorIndex, this._ddcBrightness);
        }

        // Accumulate delta and debounce to avoid flooding the I2C bus
        this._pendingDelta += step;

        if (this._debounceId !== null)
            GLib.source_remove(this._debounceId);

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._flushDDC();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── DDC write (serialized, one at a time) ──────────────────────

    _flushDDC() {
        const delta = this._pendingDelta;
        this._pendingDelta = 0;

        if (delta === 0 || this._ddcRunning || !this._ddcBus)
            return;

        const sign = delta > 0 ? '+' : '-';
        const amount = String(Math.abs(delta));

        log(`[SmartBrightness] DDC bus ${this._ddcBus}: setvcp 10 ${sign} ${amount}`);
        this._ddcRunning = true;

        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', '--bus', this._ddcBus,
                 '--sleep-multiplier', DDC_SLEEP_MULTIPLIER,
                 'setvcp', '10', sign, amount],
                Gio.SubprocessFlags.NONE);

            proc.wait_async(null, (proc_, result) => {
                try {
                    proc_.wait_finish(result);
                    if (!proc_.get_successful())
                        log('[SmartBrightness] ddcutil exited with error');
                } catch (e) {
                    logError(e, 'SmartBrightness ddcutil');
                }
                this._ddcRunning = false;
                // Drain any deltas that accumulated while this write ran
                if (this._pendingDelta !== 0)
                    this._flushDDC();
            });
        } catch (e) {
            logError(e, 'SmartBrightness ddcutil');
            this._ddcRunning = false;
        }
    }

    // ── Cleanup ────────────────────────────────────────────────────

    disable() {
        if (this._signalId) {
            Gio.DBus.session.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._debounceId !== null) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        log('[SmartBrightness] Disabled');
    }
}
