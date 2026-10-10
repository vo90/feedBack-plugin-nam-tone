'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../screen.js'), 'utf8');
const start = source.indexOf('// The settings selector is presentation only.');
const end = source.indexOf('\nfunction _namUpdateStatus()', start);
assert.ok(start >= 0 && end > start);
const lifecycle = source.slice(start, end);
function handler(name) {
    const begin = source.indexOf(`window.${name} = `);
    const finish = source.indexOf('\n};', begin);
    assert.ok(begin >= 0 && finish > begin);
    return source.slice(begin, finish + 3);
}
const handlers = ['namSettingsPresetChanged', 'namTestSettingsPreset', 'namSavePreset'].map(handler).join('\n');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ defaultId = null, classic = false } = {}) {
    const observers = new Set(), requests = [], warnings = [], inputs = new Map();
    let writes = 0, controls = 0, refreshes = 0;
    function notify(target, type, attributeName) {
        for (const observer of observers) {
            const options = observer.targets.get(target);
            if (!options || (type === 'childList' ? !options.childList
                : !options.attributes || !options.attributeFilter.includes(attributeName))) continue;
            if (!observer.queued) {
                observer.queued = true;
                queueMicrotask(() => {
                    observer.queued = false;
                    if (observer.targets.size) observer.callback();
                });
            }
        }
    }
    class Element {
        constructor(tag, id = '', parent = null, classes = []) {
            this.tag = tag; this.id = id; this.parentElement = parent;
            this.listeners = new Map(); this.classes = new Set(classes); this._open = false;
            this.classList = {
                contains: name => this.classes.has(name),
                add: name => this.classList.toggle(name, true),
                remove: name => this.classList.toggle(name, false),
                toggle: (name, enabled) => {
                    const next = enabled === undefined ? !this.classes.has(name) : !!enabled;
                    if (next === this.classes.has(name)) return next;
                    if (next) this.classes.add(name); else this.classes.delete(name);
                    notify(this, 'attributes', 'class');
                    return next;
                },
            };
        }
        get isConnected() { return this.tag === 'body' || !!this.parentElement?.isConnected; }
        closest(selector) {
            for (let node = this; node; node = node.parentElement) {
                if (selector[0] === '#' ? node.id === selector.slice(1)
                    : selector[0] === '.' ? node.classList.contains(selector.slice(1)) : node.tag === selector) return node;
            }
            return null;
        }
        addEventListener(type, callback) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(callback);
        }
        removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
        get open() { return this._open; }
        set open(value) {
            if (this._open === value) return;
            this._open = value;
            queueMicrotask(() => { for (const callback of this.listeners.get('toggle') || []) callback(); });
        }
        detach() {
            const parent = this.parentElement; this.parentElement = null;
            notify(parent, 'childList');
        }
    }
    class Select extends Element {
        constructor(parent) {
            super('select', 'nam-settings-preset-select', parent);
            this.options = [{ value: '', textContent: 'No presets' }]; this._value = '';
        }
        get value() { return this.options.some(option => option.value === this._value) ? this._value : ''; }
        set value(value) { this._value = String(value); }
        get selectedOptions() { return this.options.filter(option => option.value === this._value).slice(0, 1); }
        set innerHTML(html) {
            writes++;
            this.options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>(.*?)<\/option>/g)].map(match => ({
                value: match[1], selected: /\bselected\b/.test(match[2]),
                textContent: match[3].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
            }));
            this._value = (this.options.find(option => option.selected) || this.options[0])?.value || '';
        }
        replaceChildren(...children) {
            writes++; this.options = children;
            this._value = children[0]?.value || '';
        }
    }
    const body = new Element('body');
    const settings = new Element('div', 'settings', body, ['screen']);
    const panel = classic ? null : new Element('div', '', settings, ['fb-tabpanel']);
    const mount = new Element('div', 'plugin-settings', panel || settings);
    const details = new Element('details', '', mount);
    const host = new Element('div', 'plugin-settings-nam_tone', details);
    const section = new Element('div', 'nam-settings-preset-test-section', host, ['hidden']);
    const select = new Select(section);
    const elements = [settings, panel, mount, details, host, section, select].filter(Boolean);
    const window = {};
    Object.defineProperty(window, 'feedBackDesktop', { get() { throw new Error('Selector must not access audio'); } });
    const context = vm.createContext({
        window, AbortController, Promise,
        console: { warn: (...args) => warnings.push(args) },
        document: { getElementById: id => inputs.get(id) || elements.find(el => el.id === id && el.isConnected) || null },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; this.targets = new Map(); observers.add(this); }
            observe(target, options) { this.targets.set(target, options); }
            disconnect() { this.targets.clear(); observers.delete(this); }
        },
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({
            url, options, reject, resolve: data => resolve({ json: async () => data }),
        })),
        esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        updateControls: () => { controls++; },
        refreshPresets: () => { refreshes++; },
    });
    function load() {
        return vm.runInContext(`(function() {
            let _namSettingsPresetTestId = '';
            let _namDefaultPresetId = ${JSON.stringify(defaultId)};
            const _namUpdateSettingsPresetTestControls = updateControls;
            const _namRefreshPresets = refreshPresets;
            ${lifecycle}
            ${handlers}
            return { populate: _namPopulateSettingsPresetSelector,
                selectedId: () => _namSettingsPresetTestId,
                owner: _namSettingsPresetSelectorLifecycle };
        })()`, context);
    }
    const api = load();
    async function show() {
        settings.classList.add('active'); panel?.classList.add('active'); details.open = true;
        await flush();
    }
    return { api, load, show, window, settings, panel, details, mount, section, select,
        observers, requests, warnings, inputs, controls: () => controls,
        writes: () => writes, refreshes: () => refreshes };
}

