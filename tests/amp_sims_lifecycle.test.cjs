const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../screen.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fn(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match, name);
    let end = source.indexOf('(', match.index) + 1, depth = 1;
    while (depth) { if (source[end] === '(') depth++; if (source[end] === ')') depth--; end++; }
    end = source.indexOf('{', end) + 1;
    depth = 1;
    while (depth) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
    return source.slice(match.index, end);
}

function fixture({ enabled = true, delayedFetch = false, delayedNative = false, delayedClear = false } = {}) {
    let state = { applicable: true, ready: true, enabled, generation: 1 };
    const calls = [], timers = new Set();
    let completeFetch, completeNative, completeClear;
    const native = Object.freeze({
        isAvailable: async () => true,
        clearChain: async () => {
            calls.push('clear');
            return delayedClear ? new Promise(resolve => { completeClear = resolve; }) : true;
        },
        loadPreset: async () => {
            calls.push('load');
            return delayedNative ? new Promise(resolve => { completeNative = resolve; }) : { success: true, slotsLoaded: 1 };
        },
        startAudio: async () => calls.push('start'), stopAudio: async () => calls.push('stop'),
        setInputChannel: async () => calls.push('channel'), setGain: async () => calls.push('gain'),
        setNoiseGate: async () => calls.push('gate'), setMonitorMute: async () => calls.push('mute'),
    });
    const response = { ok: true, json: async () => ({ native_preset: { version: 1, chain: [{}] } }) };
    const context = vm.createContext({
        window: { feedBackDesktop: { audio: native }, feedBack: { ampSims: { snapshot: () => state } } },
        console: { log() {}, warn() {}, error() {} },
        setInterval: callback => { timers.add(callback); return callback; }, clearInterval: id => timers.delete(id),
        fetch: async () => delayedFetch ? new Promise(resolve => { completeFetch = () => resolve(response); }) : response,
        _namCheckToneChange() {}, _namUpdateAmpButton() {}, _namUpdateStatus() {},
        _namRestoreGuitarStem() {}, _namRefreshNativeLatency: async () => {},
        _namApplyInputGain: () => calls.push('preset-input-gain'),
        _namApplyOutputGain: () => calls.push('preset-output-gain'),
        _namNativeInputChannel: () => 6,
        _namApplySavedNativeDevice: async () => calls.push('device'),
        _namBuildWasmGraph: async () => calls.push('wasm-fallback'),
        _namApplyWasmPreset: async () => calls.push('wasm-fallback'),
        _namApplyCurrentSongTone: async () => false,
        _namResetNativeAfterFailure: async () => calls.push('failure-reset'),
    });
    const stateBlock = source.slice(source.indexOf('// ── State'), source.indexOf('function _namDesktopAudio()'));
    vm.runInContext(stateBlock + '\n' + [
        '_namDesktopAudio', '_namDesktopAudioAvailable', '_namShouldUseNativeAudio',
        '_namApplyNativePreset', '_namBuildNativeGraph', '_namBuildGraph', '_namApplyPreset',
        '_namGraphActive', '_namTeardown',
    ].map(fn).join('\n') + `
        _namEnabled = true;
        _namNativeStartedAudio = true;
        _namCurrentPreset = { id: 7, input_gain: 0.75, output_gain: 0.4 };
        _namBuildGraph = _namTrackedTask(_namBuildGraph);
        _namApplyPreset = _namTrackedTask(_namApplyPreset);
        _namTeardown = _namTrackedTask(_namTeardown);
    `, context);
    return { calls, timers, context,
        set(next) { state = { ...state, ...next, generation: state.generation + 1 }; },
        change: () => context._namAmpSimsChanged(state),
        apply: () => context._namApplyPreset({ id: 7 }),
        finishFetch: () => completeFetch(),
        finishNative: () => completeNative({ success: true, slotsLoaded: 1 }),
        finishClear: () => completeClear(true),
        evaluate: code => vm.runInContext(code, context),
    };
}

test('OFF cancels a late native-preset response without loading, WASM fallback, route changes or stopping audio', async () => {
    const f = fixture({ delayedFetch: true });
    const applying = f.apply();
    const rejected = assert.rejects(applying, { code: 'amp-sims-disabled' });
    await tick();
    f.set({ enabled: false });
    let done = false;
    const off = f.change().then(() => { done = true; });
    await tick();
    assert.equal(done, false);
    f.finishFetch();
    await Promise.all([off, rejected]);
    assert.deepEqual(f.calls, []);
    assert.equal(f.evaluate('_namEnabled'), true, 'preserve the owner preference');
    assert.equal(f.evaluate('_namCurrentPreset.id'), 7);
    assert.equal(f.evaluate('_namNativeReady'), false);
    assert.equal(f.timers.size, 0);
});

test('OFF drains an already-issued native load and leaves final shared clear to Desktop', async () => {
    const f = fixture({ delayedNative: true });
    const applying = f.apply();
    const rejected = assert.rejects(applying, { code: 'amp-sims-disabled' });
    await tick();
    assert.deepEqual(f.calls, ['clear', 'load']);
    f.set({ enabled: false });
    let done = false;
    const off = f.change().then(() => { done = true; });
    await tick();
    assert.equal(done, false);
    f.finishNative();
    await Promise.all([off, rejected]);
    assert.deepEqual(f.calls, ['clear', 'load'], 'no stop, channel, gain, mute, gate or fallback');
});

test('ON restores the existing NAM preset once without replaying hardware or master settings', async () => {
    const f = fixture({ enabled: false });
    await f.change();
    f.set({ enabled: true });
    await f.change();
    assert.deepEqual(f.calls, ['clear', 'load']);
    assert.equal(f.evaluate('_namNativeReady'), true);
    assert.equal(f.evaluate('_namCurrentPreset.id'), 7);
    assert.equal(f.timers.size, 1);
    await f.change();
    assert.deepEqual(f.calls, ['clear', 'load']);
    assert.equal(f.timers.size, 1);
});

test('a captured native facade cannot resurrect a tone after OFF and ON', async () => {
    const f = fixture();
    const stale = f.evaluate('_namToneAudio(_namDesktopAudio())');
    f.set({ enabled: false });
    await f.change();
    f.set({ enabled: true });
    await assert.rejects(stale.loadPreset('{}'), { code: 'amp-sims-disabled' });
    assert.deepEqual(f.calls, []);
});

test('global OFF during ordinary teardown cannot stop shared audio after its delayed clear', async () => {
    const f = fixture({ delayedClear: true });
    f.evaluate('_namNativeMode = true; _namNativeStartedAudio = true;');
    const teardown = f.context._namTeardown();
    await tick();
    f.set({ enabled: false });
    let finished = false;
    const off = f.change().then(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    f.finishClear();
    await Promise.all([teardown, off]);
    assert.deepEqual(f.calls, ['clear']);
});

test('policy refusal is terminal and does not attempt a browser fallback', async () => {
    const f = fixture();
    f.context._namApplyNativePreset = async () => { throw { code: 'amp-sims-disabled', outcome: 'denied' }; };
    await assert.rejects(f.apply(), { code: 'amp-sims-disabled' });
    assert.deepEqual(f.calls, []);
});

test('pure browser applicability preserves NAM operation even with the Desktop preference off', () => {
    const f = fixture({ enabled: false });
    f.set({ applicable: false });
    assert.equal(f.evaluate('_namAmpAllowed()'), true);
    assert.doesNotThrow(() => f.evaluate('_namAmpAssert(-1)'));
});
