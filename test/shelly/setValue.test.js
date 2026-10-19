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
function harness({ fail } = {}) {
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
      async sendCommand(target, command) {
        commands.push([target, command.rpc]);
        if (fail instanceof Error) {
          throw fail;
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
      [
        { shellyId: 'shellypro4pm-ece334ea4d10', host: '10.5.0.180', gen: 2 },
        { method: 'Switch.Set', params: { id: 2, on: true } },
      ],
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

    assert.deepEqual(commands[0][1], { method: 'Switch.Set', params: { id: 0, on: false } });
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
    const { gladys, client, published } = harness({ fail: new Error('unreachable') });
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

describe('setDeviceValue on covers and lights', () => {
  const run = async (suffixPath, value) => {
    const { gladys, client, commands, published } = harness();
    const feature = { external_id: `ext:shelly:device:shellypro4pm-ece334ea4d10:${suffixPath}` };
    await setDeviceValue({ gladys, client }, { device: DEVICE, feature, value });
    return { rpc: commands[0][1], published: published[0][1] };
  };

  it('opens, closes and stops a cover with the Gladys shutter values', async () => {
    assert.deepEqual((await run('cover:0:state', 1)).rpc, {
      method: 'Cover.Open',
      params: { id: 0 },
    });
    assert.deepEqual((await run('cover:0:state', -1)).rpc, {
      method: 'Cover.Close',
      params: { id: 0 },
    });
    assert.deepEqual((await run('cover:1:state', 0)).rpc, {
      method: 'Cover.Stop',
      params: { id: 1 },
    });
  });

  it('moves a cover to a position, 100 being fully open on both sides', async () => {
    const { rpc, published } = await run('cover:0:position', 100);
    assert.deepEqual(rpc, { method: 'Cover.GoToPosition', params: { id: 0, pos: 100 } });
    assert.equal(published, 100);
    assert.deepEqual((await run('cover:0:position', 140)).rpc.params, { id: 0, pos: 100 });
  });

  it('switches and dims a light without touching the other setting', async () => {
    assert.deepEqual((await run('light:0:binary', 1)).rpc, {
      method: 'Light.Set',
      params: { id: 0, on: true },
    });
    assert.deepEqual((await run('light:0:brightness', 35)).rpc, {
      method: 'Light.Set',
      params: { id: 0, brightness: 35 },
    });
  });

  it('sets a colour and a colour temperature', async () => {
    const color = await run('rgbw:0:color', 0xff8000);
    assert.deepEqual(color.rpc, { method: 'RGBW.Set', params: { id: 0, rgb: [255, 128, 0] } });
    assert.equal(color.published, 0xff8000);

    // 250 mireds = 4000 K.
    assert.deepEqual((await run('cct:0:temperature', 250)).rpc, {
      method: 'CCT.Set',
      params: { id: 0, ct: 4000 },
    });
  });

  it('refuses the read-only features of the new families', async () => {
    const { gladys, client } = harness();
    for (const suffixPath of ['cover:0:power', 'input:0:binary', 'light:0:power']) {
      await assert.rejects(
        () =>
          setDeviceValue(
            { gladys, client },
            {
              device: DEVICE,
              feature: { external_id: `ext:shelly:device:x:${suffixPath}` },
              value: 1,
            },
          ),
        /not controllable/,
      );
    }
  });
});