test('hidden boot and closed/inactive settings surfaces do not fetch or create options', async () => {
    const f = fixture();
    await f.api.populate();
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes(), 0);
    f.settings.classList.add('active');
    await flush();
    f.details.open = true; // Wrong tab.
    await flush();
    assert.equal(f.requests.length, 0);
    f.details.open = false;
    f.panel.classList.add('active'); // Correct tab but collapsed.
    await flush();
    assert.equal(f.requests.length, 0);
    f.details.open = true;
    await flush();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve([{ id: 1, name: 'One' }]);
    await flush();
    assert.equal(f.select.value, '1');
});

test('large list eviction retains the selected option identity, id and label, then reloads on screen entry', async () => {
    const f = fixture({ defaultId: 9 });
    await f.api.populate(); await f.show();
    const presets = Array.from({ length: 21283 }, (_, index) => ({ id: index + 1, name: `Preset ${index + 1}` }));
    presets[8].name = 'Chosen <&> label';
    f.requests[0].resolve(presets); await flush();
    assert.equal(f.select.options.length, 21283);
    assert.equal(f.select.value, '9');
    const chosen = f.select.selectedOptions[0];
    f.settings.classList.remove('active'); await flush();
    assert.equal(f.select.options.length, 1);
    assert.equal(f.select.options[0], chosen);
    assert.equal(f.select.value, '9');
    assert.equal(f.select.options[0].textContent, 'Chosen <&> label');
    assert.equal(f.api.selectedId(), '9');
    f.settings.classList.add('active'); await flush();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve([{ id: 3, name: 'First' }, { id: 9, name: 'Renamed' }]); await flush();
    assert.equal(f.select.value, '9');
    assert.equal(f.select.selectedOptions[0].textContent, 'Renamed');
});

test('tab or details hiding evicts, and duplicate init/open notifications share one request', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    const first = f.api.populate();
    f.settings.classList.add('other-class'); await flush();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]); await first;
    f.panel.classList.remove('active'); await flush();
    assert.equal(f.select.options.length, 1);
    f.panel.classList.add('active'); await flush();
    f.requests[1].resolve([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]); await flush();
    f.details.open = false; await flush();
    assert.equal(f.select.options.length, 1);
    assert.equal(f.observers.size, 1);
    assert.equal(f.details.listeners.get('toggle').size, 1);
});

test('close/reopen rejects stale successful and failed responses without hiding newer results', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    f.details.open = false; await flush();
    assert.equal(f.requests[0].options.signal.aborted, true);
    f.details.open = true; await flush();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve([{ id: 2, name: 'New' }, { id: 3, name: 'Current' }]); await flush();
    f.requests[0].resolve([{ id: 1, name: 'Stale' }]); await flush();
    assert.equal(f.select.value, '2');
    assert.equal(f.select.options.length, 2);
    const pending = f.api.populate();
    f.details.open = false; await flush();
    f.details.open = true; await flush();
    f.requests[3].resolve([{ id: 4, name: 'Newest' }]); await flush();
    f.requests[2].reject(new Error('Old failure')); await pending;
    assert.equal(f.select.value, '4');
    assert.equal(f.section.classList.contains('hidden'), false);
    assert.equal(f.warnings.length, 0);
});

test('response after hiding cannot repopulate options even before observer delivery', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    f.settings.classes.delete('active'); // Visibility changes before notification delivery.
    f.requests[0].resolve([{ id: 1, name: 'Hidden' }, { id: 2, name: 'Hidden' }]); await flush();
    assert.equal(f.select.options.length, 1);
    assert.equal(f.select.value, '');
});

