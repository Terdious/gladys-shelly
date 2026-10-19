import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCommand } from '../../src/shelly/commands.js';
import { buildDevice, buildStates } from '../../src/shelly/deviceMapping.js';
import { featureName, FEATURE_NAMES } from '../../src/shelly/featureNames.js';
import {
  buildFeatureSpecs,
  intToRgb,
  kelvinToMired,
  miredToKelvin,
  rgbToInt,
} from '../../src/shelly/features.js';
import { normalizeGen1Status } from '../../src/shelly/gen1/normalize.js';

/** Stand-in for `gladys.externalIds('device', id)`. */
function externalIdsFor(shellyId) {
  return {
    device: `ext:shelly:device:${shellyId}`,
    feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
  };
}

const keysOf = (status) => buildFeatureSpecs(status).map((spec) => spec.key);
const stateOf = (status, key) =>
  buildStates({ status, externalIds: externalIdsFor('x') }).find(
    (s) => s.device_feature_external_id === `ext:shelly:device:x:${key}`,
  )?.state;

// Shapes from the Shelly Gen2+ API documentation (Cover, Light, RGBW, CCT, Input).
const COVER = {
  'cover:0': {
    id: 0,
    source: 'HTTP_in',
    state: 'opening',
    apower: 85.3,
    voltage: 231.4,
    current: 0.41,
    aenergy: { total: 1234.5 },
    current_pos: 42,
    target_pos: 100,
    pos_control: true,
    temperature: { tC: 40.2 },
  },
};

describe('cover:N (roller shutters)', () => {
  it('maps a calibrated cover to state, position and metering', () => {
    assert.deepEqual(keysOf(COVER), [
      'cover:0:current',
      'cover:0:energy',
      'cover:0:position',
      'cover:0:power',
      'cover:0:state',
      'cover:0:temperature',
      'cover:0:voltage',
    ]);
    const device = buildDevice({
      info: { id: 'c', model: 'SNSW-002P16EU' },
      status: COVER,
      externalIds: externalIdsFor('c'),
    });
    const state = device.features.find((f) => f.external_id.endsWith(':cover:0:state'));
    assert.equal(state.category, 'shutter');
    assert.equal(state.type, 'state');
    assert.equal(state.read_only, false);
    const position = device.features.find((f) => f.external_id.endsWith(':cover:0:position'));
    assert.equal(position.type, 'position');
    assert.equal(position.read_only, false);
  });

  it('publishes the Gladys shutter values, 100 being fully open on both sides', () => {
    assert.equal(stateOf(COVER, 'cover:0:state'), 1);
    assert.equal(
      stateOf({ 'cover:0': { ...COVER['cover:0'], state: 'closing' } }, 'cover:0:state'),
      -1,
    );
    assert.equal(
      stateOf({ 'cover:0': { ...COVER['cover:0'], state: 'closed' } }, 'cover:0:state'),
      -1,
    );
    assert.equal(
      stateOf({ 'cover:0': { ...COVER['cover:0'], state: 'stopped' } }, 'cover:0:state'),
      0,
    );
    // Calibrating has no Gladys equivalent: nothing is published, nothing guessed.
    assert.equal(
      stateOf({ 'cover:0': { ...COVER['cover:0'], state: 'calibrating' } }, 'cover:0:state'),
      undefined,
    );
    assert.equal(stateOf(COVER, 'cover:0:position'), 42);
  });

  it('leaves the position out of an uncalibrated cover', () => {
    const uncalibrated = { 'cover:0': { id: 0, state: 'stopped', pos_control: false, apower: 0 } };
    assert.deepEqual(keysOf(uncalibrated), ['cover:0:power', 'cover:0:state']);
    const noPos = { 'cover:0': { id: 0, state: 'stopped', current_pos: null } };
    assert.deepEqual(keysOf(noPos), ['cover:0:state']);
  });
});

describe('light outputs', () => {
  it('maps a dimmer to on/off, brightness and power under the light category', () => {
    const status = { 'light:0': { id: 0, output: true, brightness: 65, apower: 7.2 } };
    assert.deepEqual(keysOf(status), ['light:0:binary', 'light:0:brightness', 'light:0:power']);
    const device = buildDevice({ info: { id: 'd' }, status, externalIds: externalIdsFor('d') });
    assert.deepEqual(
      device.features.map((f) => [f.category, f.type]),
      [
        ['light', 'binary'],
        ['light', 'brightness'],
        ['light', 'power'],
      ],
    );
    assert.equal(stateOf(status, 'light:0:brightness'), 65);
  });

  it('round-trips an RGB colour through the Gladys integer', () => {
    for (const rgb of [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 128, 0],
      [12, 34, 56],
    ]) {
      assert.deepEqual(intToRgb(rgbToInt(rgb)), rgb);
    }
    assert.equal(rgbToInt([255, 128, 0]), 0xff8000);
    const status = {
      'rgbw:0': { id: 0, output: true, rgb: [255, 128, 0], brightness: 80, white: 0 },
    };
    assert.deepEqual(keysOf(status), ['rgbw:0:binary', 'rgbw:0:brightness', 'rgbw:0:color']);
    assert.equal(stateOf(status, 'rgbw:0:color'), 0xff8000);
  });

  it('publishes the colour temperature in mireds, the Gladys light convention', () => {
    assert.equal(kelvinToMired(4000), 250);
    assert.equal(miredToKelvin(250), 4000);
    const status = { 'cct:0': { id: 0, output: true, brightness: 50, ct: 2700 } };
    assert.equal(stateOf(status, 'cct:0:temperature'), 370);
    const spec = buildFeatureSpecs(status).find((s) => s.key === 'cct:0:temperature');
    // 6500 K (cold) to 2700 K (warm).
    assert.deepEqual([spec.min, spec.max], [154, 370]);
    assert.deepEqual(buildCommand({ family: 'cct', index: 0, suffix: 'temperature' }, 370).rpc, {
      method: 'CCT.Set',
      params: { id: 0, ct: 2703 },
    });
  });
});

