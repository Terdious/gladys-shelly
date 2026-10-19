import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSceneActions, outputOf } from '../src/scenes.js';
import { buildDevice } from '../src/shelly/deviceMapping.js';

const externalIdsFor = (shellyId) => ({
  device: `ext:shelly:device:${shellyId}`,
  feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
});

function created(shellyId, status, gen = 2) {
  const device = buildDevice({
    info: { id: shellyId, gen },
    status,
    host: '10.5.0.20',
    externalIds: externalIdsFor(shellyId),
  });
  return device;
}

function harness(devices) {
  const commands = [];
  const states = [];
  const gladys = {
    async getDevices() {
      return devices;
    },
    async publishState(id, value) {
      states.push([id, value]);
    },
  };
  const client = {
    async sendCommand(target, command) {
      commands.push({ target, command });
      return 'local';
    },
  };
  return { actions: createSceneActions({ gladys, client }), commands, states };
}

describe('turn_on_for scene action', () => {
  it('lets the relay switch itself off: toggle_after on Gen2+, timer on Gen1', async () => {
    const pump = created('shellyplus1-pump', { 'switch:0': { id: 0, output: false } });
    const { actions, commands, states } = harness([pump]);

    const outputs = await actions.turn_on_for({
      device: pump.external_id,
      channel: 0,
      duration: 900,
    });

    assert.deepEqual(outputs, { transport: 'local' });
    assert.deepEqual(commands[0].command.rpc, {
      method: 'Switch.Set',
      params: { id: 0, on: true, toggle_after: 900 },
    });
    assert.equal(commands[0].command.gen1, '/relay/0?turn=on&timer=900');
    // No cloud spelling: a plain "on" without the device timer is not offered.
    assert.equal(commands[0].command.cloud, undefined);
    assert.deepEqual(states, [[`${pump.external_id}:switch:0:binary`, 1]]);
  });

  it('drives a dimmer with Light.Set', async () => {
    const dimmer = created('shellyplusdimmer-x', {
      'light:0': { id: 0, output: false, brightness: 30 },
    });
    const { actions, commands } = harness([dimmer]);
    await actions.turn_on_for({ device: dimmer.external_id, duration: 60 });
    assert.equal(commands[0].command.rpc.method, 'Light.Set');
    assert.equal(outputOf(dimmer, 0).family, 'light');
  });

  it('refuses an unknown device, a missing output and an out-of-range duration', async () => {
    const plug = created('shellyplug-y', { 'switch:0': { id: 0, output: false } });
    const { actions, commands } = harness([plug]);
    await assert.rejects(
      () => actions.turn_on_for({ device: 'ext:other', duration: 10 }),
      /Unknown/,
    );
    await assert.rejects(
      () => actions.turn_on_for({ device: plug.external_id, channel: 3, duration: 10 }),
      /no on\/off output 3/,
    );
    await assert.rejects(
      () => actions.turn_on_for({ device: plug.external_id, duration: 0 }),
      /Duration/,
    );
    await assert.rejects(
      () => actions.turn_on_for({ device: plug.external_id, duration: 90000 }),
      /Duration/,
    );
    assert.equal(commands.length, 0);
  });
});

describe('reboot scene action', () => {
  it('sends Shelly.Reboot, or /reboot to a Gen1', async () => {
    const plug = created('shellyplug-y', { 'switch:0': { id: 0, output: false } });
    const { actions, commands } = harness([plug]);
    assert.deepEqual(await actions.reboot({ device: plug.external_id }), { transport: 'local' });
    assert.equal(commands[0].command.rpc.method, 'Shelly.Reboot');
    assert.equal(commands[0].command.gen1, '/reboot');
  });
});
