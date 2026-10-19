import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { SLEEPY_SILENCE_MS } from '../../src/shelly/constants.js';
import { buildDevice, buildStates, isSleepyDevice } from '../../src/shelly/deviceMapping.js';
import { normalizeGen1Status } from '../../src/shelly/gen1/normalize.js';
import { parseGen1Topic } from '../../src/shelly/mqttHub.js';
import { createTelemetry, INPUT_EVENT_TRIGGER } from '../../src/shelly/telemetry.js';

const externalIdsFor = (shellyId) => ({
  device: `ext:shelly:device:${shellyId}`,
  feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
});
const stateOf = (status, key) =>
  buildStates({ status, externalIds: externalIdsFor('x') }).find(
    (s) => s.device_feature_external_id === `ext:shelly:device:x:${key}`,
  )?.state;

describe('Gen1 battery sensors (issue #7)', () => {
  it('maps a Flood, a Smoke and a Door/Window', () => {
    const flood = normalizeGen1Status({ flood: true, tmp: { tC: 18.2 }, bat: { value: 87 } });
    assert.equal(stateOf(flood, 'flood:0:alarm'), 1);
    assert.equal(stateOf(flood, 'temperature:0:temperature'), 18.2);
    assert.equal(stateOf(normalizeGen1Status({ smoke: false }), 'smoke:0:alarm'), 0);

    const door = normalizeGen1Status({
      sensor: { state: 'open', is_valid: true },
      lux: { value: 120, illumination: 'twilight' },
      bat: { value: 99 },
    });
    // Gladys opening sensors: 0 = open, 1 = closed.
    assert.equal(stateOf(door, 'contact:0:binary'), 0);
    assert.equal(
      stateOf(normalizeGen1Status({ sensor: { state: 'close' } }), 'contact:0:binary'),
      1,
    );
    assert.equal(stateOf(door, 'illuminance:0:lux'), 120);
    // Not calibrated yet: nothing rather than a guess.
    assert.equal(
      normalizeGen1Status({ sensor: { state: 'open', is_valid: false } })['contact:0'],
      undefined,
    );
  });

  it('gives the sensors their Gladys categories', () => {
    const status = normalizeGen1Status({
      flood: false,
      sensor: { state: 'close' },
      lux: { value: 3 },
    });
    const device = buildDevice({
      info: { id: 'shellyflood-a', model: 'SHWT-1', gen: 1 },
      status,
      externalIds: externalIdsFor('shellyflood-a'),
    });
    const categories = Object.fromEntries(
      device.features.map((f) => [f.external_id.split(':').slice(-3).join(':'), f.category]),
    );
    assert.equal(categories['flood:0:alarm'], 'leak-sensor');
    assert.equal(categories['contact:0:binary'], 'opening-sensor');
    assert.equal(categories['illuminance:0:lux'], 'light-sensor');
  });

  it('flags sleepy devices by model, sleep_mode or missing external power', () => {
    assert.equal(isSleepyDevice({ model: 'SHHT-1' }), true);
    assert.equal(isSleepyDevice({ model: 'SHEM-3', info: { sleep_mode: true } }), true);
    assert.equal(
      isSleepyDevice({
        status: { 'devicepower:0': { battery: { percent: 80 }, external: { present: false } } },
      }),
      true,
    );
    assert.equal(isSleepyDevice({ model: 'SHEM-3' }), false);
    const device = buildDevice({
      info: { id: 'shellyht-a', model: 'SHHT-1', gen: 1 },
      status: { 'temperature:0': { tC: 20 } },
      externalIds: externalIdsFor('shellyht-a'),
    });
    assert.ok(device.params.some((p) => p.name === 'SHELLY_SLEEPY' && p.value === '1'));
  });

  it('reads the Gen1 sensor and button topics on MQTT', () => {
    assert.deepEqual(parseGen1Topic('shellies/shellydw2-a/sensor/state', 'open').status, {
      'contact:0': { id: 0, open: true },
    });
    assert.deepEqual(parseGen1Topic('shellies/shellyflood-a/sensor/flood', 'true').status, {
      'flood:0': { id: 0, alarm: true },
    });
    assert.deepEqual(parseGen1Topic('shellies/shellydw2-a/sensor/lux', '42').status, {
      'illuminance:0': { id: 0, lux: 42 },
    });
    assert.deepEqual(parseGen1Topic('shellies/shellyix3-a/input/1', '1').status, {
      'input:1': { id: 1, state: true },
    });
    assert.deepEqual(
      parseGen1Topic('shellies/shellyix3-a/input_event/2', '{"event":"SS","event_cnt":7}').events,
      [{ component: 'input:2', event: 'double_push', ts: 'gen1-7' }],
    );
    assert.equal(parseGen1Topic('shellies/shellyix3-a/input_event/2', '{"event":"SL"}'), undefined);
  });
});