describe('input:N', () => {
  it('maps each input mode to its own feature', () => {
    const status = {
      'input:0': { id: 0, state: true },
      'input:1': { id: 1, state: null },
      'input:2': { id: 2, counts: { total: 17 }, freq: 0 },
      'input:3': { id: 3, percent: 42.5 },
    };
    assert.deepEqual(keysOf(status), ['input:0:binary', 'input:1:button', 'input:2:counter']);
    assert.equal(stateOf(status, 'input:0:binary'), 1);
    assert.equal(stateOf(status, 'input:2:counter'), 17);
    // A press is an event: a poll never publishes the button.
    assert.equal(stateOf(status, 'input:1:button'), undefined);
  });

  it('gives a Shelly i4 four usable features', () => {
    const i4 = Object.fromEntries([0, 1, 2, 3].map((id) => [`input:${id}`, { id, state: null }]));
    assert.equal(keysOf(i4).length, 4);
  });
});

describe('feature names in the four Gladys languages', () => {
  it('has every name in every language', () => {
    const reference = Object.keys(FEATURE_NAMES.en).sort();
    for (const language of ['fr', 'de', 'es']) {
      assert.deepEqual(Object.keys(FEATURE_NAMES[language]).sort(), reference, language);
    }
  });

  it('keeps the English names of the existing devices unchanged', () => {
    assert.equal(featureName({ nameKey: 'on_off' }), 'On/Off');
    assert.equal(featureName({ nameKey: 'active_power', phase: 'L1' }), 'L1 active power');
    assert.equal(
      featureName({ nameKey: 'total_returned_energy', phase: 'L3' }),
      'L3 total returned energy',
    );
  });

  it('names a new device in the configured language, ids unchanged', () => {
    const status = { 'switch:0': { id: 0, output: true, apower: 3 }, 'em:0': { a_act_power: 1 } };
    const names = (language) =>
      buildDevice({ info: { id: 'p' }, status, externalIds: externalIdsFor('p'), language })
        .features;
    assert.deepEqual(
      names('fr').map((f) => f.name),
      ['L1 puissance active', 'Marche/Arrêt', 'Puissance'],
    );
    assert.deepEqual(
      names('de').map((f) => f.name),
      ['L1 Wirkleistung', 'Ein/Aus', 'Leistung'],
    );
    assert.deepEqual(
      names('es').map((f) => f.external_id),
      names('en').map((f) => f.external_id),
    );
    // An unknown language falls back to English.
    assert.equal(names('it')[1].name, 'On/Off');
  });
});

describe('Gen1 rollers, lights and inputs', () => {
  it('normalizes a Shelly 2.5 in roller mode into a cover', () => {
    const status = normalizeGen1Status({
      mode: 'roller',
      relays: [{ ison: false }, { ison: false }],
      rollers: [{ state: 'stop', power: 0, current_pos: 70, positioning: true }],
    });
    assert.deepEqual(Object.keys(status), ['cover:0']);
    assert.equal(stateOf(status, 'cover:0:position'), 70);
    assert.equal(stateOf(status, 'cover:0:state'), 0);
    assert.equal(
      buildCommand({ family: 'cover', index: 0, suffix: 'position' }, 30).gen1,
      '/roller/0?go=to_pos&roller_pos=30',
    );
  });

  it('keeps a 2.5 in relay mode as two relays', () => {
    const status = normalizeGen1Status({
      relays: [{ ison: true }, { ison: false }],
      rollers: [{ state: 'stop' }],
    });
    assert.deepEqual(Object.keys(status), ['switch:0', 'switch:1']);
  });

  it('normalizes a dimmer, a Duo and an RGBW2 in colour mode', () => {
    const dimmer = normalizeGen1Status({ lights: [{ ison: true, brightness: 40 }] });
    assert.deepEqual(dimmer['light:0'], { id: 0, output: true, brightness: 40 });
    const duo = normalizeGen1Status({ lights: [{ ison: true, brightness: 40, temp: 3000 }] });
    assert.equal(duo['cct:0'].ct, 3000);
    const rgbw = normalizeGen1Status({
      lights: [{ ison: true, mode: 'color', red: 255, green: 0, blue: 10, gain: 60, white: 0 }],
    });
    assert.deepEqual(rgbw['rgbw:0'].rgb, [255, 0, 10]);
    assert.equal(rgbw['rgbw:0'].brightness, 60);
    assert.equal(
      buildCommand({ family: 'rgbw', index: 0, suffix: 'brightness' }, 60).gen1,
      '/color/0?gain=60',
    );
  });

  it('normalizes the inputs of an i3 into switch-mode inputs', () => {
    const status = normalizeGen1Status({ inputs: [{ input: 1 }, { input: 0 }, { input: 0 }] });
    assert.equal(stateOf(status, 'input:0:binary'), 1);
    assert.equal(stateOf(status, 'input:1:binary'), 0);
  });
});
