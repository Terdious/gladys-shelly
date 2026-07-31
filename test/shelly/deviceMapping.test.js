import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDevice,
  buildDeviceName,
  buildStates,
  readHost,
  readShellyId,
} from '../../src/shelly/deviceMapping.js';
import { buildFeatureSpecs } from '../../src/shelly/features.js';
import { PRO_3EM_STATUS, PRO_4PM_STATUS } from '../helpers/fakeShelly.js';

/** Stand-in for `gladys.externalIds('device', id)`. */
function externalIdsFor(shellyId) {
  return {
    device: `ext:shelly:device:${shellyId}`,
    feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
  };
}

describe('buildFeatureSpecs', () => {
  it('maps a Pro 3EM to per-phase and total energy features', () => {
    const keys = buildFeatureSpecs(PRO_3EM_STATUS).map((spec) => spec.key);

    assert.ok(keys.includes('em:0:l1_active_power'));
    assert.ok(keys.includes('em:0:l3_voltage'));
    assert.ok(keys.includes('em:0:total_active_power'));
    assert.ok(keys.includes('emdata:0:total_energy'));
    assert.ok(keys.includes('emdata:0:l2_total_returned_energy'));
    // This meter HAS a neutral clamp wired, so the feature exists.
    assert.ok(keys.includes('em:0:neutral_current'));
    // `sys` and `wifi` carry nothing user-facing.
    assert.ok(!keys.some((key) => key.startsWith('sys') || key.startsWith('wifi')));
  });

  it('drops the neutral current when the clamp is not wired', () => {
    const withoutNeutral = {
      ...PRO_3EM_STATUS,
      'em:0': { ...PRO_3EM_STATUS['em:0'], n_current: null },
    };
    const keys = buildFeatureSpecs(withoutNeutral).map((spec) => spec.key);
    // Publishing a permanently empty chart is worse than not publishing it.
    assert.ok(!keys.includes('em:0:neutral_current'));
    assert.ok(keys.includes('em:0:total_current'));
  });

  it('maps the four metered relays of a Pro 4PM', () => {
    const keys = buildFeatureSpecs(PRO_4PM_STATUS).map((spec) => spec.key);
    [0, 1, 2, 3].forEach((index) => {
      assert.ok(keys.includes(`switch:${index}:binary`), `missing switch:${index}:binary`);
      assert.ok(keys.includes(`switch:${index}:power`), `missing switch:${index}:power`);
      assert.ok(keys.includes(`switch:${index}:energy`), `missing switch:${index}:energy`);
    });
    assert.ok(keys.includes('temperature:100:temperature'));
  });

  it('derives capabilities from the payload, not from the model', () => {
    // A Shelly Pro 1: a relay with no metering at all.
    const keys = buildFeatureSpecs({ 'switch:0': { id: 0, output: true } }).map((spec) => spec.key);
    assert.deepEqual(keys, ['switch:0:binary']);
  });

  it('ignores an unknown component family instead of guessing', () => {
    const keys = buildFeatureSpecs({ 'quantumflux:0': { value: 42 } }).map((spec) => spec.key);
    assert.deepEqual(keys, []);
  });

  it('returns nothing on a missing or malformed status', () => {
    assert.deepEqual(buildFeatureSpecs(undefined), []);
    assert.deepEqual(buildFeatureSpecs(null), []);
    assert.deepEqual(buildFeatureSpecs('nope'), []);
  });
});

describe('buildDeviceName', () => {
  it('prefers the name the user set in the Shelly app', () => {
    const name = buildDeviceName({
      info: { id: 'shellypro3em-abc', model: 'SPEM-003CEBEU' },
      config: { sys: { device: { name: 'Tableau maison' } } },
    });
    assert.equal(name, 'Tableau maison');
  });

  it('falls back to the commercial model name, then the raw model, then the id', () => {
    assert.equal(
      buildDeviceName({ info: { id: 'shellypro3em-abc', model: 'SPEM-003CEBEU' } }),
      'Shelly Pro 3EM',
    );
    assert.equal(
      buildDeviceName({ info: { id: 'shellyfuture-abc', model: 'SXXX-999' } }),
      'SXXX-999',
    );
    assert.equal(buildDeviceName({ info: { id: 'shellyfuture-abc' } }), 'shellyfuture-abc');
  });
});

