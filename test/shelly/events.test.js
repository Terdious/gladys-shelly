import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import {
  createTelemetry,
  INPUT_EVENT_TRIGGER,
  REACHABILITY_TRIGGER,
} from '../../src/shelly/telemetry.js';

/** A fake Gladys recording states and scene events. */
function fakeGladys(devices = []) {
  const states = [];
  const sceneEvents = [];
  return {
    states,
    sceneEvents,
    devices,
    async getDevices() {
      return devices;
    },
    async publishState(externalId, value) {
      states.push([externalId, value]);
    },
    async publishStates() {},
    async publishTransports() {},
    async publishSceneEvent(key, data) {
      sceneEvents.push([key, data]);
    },
    externalIds(type, platformId) {
      return {
        device: `ext:shelly:${type}:${platformId}`,
        feature: (key) => `ext:shelly:${type}:${platformId}:${key}`,
      };
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('pushed button events', () => {
  it('publishes the button value and fires the input_event trigger once', async () => {
    const gladys = fakeGladys([{ external_id: 'ext:shelly:device:i4', name: 'Hall buttons' }]);
    const config = normalizeConfig();
    const telemetry = createTelemetry({ gladys, client: {}, getConfig: () => config });

    const events = [{ component: 'input:2', id: 2, event: 'double_push', ts: 1768813600.1 }];
    telemetry.handleEvents('i4', events);
    // The same press, delivered a second time by the other channel (MQTT).
    telemetry.handleEvents('i4', events);
    // Not a button event: ignored.
    telemetry.handleEvents('i4', [{ component: 'sys', event: 'scheduled_restart' }]);
    await flush();

    assert.deepEqual(gladys.states, [['ext:shelly:device:i4:input:2:button', 2]]);
    assert.deepEqual(gladys.sceneEvents, [
      [
        INPUT_EVENT_TRIGGER,
        {
          device: 'ext:shelly:device:i4',
          input: '2',
          event: 'double_push',
          device_name: 'Hall buttons',
        },
      ],
    ]);
    telemetry.stop();
  });

  it('maps single, long and triple presses to the Gladys button values', async () => {
    const gladys = fakeGladys();
    const config = normalizeConfig();
    const telemetry = createTelemetry({ gladys, client: {}, getConfig: () => config });
    telemetry.handleEvents('b', [
      { component: 'input:0', event: 'single_push', ts: 1 },
      { component: 'input:0', event: 'long_push', ts: 2 },
      { component: 'input:0', event: 'triple_push', ts: 3 },
    ]);
    await flush();
    assert.deepEqual(
      gladys.states.map(([, value]) => value),
      [1, 6, 18],
    );
    telemetry.stop();
  });
});

describe('reachability trigger', () => {
  it('fires on the transitions to and from unreachable, never on the first reading', async () => {
    const gladys = fakeGladys([
      {
        external_id: 'ext:shelly:device:plug',
        name: 'Kettle plug',
        params: [
          { name: 'SHELLY_ID', value: 'plug' },
          { name: 'IP_ADDRESS', value: '10.5.0.9' },
        ],
      },
    ]);
    const config = normalizeConfig();
    let reachable = false;
    const client = {
      async getStatus() {
        if (!reachable) {
          throw new Error('timeout');
        }
        return { status: { 'switch:0': { output: true } }, transport: 'local' };
      },
    };
    const telemetry = createTelemetry({ gladys, client, getConfig: () => config });

    await telemetry.refreshValues(); // first reading: unreachable, no event
    reachable = true;
    await telemetry.refreshValues(); // back
    reachable = false;
    await telemetry.refreshValues(); // gone again
    await flush();

    assert.deepEqual(
      gladys.sceneEvents.map(([key, data]) => [key, data.state, data.device_name]),
      [
        [REACHABILITY_TRIGGER, 'reachable', 'Kettle plug'],
        [REACHABILITY_TRIGGER, 'unreachable', 'Kettle plug'],
      ],
    );
    assert.equal(telemetry.describeDevice('plug').transport.transport, 'unreachable');
    telemetry.stop();
  });
});