test('provided catalog refresh supersedes an older request; hidden refresh waits for current data on reopening', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    await f.api.populate([{ id: 7, name: 'Saved' }, { id: 8, name: 'Other' }]);
    assert.equal(f.requests[0].options.signal.aborted, true);
    f.requests[0].resolve([{ id: 1, name: 'Before save' }]); await flush();
    assert.equal(f.select.value, '7');
    f.details.open = false; await flush();
    await f.api.populate([{ id: 9, name: 'Saved while hidden' }]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.select.value, '7');
    assert.equal(f.select.options.length, 1);
    f.details.open = true; await flush();
    f.requests[1].resolve([{ id: 9, name: 'Saved while hidden' }]); await flush();
    assert.equal(f.select.value, '9');
});

test('change handler selection and an already-started Test action survive eviction', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    f.requests[0].resolve([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]); await flush();
    f.select.value = '2'; f.window.namSettingsPresetChanged();
    assert.equal(f.api.selectedId(), '2');
    let requested, finish;
    f.window.namTestPreset = id => { requested = id; return new Promise(resolve => { finish = resolve; }); };
    const testing = f.window.namTestSettingsPreset();
    f.details.open = false; await flush();
    assert.equal(requested, '2');
    assert.equal(f.select.value, '2');
    finish(); await testing;
    assert.equal(f.controls() >= 2, true);
});

test('save reads editor values before await and continues unchanged while settings options are evicted', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    f.requests[0].resolve([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]); await flush();
    for (const [id, value] of Object.entries({
        'nam-preset-name': ' Saved name ', 'nam-preset-model': 'amp.nam', 'nam-preset-ir': 'cab.wav',
        'nam-preset-input-gain': '1.5', 'nam-preset-output-gain': '0.7', 'nam-preset-gate': '-45',
    })) f.inputs.set(id, { value });
    const saving = f.window.namSavePreset();
    f.details.open = false; await flush();
    assert.equal(f.requests[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(f.requests[1].options.body), {
        name: 'Saved name', model_file: 'amp.nam', ir_file: 'cab.wav',
        input_gain: 1.5, output_gain: 0.7, gate_threshold: -45, settings: {},
    });
    f.requests[1].resolve({}); await saving;
    assert.equal(f.refreshes(), 1);
    assert.equal(f.inputs.get('nam-preset-name').value, '');
    assert.equal(f.select.options.length, 1);
});

test('empty catalogs, deleted selection fallback and retry retain previous selector rules', async () => {
    const f = fixture({ defaultId: 5 }); await f.api.populate(); await f.show();
    f.requests[0].resolve([{ id: 1, name: 'First' }, { id: 5, name: 'Default' }]); await flush();
    assert.equal(f.select.value, '5');
    await f.api.populate([{ id: 1, name: 'First' }]);
    assert.equal(f.select.value, '1');
    await f.api.populate([]);
    assert.equal(f.select.value, '');
    assert.equal(f.api.selectedId(), '');
    assert.equal(f.section.classList.contains('hidden'), true);
    const retry = f.api.populate(); f.requests[1].reject(new Error('Offline')); await retry;
    assert.equal(f.warnings.length, 1);
    f.details.open = false; await flush(); f.details.open = true; await flush();
    f.requests[2].resolve([{ id: 5, name: 'Returned' }]); await flush();
    assert.equal(f.select.value, '5');
    assert.equal(f.section.classList.contains('hidden'), false);
});

test('unmount and script reinitialization clean listeners, abort requests and retire old entry points', async () => {
    const f = fixture(); await f.api.populate(); await f.show();
    const old = f.api, replacement = f.load();
    assert.equal(f.requests[0].options.signal.aborted, true);
    assert.equal(f.observers.size, 0);
    assert.equal(f.details.listeners.get('toggle').size, 0);
    await old.populate(); assert.equal(f.requests.length, 1);
    const pending = replacement.populate();
    assert.equal(f.observers.size, 1);
    f.details.detach(); await flush();
    assert.equal(f.observers.size, 0);
    assert.equal(f.details.listeners.get('toggle').size, 0);
    assert.equal(f.requests[1].options.signal.aborted, true);
    f.requests[1].resolve([{ id: 8, name: 'Detached' }]); await pending;
    assert.equal(f.select.value, '');
});

test('classic settings without tabs still require Settings and the open details', async () => {
    const f = fixture({ classic: true }); await f.api.populate(); await f.show();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve([{ id: 1, name: 'Classic' }]); await flush();
    assert.equal(f.select.value, '1');
    f.settings.classList.remove('active'); await flush();
    assert.equal(f.select.options.length, 1);
});
