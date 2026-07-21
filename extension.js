import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const KEYBINDING_SCHEMA = 'org.gnome.shell.keybindings';

// ── Configuration ──────────────────────────────────────────────────
const BUILTIN_CONNECTOR = 'eDP-1';
const DDC_STEP = 5;
const DEBOUNCE_MS = 150;
const DDC_SLEEP_MULTIPLIER = '0.5';
// ───────────────────────────────────────────────────────────────────

export default class SmartBrightnessExtension extends Extension {
    enable() {
        this._debounceId = null;
        this._ddcRunning = false;
        // monitorIndex -> { bus, brightness, pendingDelta, name }
        this._ddcByMonitor = new Map();

        const monitorManager = global.backend.get_monitor_manager();
        this._builtinMonitorIndex = monitorManager.get_monitor_for_connector(BUILTIN_CONNECTOR);

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            const mgr = global.backend.get_monitor_manager();
            this._builtinMonitorIndex = mgr.get_monitor_for_connector(BUILTIN_CONNECTOR);
            this._ddcByMonitor.clear();
            this._detectDisplays();
        });

        this._detectDisplays();
        this._patchBrightnessManager();

        log('[SmartBrightness] Enabled');
    }

    _getTargetMonitorIndex() {
        // Prefer the monitor under the pointer (matches GNOME's
        // screen-brightness-*-monitor bindings and "mouse focus").
        try {
            const lm = global.backend.get_current_logical_monitor();
            if (lm)
                return lm.get_number();
        } catch (_e) {
            // fall through
        }

        const focusWindow = global.display.focus_window;
        if (focusWindow)
            return focusWindow.get_monitor();

        return -1;
    }

    // ── BrightnessManager integration (GNOME 49+) ──────────────────
    // BrightnessManager registers keybindings with .bind(), so replacing
    // the methods on the instance has no effect. We remove and re-add
    // the bindings instead.

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
        this._origScreenBrightnessUpMonitor = bm._screenBrightnessUpCurrentMonitor.bind(bm);
        this._origScreenBrightnessDownMonitor = bm._screenBrightnessDownCurrentMonitor.bind(bm);
        this._origScreenBrightnessCycleMonitor = bm._screenBrightnessCycleCurrentMonitor.bind(bm);
        this._keybindingSettings = new Gio.Settings({schema_id: KEYBINDING_SCHEMA});

        this._replaceKeybinding('screen-brightness-up', () => {
            this._handleBrightnessKey(DDC_STEP, this._origScreenBrightnessUp);
        });
        this._replaceKeybinding('screen-brightness-down', () => {
            this._handleBrightnessKey(-DDC_STEP, this._origScreenBrightnessDown);
        });
        this._replaceKeybinding('screen-brightness-cycle', () => {
            this._handleBrightnessKey(DDC_STEP, this._origScreenBrightnessCycle);
        });
        // Same handlers for the per-monitor variants — we already route by
        // the monitor under the pointer / focused window.
        this._replaceKeybinding('screen-brightness-up-monitor', () => {
            this._handleBrightnessKey(DDC_STEP, this._origScreenBrightnessUpMonitor);
        });
        this._replaceKeybinding('screen-brightness-down-monitor', () => {
            this._handleBrightnessKey(-DDC_STEP, this._origScreenBrightnessDownMonitor);
        });
        this._replaceKeybinding('screen-brightness-cycle-monitor', () => {
            this._handleBrightnessKey(DDC_STEP, this._origScreenBrightnessCycleMonitor);
        });
    }

    _replaceKeybinding(name, handler) {
        Main.wm.removeKeybinding(name);
        Main.wm.addKeybinding(
            name,
            this._keybindingSettings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            handler);
    }

    _unpatchBrightnessManager() {
        if (!this._keybindingSettings)
            return;

        this._replaceKeybinding('screen-brightness-up', this._origScreenBrightnessUp);
        this._replaceKeybinding('screen-brightness-down', this._origScreenBrightnessDown);
        this._replaceKeybinding('screen-brightness-cycle', this._origScreenBrightnessCycle);
        this._replaceKeybinding('screen-brightness-up-monitor', this._origScreenBrightnessUpMonitor);
        this._replaceKeybinding('screen-brightness-down-monitor', this._origScreenBrightnessDownMonitor);
        this._replaceKeybinding('screen-brightness-cycle-monitor', this._origScreenBrightnessCycleMonitor);

        this._keybindingSettings = null;
        this._origScreenBrightnessUp = null;
        this._origScreenBrightnessDown = null;
        this._origScreenBrightnessCycle = null;
        this._origScreenBrightnessUpMonitor = null;
        this._origScreenBrightnessDownMonitor = null;
        this._origScreenBrightnessCycleMonitor = null;
        this._brightnessManager = null;
    }

    _handleBrightnessKey(step, fallback) {
        const monitorIndex = this._getTargetMonitorIndex();

        if (monitorIndex < 0 || monitorIndex === this._builtinMonitorIndex) {
            fallback();
            return;
        }

        const target = this._ddcByMonitor.get(monitorIndex);
        if (!target) {
            // External monitor without DDC — leave built-in behavior alone
            fallback();
            return;
        }

        if (target.brightness >= 0) {
            target.brightness = Math.max(0, Math.min(100, target.brightness + step));
            this._showOSD(monitorIndex, target.brightness);
        }

        target.pendingDelta += step;

        if (this._debounceId !== null)
            GLib.source_remove(this._debounceId);

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._flushDDC();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── DDC display detection (multi-monitor) ──────────────────────

    _detectDisplays() {
        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', 'detect', '--brief'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            proc.wait_async(null, (proc_, result) => {
                try {
                    proc_.wait_finish(result);
                    const [, stdout] = proc_.communicate_utf8(null, null);
                    this._parseDetectOutput(stdout);
                } catch (e) {
                    logError(e, 'SmartBrightness detect');
                }
            });
        } catch (e) {
            logError(e, 'SmartBrightness detect');
        }
    }

    _parseDetectOutput(stdout) {
        const monitorManager = global.backend.get_monitor_manager();
        const blocks = stdout.split(/(?=^(?:Display \d+|Invalid display))/m);
        this._ddcByMonitor.clear();

        for (const block of blocks) {
            if (!block.trim())
                continue;
            if (block.includes('Invalid display') || block.includes('eDP'))
                continue;

            const busMatch = block.match(/I2C bus:\s+\/dev\/i2c-(\d+)/);
            // e.g. "card1-DP-6" → connector name "DP-6"
            const connectorMatch = block.match(/DRM connector:\s+card\d+-(.+)$/m);
            const nameMatch = block.match(/Monitor:\s+(.+)$/m);
            if (!busMatch || !connectorMatch)
                continue;

            const bus = busMatch[1];
            const connector = connectorMatch[1].trim();
            const name = nameMatch ? nameMatch[1].trim() : connector;
            const monitorIndex = monitorManager.get_monitor_for_connector(connector);

            if (monitorIndex < 0) {
                log(`[SmartBrightness] No Shell monitor for connector ${connector} (bus ${bus})`);
                continue;
            }

            this._ddcByMonitor.set(monitorIndex, {
                bus,
                name,
                brightness: -1,
                pendingDelta: 0,
            });
            log(`[SmartBrightness] DDC monitor ${monitorIndex} (${name}) bus ${bus} via ${connector}`);
            this._readDDCBrightness(monitorIndex);
        }

        if (this._ddcByMonitor.size === 0)
            log('[SmartBrightness] No DDC displays found');
    }

    // ── Read current DDC brightness ────────────────────────────────

    _readDDCBrightness(monitorIndex, callback) {
        const target = this._ddcByMonitor.get(monitorIndex);
        if (!target)
            return;

        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', '--bus', target.bus, '--sleep-multiplier', '0.1',
                 '--terse', 'getvcp', '10'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            proc.wait_async(null, (proc_, result) => {
                try {
                    proc_.wait_finish(result);
                    const [, stdout] = proc_.communicate_utf8(null, null);
                    const match = stdout.match(/VCP\s+10\s+C\s+(\d+)\s+(\d+)/);
                    if (match) {
                        target.brightness = parseInt(match[1]);
                        log(`[SmartBrightness] DDC brightness ${target.name}: ${target.brightness}`);
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
        Main.osdWindowManager.showOne(monitorIndex, icon, null, level / 100);
    }

    // ── DDC write (serialized across all buses) ────────────────────

    _flushDDC() {
        if (this._ddcRunning)
            return;

        let target = null;
        let monitorIndex = -1;
        for (const [index, entry] of this._ddcByMonitor) {
            if (entry.pendingDelta !== 0) {
                target = entry;
                monitorIndex = index;
                break;
            }
        }

        if (!target)
            return;

        const delta = target.pendingDelta;
        target.pendingDelta = 0;

        const sign = delta > 0 ? '+' : '-';
        const amount = String(Math.abs(delta));

        log(`[SmartBrightness] DDC bus ${target.bus} (${target.name}): setvcp 10 ${sign} ${amount}`);
        this._ddcRunning = true;

        try {
            const proc = Gio.Subprocess.new(
                ['ddcutil', '--bus', target.bus,
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

                const stillPending = [...this._ddcByMonitor.values()]
                    .some(e => e.pendingDelta !== 0);
                if (stillPending) {
                    this._flushDDC();
                } else {
                    this._readDDCBrightness(monitorIndex);
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
        this._ddcByMonitor.clear();
        log('[SmartBrightness] Disabled');
    }
}
