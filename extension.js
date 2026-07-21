import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ── Configuration ──────────────────────────────────────────────────
const BUILTIN_CONNECTOR = 'eDP-1';
const DDC_STEP = 5;
const DEBOUNCE_MS = 150;
const DDC_SLEEP_MULTIPLIER = '0.5';
// ───────────────────────────────────────────────────────────────────

export default class SmartBrightnessExtension extends Extension {
    enable() {
        this._pendingDelta = 0;
        this._debounceId = null;
        this._ddcRunning = false;
        this._ddcBus = null;
        this._ddcBrightness = -1;
        this._externalMonitorIndex = -1;

        const monitorManager = global.backend.get_monitor_manager();
        this._builtinMonitorIndex = monitorManager.get_monitor_for_connector(BUILTIN_CONNECTOR);
        this._updateExternalIndex();

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            const mgr = global.backend.get_monitor_manager();
            this._builtinMonitorIndex = mgr.get_monitor_for_connector(BUILTIN_CONNECTOR);
            this._updateExternalIndex();
            this._ddcBus = null;
            this._ddcBrightness = -1;
            this._detectBus();
        });

        this._detectBus();
        this._patchBrightnessManager();

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

    _focusOnExternal() {
        const focusWindow = global.display.focus_window;
        if (!focusWindow)
            return false;
        return focusWindow.get_monitor() !== this._builtinMonitorIndex;
    }

    // ── BrightnessManager integration (GNOME 49+) ──────────────────

    _patchBrightnessManager() {
        const bm = Main.brightnessManager;
        if (!bm) {
            log('[SmartBrightness] Main.brightnessManager unavailable');
            return;
        }

        this._brightnessManager = bm;
        this._origScreenBrightnessUp = bm._screenBrightnessUp.bind(bm);
        this._origScreenBrightnessDown = bm._screenBrightnessDown.bind(bm);
        this._origScreenBrightnessCycle = bm._screenBrightnessCycle.bind(bm);

        bm._screenBrightnessUp = () => {
            this._handleBrightnessKey(DDC_STEP, this._origScreenBrightnessUp);
        };
        bm._screenBrightnessDown = () => {
            this._handleBrightnessKey(-DDC_STEP, this._origScreenBrightnessDown);
        };
        bm._screenBrightnessCycle = () => {
            this._handleBrightnessKey(DDC_STEP, this._origScreenBrightnessCycle);
        };
    }

    _unpatchBrightnessManager() {
        const bm = this._brightnessManager;
        if (!bm)
            return;

        if (this._origScreenBrightnessUp)
            bm._screenBrightnessUp = this._origScreenBrightnessUp;
        if (this._origScreenBrightnessDown)
            bm._screenBrightnessDown = this._origScreenBrightnessDown;
        if (this._origScreenBrightnessCycle)
            bm._screenBrightnessCycle = this._origScreenBrightnessCycle;

        this._origScreenBrightnessUp = null;
        this._origScreenBrightnessDown = null;
        this._origScreenBrightnessCycle = null;
        this._brightnessManager = null;
    }

    _handleBrightnessKey(step, fallback) {
        if (!this._ddcBus || !this._focusOnExternal()) {
            fallback();
            return;
        }

        if (this._ddcBrightness >= 0) {
            this._ddcBrightness = Math.max(0, Math.min(100, this._ddcBrightness + step));
            this._showOSD(this._externalMonitorIndex, this._ddcBrightness);
        }

        this._pendingDelta += step;

        if (this._debounceId !== null)
            GLib.source_remove(this._debounceId);

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._flushDDC();
            return GLib.SOURCE_REMOVE;
        });
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

    // ── Read current DDC brightness ────────────────────────────────

    _readDDCBrightness(callback) {
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
                    const match = stdout.match(/VCP\s+10\s+C\s+(\d+)\s+(\d+)/);
                    if (match) {
                        this._ddcBrightness = parseInt(match[1]);
                        log(`[SmartBrightness] DDC brightness read: ${this._ddcBrightness}`);
                    }
                } catch (e) {
                    logError(e, 'SmartBrightness read');
                }
                if (callback) callback();
            });
        } catch (e) {
            logError(e, 'SmartBrightness read');
            if (callback) callback();
        }
    }

    // ── OSD ────────────────────────────────────────────────────────

    _showOSD(monitorIndex, level) {
        if (monitorIndex < 0)
            return;

        const icon = Gio.ThemedIcon.new_with_default_fallbacks('display-brightness-symbolic');
        // GNOME 49+: showOne(monitorIndex, icon, label, level, maxLevel)
        Main.osdWindowManager.showOne(monitorIndex, icon, null, level / 100);
    }

    // ── DDC write (serialized) ─────────────────────────────────────

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

                if (this._pendingDelta !== 0) {
                    this._flushDDC();
                } else {
                    this._readDDCBrightness();
                }
            });
        } catch (e) {
            logError(e, 'SmartBrightness ddcutil');
            this._ddcRunning = false;
        }
    }

    // ── Cleanup ────────────────────────────────────────────────────

    disable() {
        this._unpatchBrightnessManager();

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