/** A fake Gladys + telemetry over one created device with a scripted client. */
function harness({ params, getStatus, now }) {
  const transports = [];
  const sceneEvents = [];
  const states = [];
  const gladys = {
    devices: [],
    async getDevices() {
      return [{ external_id: 'ext:shelly:device:dev', params }];
    },
    async publishStates() {},
    async publishState(id, value) {
      states.push([id, value]);
    },
    async publishTransports(entries) {
      transports.push(...entries);
    },
    async publishSceneEvent(key, data) {
      sceneEvents.push([key, data]);
    },
    externalIds: (type, id) => ({
      device: `ext:shelly:${type}:${id}`,
      feature: (key) => `ext:shelly:${type}:${id}:${key}`,
    }),
  };
  const config = normalizeConfig();
  const telemetry = createTelemetry({
    gladys,
    client: { getStatus },
    getConfig: () => config,
    now,
  });
  return { telemetry, transports, sceneEvents, states };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('sleepy devices are not reported unreachable while asleep', () => {
  const params = [
    { name: 'SHELLY_ID', value: 'dev' },
    { name: 'IP_ADDRESS', value: '10.5.0.60' },
    { name: 'SHELLY_MODEL', value: 'SHHT-1' },
  ];

  it('stays local while it reported recently, unreachable after a day and more of silence', async () => {
    let clock = 1_000_000;
    let awake = true;
    const { telemetry, transports, sceneEvents } = harness({
      params,
      now: () => clock,
      getStatus: async () => {
        if (!awake) {
          throw new Error('timeout');
        }
        return { status: normalizeGen1Status({ tmp: { tC: 20 } }), transport: 'local' };
      },
    });

    await telemetry.refreshValues(); // awake: read
    awake = false;
    clock += 60 * 60 * 1000;
    await telemetry.refreshValues(); // asleep one hour later: still local
    clock += SLEEPY_SILENCE_MS;
    await telemetry.refreshValues(); // silent for more than a day: unreachable
    await flush();

    assert.deepEqual(
      transports.map((entry) => entry.transport),
      ['local', 'unreachable'],
    );
    // One genuine transition: the scene trigger fires once, not every wake-up.
    assert.deepEqual(
      sceneEvents.map(([, data]) => data.state),
      ['unreachable'],
    );
    telemetry.stop();
  });
});

describe('Gen1 button presses from the polled counter', () => {
  it('turns an increase of event_cnt into a press, once', async () => {
    let status = { inputs: [{ input: 0, event: 'S', event_cnt: 4 }] };
    const { telemetry, states, sceneEvents } = harness({
      params: [
        { name: 'SHELLY_ID', value: 'dev' },
        { name: 'IP_ADDRESS', value: '10.5.0.61' },
        { name: 'SHELLY_GEN', value: '1' },
      ],
      getStatus: async () => ({ status: normalizeGen1Status(status), transport: 'local' }),
    });

    await telemetry.refreshValues(); // first reading: only records the counter
    status = { inputs: [{ input: 0, event: 'L', event_cnt: 5 }] };
    await telemetry.refreshValues(); // one long press
    // The same press relayed by MQTT afterwards is not counted twice.
    telemetry.handleEvents('dev', [{ component: 'input:0', event: 'long_push', ts: 'gen1-5' }]);
    await telemetry.refreshValues(); // nothing new
    await flush();

    assert.deepEqual(states, [['ext:shelly:device:dev:input:0:button', 6]]);
    assert.deepEqual(
      sceneEvents.filter(([key]) => key === INPUT_EVENT_TRIGGER).map(([, data]) => data.event),
      ['long_push'],
    );
    telemetry.stop();
  });
});
