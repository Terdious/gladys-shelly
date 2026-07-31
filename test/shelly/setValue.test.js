import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFeatureKey, setDeviceValue } from '../../src/shelly/setValue.js';

const DEVICE = {
  external_id: 'ext:shelly:device:shellypro4pm-ece334ea4d10',
  params: [
    { name: 'SHELLY_ID', value: 'shellypro4pm-ece334ea4d10' },
    { name: 'IP_ADDRESS', value: '10.5.0.180' },
  ],
};

/** Stubs recording what the command path asked of the SDK and the router. */
function harness({ setSwitch } = {}) {
  const published = [];
  const commands = [];
  return {
    published,
    commands,
    gladys: {
      async publishState(externalId, value) {
        published.push([externalId, value]);
      },
    },
    client: {
      async setSwitch(target, channel, on) {
        commands.push([target, channel, on]);
        if (setSwitch instanceof Error) {
          throw setSwitch;
        }
        return 'local';
      },
    },
  };
}

describe('parseFeatureKey', () => {
  it('reads the component coordinates out of a feature external id', () => {
    assert.deepEqual(
      parseFeatureKey('ext:shelly:device:shellypro4pm-ece334ea4d10:switch:2:binary'),
      { family: 'switch', index: 2, suffix: 'binary' },
    );
    assert.deepEqual(parseFeatureKey('ext:shelly:device:shellypro3em-abc:em:0:l1_active_power'), {
      family: 'em',
      index: 0,
      suffix: 'l1_active_power',
    });
  });

  it('returns undefined on an id that does not carry coordinates', () => {
    assert.equal(parseFeatureKey('ext:shelly:device:plug'), undefined);
    assert.equal(parseFeatureKey('mqtt:whatever'), undefined);
    assert.equal(parseFeatureKey(undefined), undefined);
  });
});

describe('setDeviceValue', () => {
  it('routes an On command to the right relay channel', async () => {
    const { gladys, client, commands, published } = harness();
    const feature = {
      external_id: 'ext:shelly:device:shellypro4pm-ece334ea4d10:switch:2:binary',
    };

    await setDeviceValue({ gladys, client }, { device: DEVICE, feature, value: 1 });

    assert.deepEqual(commands, [
      [{ shellyId: 'shellypro4pm-ece334ea4d10', host: '10.5.0.180' }, 2, true],
    ]);
    // Optimistic feedback: the switch must move in the UI now, not in 30 s.
    assert.deepEqual(published, [[feature.external_id, 1]]);
  });

  it('routes an Off command', async () => {
    const { gladys, client, commands } = harness();
    const feature = {
      external_id: 'ext:shelly:device:shellypro4pm-ece334ea4d10:switch:0:binary',
    };

    await setDeviceValue({ gladys, client }, { device: DEVICE, feature, value: 0 });

    assert.equal(commands[0][2], false);
  });

  it('refuses to act on a read-only measurement', async () => {
    const { gladys, client, commands } = harness();
    const feature = {
      external_id: 'ext:shelly:device:shellypro3em-abc:em:0:l1_active_power',
    };

    await assert.rejects(
      () => setDeviceValue({ gladys, client }, { device: DEVICE, feature, value: 1 }),
      /not controllable/,
    );
    assert.deepEqual(commands, []);
  });

  it('fails when the device carries no resolvable Shelly id', async () => {
    const { gladys, client } = harness();
    await assert.rejects(
      () =>
        setDeviceValue(
          { gladys, client },
          {
            device: { external_id: 'mqtt:something' },
            feature: { external_id: 'mqtt:something:switch:0:binary' },
            value: 1,
          },
        ),
      /Cannot resolve the Shelly id/,
    );
  });

  it('propagates a delivery failure instead of acking a success', async () => {
    const { gladys, client, published } = harness({ setSwitch: new Error('unreachable') });
    const feature = {
      external_id: 'ext:shelly:device:shellypro4pm-ece334ea4d10:switch:1:binary',
    };

    await assert.rejects(
      () => setDeviceValue({ gladys, client }, { device: DEVICE, feature, value: 1 }),
      /unreachable/,
    );
    // No optimistic state on a failed command: the UI must not lie.
    assert.deepEqual(published, []);
  });
});