describe('buildDevice', () => {
  it('builds one Gladys device carrying every channel of a Pro 4PM', () => {
    const device = buildDevice({
      info: { id: 'shellypro4pm-ece334ea4d10', model: 'SPSW-004PE16EU', gen: 2 },
      status: PRO_4PM_STATUS,
      config: {
        sys: { device: { name: 'Éclairages RDC' } },
        'switch:0': { name: 'Salle de bain' },
        'switch:1': { name: 'WC' },
      },
      host: '10.5.0.180',
      externalIds: externalIdsFor('shellypro4pm-ece334ea4d10'),
    });

    assert.equal(device.name, 'Éclairages RDC');
    assert.equal(device.external_id, 'ext:shelly:device:shellypro4pm-ece334ea4d10');

    // The user-set channel name is what makes four "On/Off" features usable.
    const binary0 = device.features.find((feature) =>
      feature.external_id.endsWith(':switch:0:binary'),
    );
    assert.equal(binary0.name, 'Salle de bain — On/Off');
    assert.equal(binary0.read_only, false);
    assert.equal(binary0.has_feedback, true);
    assert.equal(binary0.min, 0);
    assert.equal(binary0.max, 1);

    // An unnamed channel of a multi-channel device is still distinguishable.
    const binary2 = device.features.find((feature) =>
      feature.external_id.endsWith(':switch:2:binary'),
    );
    assert.equal(binary2.name, 'On/Off (switch 2)');

    // Measurements are read-only.
    const power0 = device.features.find((feature) =>
      feature.external_id.endsWith(':switch:0:power'),
    );
    assert.equal(power0.read_only, true);
    assert.equal(power0.unit, 'watt');

    const params = Object.fromEntries(device.params.map((param) => [param.name, param.value]));
    assert.equal(params.IP_ADDRESS, '10.5.0.180');
    assert.equal(params.SHELLY_ID, 'shellypro4pm-ece334ea4d10');
    assert.equal(params.SHELLY_MODEL, 'SPSW-004PE16EU');
  });

  it('keeps a clean feature name on a single-channel device', () => {
    const device = buildDevice({
      info: { id: 'shellyplusplugs-fcb467266e2c', model: 'SNPL-00112EU', gen: 2 },
      status: { 'switch:0': { id: 0, output: false, apower: 0 } },
      externalIds: externalIdsFor('shellyplusplugs-fcb467266e2c'),
    });
    const binary = device.features.find((feature) => feature.external_id.endsWith(':binary'));
    assert.equal(binary.name, 'On/Off');
  });
});

describe('buildStates', () => {
  it('converts a Pro 3EM payload into the expected units', () => {
    const states = buildStates({
      status: PRO_3EM_STATUS,
      externalIds: externalIdsFor('shellypro3em-2cbcbba663cc'),
    });
    const byId = Object.fromEntries(
      states.map((state) => [state.device_feature_external_id, state.state]),
    );
    const prefix = 'ext:shelly:device:shellypro3em-2cbcbba663cc';

    // Power stays in watts, negative values (solar export) survive.
    assert.equal(byId[`${prefix}:em:0:l3_active_power`], -1150.3);
    assert.equal(byId[`${prefix}:em:0:total_active_power`], -1050.8);
    // Energy counters are converted from Wh to kWh.
    assert.equal(byId[`${prefix}:emdata:0:total_energy`], 21955.928);
    assert.equal(byId[`${prefix}:emdata:0:a_total_act_energy`], undefined);
    assert.equal(byId[`${prefix}:emdata:0:l1_total_energy`], 7915.525);
    assert.equal(byId[`${prefix}:em:0:neutral_current`], 6.926);
  });

  it('publishes 0 but never publishes a missing measurement', () => {
    const states = buildStates({
      status: {
        'switch:0': { id: 0, output: false, apower: 0, current: null },
      },
      externalIds: externalIdsFor('plug'),
    });
    const byId = Object.fromEntries(
      states.map((state) => [state.device_feature_external_id, state.state]),
    );
    // A real zero is a measurement and must be published.
    assert.equal(byId['ext:shelly:device:plug:switch:0:power'], 0);
    assert.equal(byId['ext:shelly:device:plug:switch:0:binary'], 0);
    // `current: null` is "not measured": no state at all, no fake zero.
    assert.equal(byId['ext:shelly:device:plug:switch:0:current'], undefined);
  });

  it('maps the boolean output to 1/0', () => {
    const states = buildStates({
      status: { 'switch:0': { id: 0, output: true } },
      externalIds: externalIdsFor('plug'),
    });
    assert.equal(states[0].state, 1);
  });
});

describe('readShellyId / readHost', () => {
  it('reads the params written at discovery', () => {
    const device = {
      external_id: 'ext:shelly:device:shellypro3em-abc',
      params: [
        { name: 'SHELLY_ID', value: 'shellypro3em-abc' },
        { name: 'IP_ADDRESS', value: '10.5.0.171' },
      ],
    };
    assert.equal(readShellyId(device), 'shellypro3em-abc');
    assert.equal(readHost(device), '10.5.0.171');
  });

  it('falls back to the external id when the param is missing', () => {
    assert.equal(
      readShellyId({ external_id: 'ext:shelly:device:shellypro3em-abc' }),
      'shellypro3em-abc',
    );
    assert.equal(readHost({ external_id: 'ext:shelly:device:shellypro3em-abc' }), undefined);
  });

  it('returns undefined on an external id that is not ours', () => {
    assert.equal(readShellyId({ external_id: 'mqtt:something' }), undefined);
    assert.equal(readShellyId(undefined), undefined);
  });
});
