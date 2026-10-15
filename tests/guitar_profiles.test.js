const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function setup({profile = true, enabled = true} = {}) {
    let snapshot = {activeId: 'default', activeName: 'Default guitar', gain: 2,
        route: {kind: 'browser', deviceId: '', channel: -1}};
    const listeners = [], nativeWrites = [], nodes = [];
    const label = {};
    const profiles = {ready: Promise.resolve(), getSnapshot: () => snapshot,
        async refresh() {return snapshot;},
        subscribe(fn) {listeners.push(fn); return () => {};},
        saveGain() {assert.fail('Tone/preset operation must not save guitar calibration');}};
    function node() {
        const n = {connections: [], channelCount: 2, gain: {value: 1,
            setTargetAtTime(value) {this.value = value;}},
            connect(to) {this.connections.push(to);}, disconnect() {this.connections = [];}};
        nodes.push(n); return n;
    }
    class AudioContext {
        constructor() {this.state = 'running'; this.currentTime = 0; this.destination = node();
            this.audioWorklet = {async addModule() {}};}
        createGain() {return node();}
        createConvolver() {return node();}
        createMediaStreamSource() {return node();}
        createChannelSplitter() {return node();}
        createChannelMerger() {return node();}
        async resume() {this.state = 'running';}
        async suspend() {this.state = 'suspended';}
    }
    const api = {async clearChain() {nativeWrites.push('clear');},
        async loadPreset() {nativeWrites.push('preset'); return {success: true};},
        async startAudio() {}, async isAudioRunning() {return true;},
        async setGain(kind, gain) {nativeWrites.push([kind, gain]);},
        async setInputCalibrationGain() {assert.fail('NAM must not overwrite dedicated calibration');}};
    const policy = {snapshot: () => ({applicable: true, ready: true, enabled, generation: 1}),
        subscribe() {return () => {};}};
    const context = vm.createContext({
        console: {log() {}, warn() {}, error() {}},
        document: {getElementById: id => id === 'nam-guitar-calibration-status' ? label : null},
        localStorage: {getItem: () => null, setItem() {}},
        addEventListener() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        navigator: {mediaDevices: {async getUserMedia() {return {getTracks: () => [{stop() {}}]};}}},
        AudioContext, AudioWorkletNode: class {constructor() {Object.assign(this, node()); this.port = {postMessage() {}};}},
        feedBack: {ampSims: policy, ...(profile ? {guitarProfiles: profiles} : {})},
        fetch: async () => ({ok: true, json: async () => ({native_preset: {chain: [{}]}})}),
    });
    context.window = context;
    const exportAt = source.lastIndexOf('})();');
    const exports = `
        _namSendWasm = async () => {};
        _namLoadModel = async () => {};
        _namLoadIR = async () => {};
        window.testNam = {build: _namBuildWasmGraph, apply: _namApplyWasmPreset,
            native: _namApplyNativePreset, teardown: _namTeardown,
            update: _namUpdateGuitarCalibration,
            state: () => ({calibration: _namCalibrationGain, tone: _namInputGain,
                source: _namSource, worklet: _namWorkletNode}),
            input(device, channel) {_namDeviceId = device; _namChannel = channel;}};
    `;
    vm.runInContext(source.slice(0, exportAt) + exports + source.slice(exportAt), context);
    return {context, api, nativeWrites, label, profiles, test: context.testNam,
        change(next) {snapshot = {...snapshot, ...next}; listeners.forEach(fn => fn(snapshot));}};
}

test('browser capture applies guitar calibration exactly once before independent tone drive', async () => {
    const s = setup();
    await s.test.build();
    const state = s.test.state();
    assert.equal(state.calibration.gain.value, 2);
    assert.deepEqual(state.source.connections, [state.calibration]);
    assert.deepEqual(state.calibration.connections, [state.tone]);
    assert.deepEqual(state.tone.connections, [state.worklet]);
    await s.test.apply({input_gain: 3, output_gain: 0.5});
    assert.equal(state.tone.gain.value, 3);
    assert.equal(state.calibration.gain.value, 2);
    s.change({gain: 4, activeName: 'Strat'});
    assert.equal(state.calibration.gain.value, 4);
    assert.equal(state.tone.gain.value, 3);
    await s.test.apply({input_gain: 0.5});
    assert.equal(state.calibration.gain.value, 4);
    assert.equal(state.tone.gain.value, 0.5);
    assert.match(s.label.textContent, /Strat/);
});

test('different browser device, channel, and native route never reuse the wrong calibration', async () => {
    for (const route of [
        {kind: 'browser', deviceId: 'other-device', channel: -1},
        {kind: 'browser', deviceId: '', channel: 1},
        {kind: 'native', deviceId: '', channel: -1},
    ]) {
        const s = setup(); s.change({route});
        await s.test.build(); s.test.update();
        assert.equal(s.test.state().calibration.gain.value, 1);
        assert.match(s.label.textContent, /not applied/);
    }
});

test('legacy browser hosts retain unity correction and the preset gain', async () => {
    const s = setup({profile: false});
    await s.test.build();
    await s.test.apply({input_gain: 3});
    assert.equal(s.test.state().calibration.gain.value, 1);
    assert.equal(s.test.state().tone.gain.value, 3);
});

test('browser tones can build after profile service startup recovers', async () => {
    const s = setup();
    s.profiles.ready = Promise.reject(new Error('Earlier server failure'));
    s.profiles.ready.catch(() => {});
    await s.test.build();
    assert.equal(s.test.state().calibration.gain.value, 2);
});

test('native preset replacement never writes or resets guitar calibration', async () => {
    const s = setup(); s.change({route: {kind: 'native'}});
    await s.test.native({id: 1, input_gain: 3}, s.api);
    await s.test.native({id: 2, input_gain: 0.5}, s.api);
    assert.equal(s.profiles.getSnapshot().gain, 2);
    assert.deepEqual(s.nativeWrites, ['clear', 'preset', ['input', 1], ['output', 1],
        'clear', 'preset', ['input', 1], ['output', 1]]);
});

test('external mode accepts profile changes without starting or changing tones', async () => {
    const s = setup({enabled: false});
    s.change({gain: 4});
    await assert.rejects(s.test.native({id: 1}, s.api), {code: 'amp-sims-disabled'});
    assert.deepEqual(s.nativeWrites, []);
    assert.equal(s.profiles.getSnapshot().gain, 4);
});

test('browser teardown disconnects the separate calibration node', async () => {
    const s = setup(); await s.test.build();
    const calibration = s.test.state().calibration;
    await s.test.teardown();
    assert.equal(s.test.state().calibration, null);
    assert.deepEqual(calibration.connections, []);
});
