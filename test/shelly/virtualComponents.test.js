import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { buildDevice, buildStates } from '../../src/shelly/deviceMapping.js';
import { discoverDevices, forgetSeenHosts } from '../../src/shelly/discovery.js';
import { buildFeatureSpecs } from '../../src/shelly/features.js';
import { setDeviceValue } from '../../src/shelly/setValue.js';
import { createTelemetry } from '../../src/shelly/telemetry.js';
import {
  fetchVirtualComponents,
  hasVirtualComponents,
  prepareNumberValue,
} from '../../src/shelly/virtualComponents.js';
import {
  PRO_3EM_STATUS,
  PRO_4PM_STATUS,
  ST1820_COMPONENTS,
  ST1820_INFO,
  ST1820_STATUS,
  startFakeShelly,
} from '../helpers/fakeShelly.js';

/** Stand-in for `gladys.externalIds('device', id)`. */
function externalIdsFor(shellyId) {
  return {
    device: `ext:shelly:device:${shellyId}`,
    feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
  };
}

/** Poll until `predicate()` is truthy (or fail after `timeout` ms). */
async function waitFor(predicate, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** A router wired to the real RPC stack, with no cloud configured. */
function routerFor(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const client = createShellyClient({
    getConfig: () => config,
    cloud: {
      async getStatus() {
        throw new Error('cloud not configured');
      },
    },
  });
  return { client, config };
}

/** The metadata map `fetchVirtualComponents` builds from the fixture. */
const ST1820_METADATA = Object.fromEntries(
  ST1820_COMPONENTS.filter((entry) => /^(number|boolean|enum):/.test(entry.key)).map((entry) => [
    entry.key,
    { config: entry.config, attrs: entry.attrs },
  ]),
);

/** The ST1820 as discovery builds it, with the full metadata. */
function st1820Device() {
  return buildDevice({
    info: ST1820_INFO,
    status: ST1820_STATUS,
    config: { sys: { device: { name: null } } },
    host: '192.168.1.111',
    externalIds: externalIdsFor(ST1820_INFO.id),
    components: ST1820_METADATA,
  });
}

/** Feature of a built device, by its component key. */
function featureOf(device, key) {
  return device.features.find((feature) => feature.external_id.endsWith(`:${key}`));
}

describe('Shelly.GetComponents pagination', () => {
  it('reads every page until `total` is reached (15 = 10 + 5)', async () => {
    const calls = [];
    const components = await fetchVirtualComponents(async (method, params) => {
      calls.push([method, params]);
      return {
        components: ST1820_COMPONENTS.slice(params.offset, params.offset + 10),
        offset: params.offset,
        total: ST1820_COMPONENTS.length,
      };
    });

    assert.deepEqual(
      calls.map(([method, params]) => [method, params.offset]),
      [
        ['Shelly.GetComponents', 0],
        ['Shelly.GetComponents', 10],
      ],
    );
    // All seven virtual components, wherever they sat across the two pages.
    assert.deepEqual(Object.keys(components).sort(), [
      'boolean:200',
      'boolean:201',
      'boolean:202',
      'boolean:203',
      'number:200',
      'number:201',
      'number:202',
    ]);
    assert.equal(components['number:202'].attrs.role, 'target_temperature');
    // System components and the service itself never become metadata.
    assert.equal(components['service:0'], undefined);
    assert.equal(components.sys, undefined);
  });

  it('stops on an empty page even if `total` is never reached', async () => {
    let calls = 0;
    const components = await fetchVirtualComponents(async () => {
      calls += 1;
      return { components: [], offset: 0, total: 99 };
    });
    assert.equal(calls, 1);
    assert.deepEqual(components, {});
  });

  it('paginates against a real fake device over HTTP', async () => {
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status: structuredClone(ST1820_STATUS),
      components: ST1820_COMPONENTS,
    });
    try {
      const { client } = routerFor();
      const components = await client.componentsFor({
        shellyId: ST1820_INFO.id,
        host: shelly.host,
      });
      assert.equal(Object.keys(components).length, 7);
      const pages = shelly.calls.filter((call) => call.method === 'Shelly.GetComponents');
      assert.deepEqual(
        pages.map((call) => call.params.offset),
        [0, 10],
      );
      // Cached: a second ask costs nothing.
      await client.componentsFor({ shellyId: ST1820_INFO.id, host: shelly.host });
      assert.equal(shelly.calls.filter((c) => c.method === 'Shelly.GetComponents').length, 2);
    } finally {
      await shelly.close();
    }
  });
});

describe('virtual component -> Gladys feature mapping', () => {
  it('creates the 7 features of an ST1820', () => {
    const device = st1820Device();
    assert.equal(device.features.length, 7);
    assert.deepEqual(device.features.map((feature) => feature.name).sort(), [
      'Anti-freeze',
      'C1C2 relay status',
      'Child lock',
      'Current humidity',
      'Current temperature',
      'Enable thermostat',
      'Target temperature',
    ]);
  });

  it('maps the setpoint from its `attrs.role`, with its range', () => {
    const setpoint = featureOf(st1820Device(), 'number:202:value');
    assert.equal(setpoint.category, 'thermostat');
    assert.equal(setpoint.type, 'target-temperature');
    assert.equal(setpoint.unit, 'celsius');
    assert.equal(setpoint.min, 15);
    assert.equal(setpoint.max, 35);
    assert.equal(setpoint.read_only, false);
    assert.equal(setpoint.has_feedback, true);
    assert.equal(setpoint.external_id, 'ext:shelly:device:st1820-70af09fce0c8:number:202:value');
  });

  it('falls back on the unit and access when there is no role', () => {
    const device = st1820Device();
    const temperature = featureOf(device, 'number:201:value');
    assert.equal(temperature.category, 'temperature-sensor');
    assert.equal(temperature.type, 'decimal');
    assert.equal(temperature.unit, 'celsius');
    assert.equal(temperature.read_only, true);

    const humidity = featureOf(device, 'number:200:value');
    assert.equal(humidity.category, 'humidity-sensor');
    assert.equal(humidity.unit, 'percent');
    assert.equal(humidity.read_only, true);

    const enable = featureOf(device, 'boolean:202:binary');
    assert.equal(enable.category, 'switch');
    assert.equal(enable.type, 'binary');
    assert.equal(enable.read_only, false);

    const relay = featureOf(device, 'boolean:203:binary');
    assert.equal(relay.category, 'switch');
    assert.equal(relay.read_only, true);
  });

  it('uses a known role over the name and unit when the device sets one', () => {
    const metadata = {
      ...ST1820_METADATA,
      'number:201': {
        config: { name: 'Room', access: 'cr' },
        attrs: { role: 'current_temperature' },
      },
      'boolean:201': { config: { name: 'Lock', access: 'crw' }, attrs: { role: 'child_lock' } },
    };
    const specs = buildFeatureSpecs(ST1820_STATUS, metadata);
    const room = specs.find((spec) => spec.key === 'number:201:value');
    // No unit declared at all: the role alone says it is a temperature.
    assert.equal(room.category, 'temperature-sensor');
    assert.equal(room.unit, 'celsius');
    const lock = specs.find((spec) => spec.key === 'boolean:201:binary');
    assert.equal(lock.category, 'child-lock');
  });

  it('never lets a measurement role be written, whatever `access` says', () => {
    const specs = buildFeatureSpecs(ST1820_STATUS, {
      'number:201': { config: { access: 'crw' }, attrs: { role: 'current_temperature' } },
    });
    assert.equal(specs.find((spec) => spec.key === 'number:201:value').read_only, true);
  });

  it('keeps the SAME features without metadata, only with plainer names', () => {
    const withMeta = buildFeatureSpecs(ST1820_STATUS, ST1820_METADATA).map((spec) => spec.key);
    const bare = buildFeatureSpecs(ST1820_STATUS);
    assert.deepEqual(
      bare.map((spec) => spec.key),
      withMeta,
    );
    assert.equal(bare.find((spec) => spec.key === 'number:202:value').name, 'Number 202');
    // Unknown access is read-only: never offer a control the device may refuse.
    assert.ok(bare.every((spec) => spec.read_only === true));
  });

  it('falls back on the Shelly.GetConfig names when GetComponents was not read', () => {
    const configs = Object.fromEntries(
      Object.entries(ST1820_METADATA).map(([key, meta]) => [key, meta.config]),
    );
    const device = buildDevice({
      info: ST1820_INFO,
      status: ST1820_STATUS,
      config: { sys: { device: { name: 'Salon' } }, ...configs },
      externalIds: externalIdsFor(ST1820_INFO.id),
    });
    assert.equal(device.name, 'Salon');
    const setpoint = featureOf(device, 'number:202:value');
    // No role from GetConfig, but a writable °C is still a setpoint.
    assert.equal(setpoint.name, 'Target temperature');
    assert.equal(setpoint.category, 'thermostat');
    assert.equal(setpoint.read_only, false);
  });

  it('does not create features from service, system or enum components', () => {
    const specs = buildFeatureSpecs({ ...ST1820_STATUS, 'enum:200': { value: 'auto' } });
    assert.ok(specs.every((spec) => /^(number|boolean):/.test(spec.key)));
  });

  it('reads the values: booleans as 0/1, numbers as they are', () => {
    const states = buildStates({
      status: ST1820_STATUS,
      externalIds: externalIdsFor(ST1820_INFO.id),
    });
    const value = (key) =>
      states.find((s) => s.device_feature_external_id.endsWith(`:${key}`))?.state;
    assert.equal(value('number:200:value'), 48);
    assert.equal(value('number:201:value'), 24.6);
    assert.equal(value('number:202:value'), 20);
    assert.equal(value('boolean:202:binary'), 1);
    assert.equal(value('boolean:203:binary'), 0);
  });

  it('puts on/off states on the real-time lane and slow sensors off it', () => {
    const specs = buildFeatureSpecs(ST1820_STATUS, ST1820_METADATA);
    const fast = (key) => {
      const spec = specs.find((s) => s.key === key);
      return spec.realtime === true || spec.read_only === false;
    };
    assert.equal(fast('boolean:203:binary'), true);
    assert.equal(fast('boolean:202:binary'), true);
    assert.equal(fast('number:202:value'), true);
    assert.equal(fast('number:200:value'), false);
    assert.equal(fast('number:201:value'), false);
  });
});

describe('existing devices are unchanged', () => {
  it('maps Pro 3EM, Pro 4PM and Plus Plug S exactly as before', () => {
    const plug = { 'switch:0': { id: 0, output: false, apower: 0, aenergy: { total: 1 } } };
    [PRO_3EM_STATUS, PRO_4PM_STATUS, plug].forEach((status) => {
      assert.equal(hasVirtualComponents(status), false);
      const keys = buildFeatureSpecs(status).map((spec) => spec.key);
      assert.deepEqual(
        buildFeatureSpecs(status, {}).map((spec) => spec.key),
        keys,
      );
      assert.ok(keys.every((key) => !/^(number|boolean|enum):/.test(key)));
    });
  });

  it('never calls Shelly.GetComponents on a device without virtual components', async () => {
    forgetSeenHosts();
    const shelly = await startFakeShelly({
      info: { id: 'shellypro4pm-ece334ea4d10', mac: 'ECE334EA4D10', gen: 2 },
      status: PRO_4PM_STATUS,
    });
    try {
      const { client, config } = routerFor({ manual_hosts: shelly.host });
      const found = await discoverDevices({ gladys: fakeGladys(), client, config });
      assert.equal(found.length, 1);
      assert.ok(!shelly.calls.some((call) => call.method === 'Shelly.GetComponents'));
    } finally {
      await shelly.close();
      forgetSeenHosts();
    }
  });
});

/** A fake SDK, enough for discovery. */
function fakeGladys() {
  return {
    async scanNetwork() {
      return [];
    },
    externalIds: (type, id) => externalIdsFor(id),
  };
}

describe('ST1820 discovery', () => {
  beforeEach(() => forgetSeenHosts());
  after(() => forgetSeenHosts());

  it('re-scanning creates the thermostat with its 7 features', async () => {
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status: structuredClone(ST1820_STATUS),
      components: ST1820_COMPONENTS,
    });
    try {
      const { client, config } = routerFor({ manual_hosts: shelly.host });
      const [device] = await discoverDevices({ gladys: fakeGladys(), client, config });
      assert.equal(device.features.length, 7);
      assert.equal(featureOf(device, 'number:202:value').category, 'thermostat');
      // The scan fills the router's cache: commands and the push lane reuse it.
      assert.equal(
        client.cachedComponents(ST1820_INFO.id)['number:202'].attrs.role,
        'target_temperature',
      );
    } finally {
      await shelly.close();
    }
  });

  it('finds the 7 features when the firmware hides them from Shelly.GetStatus', async () => {
    // What a real ST1820 (firmware 2.0.1) does: `Shelly.GetStatus` only has
    // `service:0`, the values are in `Shelly.GetComponents` alone.
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status: structuredClone(ST1820_STATUS),
      components: ST1820_COMPONENTS,
      hideVirtual: true,
    });
    try {
      const { client, config } = routerFor({ manual_hosts: shelly.host });
      const [device] = await discoverDevices({ gladys: fakeGladys(), client, config });
      assert.equal(device.name, 'Starlight Thermostat ST1820');
      assert.deepEqual(
        device.features.map((feature) => feature.external_id.split(':').slice(-3).join(':')).sort(),
        [
          'boolean:200:binary',
          'boolean:201:binary',
          'boolean:202:binary',
          'boolean:203:binary',
          'number:200:value',
          'number:201:value',
          'number:202:value',
        ],
      );
      assert.equal(featureOf(device, 'number:202:value').read_only, false);
    } finally {
      await shelly.close();
    }
  });
});

describe('ST1820 polling when the firmware hides its values', () => {
  it('completes the status from Shelly.GetComponents on every poll', async () => {
    const status = structuredClone(ST1820_STATUS);
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status,
      components: ST1820_COMPONENTS,
      hideVirtual: true,
    });
    try {
      const { client } = routerFor();
      const target = { shellyId: ST1820_INFO.id, host: shelly.host, gen: 3 };
      const read = async () => {
        const result = await client.getStatus(target);
        return Object.fromEntries(
          buildStates({ status: result.status, externalIds: externalIdsFor(ST1820_INFO.id) }).map(
            (state) => [
              state.device_feature_external_id.split(':').slice(-3).join(':'),
              state.state,
            ],
          ),
        );
      };

      const first = await read();
      assert.equal(Object.keys(first).length, 7);
      assert.equal(first['number:201:value'], 24.6);
      assert.equal(first['boolean:202:binary'], 1);
      // The metadata came along: commands and the push lane can use it.
      assert.equal(
        client.cachedComponents(ST1820_INFO.id)['number:202'].attrs.role,
        'target_temperature',
      );

      // A change on the device shows up on the next poll.
      status['number:202'].value = 22.5;
      assert.equal((await read())['number:202:value'], 22.5);
    } finally {
      await shelly.close();
    }
  });

  it('still returns the status when Shelly.GetComponents fails', async () => {
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status: structuredClone(ST1820_STATUS),
      // No components served: every page comes back empty.
      hideVirtual: true,
    });
    try {
      const { client } = routerFor();
      const { status, transport } = await client.getStatus({
        shellyId: ST1820_INFO.id,
        host: shelly.host,
      });
      assert.equal(transport, 'local');
      assert.ok(status['service:0']);
      assert.equal(hasVirtualComponents(status), false);
    } finally {
      await shelly.close();
    }
  });

  it('does not read Shelly.GetComponents when polling a device without a service', async () => {
    const shelly = await startFakeShelly({
      info: { id: 'shellypro4pm-ece334ea4d10', mac: 'ECE334EA4D10', gen: 2 },
      status: PRO_4PM_STATUS,
    });
    try {
      const { client } = routerFor();
      await client.getStatus({ shellyId: 'shellypro4pm-ece334ea4d10', host: shelly.host });
      assert.ok(!shelly.calls.some((call) => call.method === 'Shelly.GetComponents'));
    } finally {
      await shelly.close();
    }
  });
});

describe('controlling virtual components', () => {
  /** Stubs recording what the command path asked of the SDK and the router. */
  function harness(components = ST1820_METADATA) {
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
        async componentsFor() {
          return components;
        },
        async setVirtual(target, family, id, value) {
          commands.push([family, id, value]);
          return 'local';
        },
      },
    };
  }

  const device = {
    external_id: `ext:shelly:device:${ST1820_INFO.id}`,
    params: [
      { name: 'SHELLY_ID', value: ST1820_INFO.id },
      { name: 'IP_ADDRESS', value: '192.168.1.111' },
    ],
  };
  const feature = (key, extra = {}) => ({
    external_id: `ext:shelly:device:${ST1820_INFO.id}:${key}`,
    ...extra,
  });

  it('sends Number.Set for the setpoint, snapped to the 0.5 step', async () => {
    const { gladys, client, commands, published } = harness();
    await setDeviceValue(
      { gladys, client },
      { device, feature: feature('number:202:value'), value: 21.3 },
    );
    assert.deepEqual(commands, [['number', 202, 21.5]]);
    assert.deepEqual(published, [[feature('number:202:value').external_id, 21.5]]);
  });

  it('clamps the setpoint to the declared range', async () => {
    const { gladys, client, commands } = harness();
    await setDeviceValue(
      { gladys, client },
      { device, feature: feature('number:202:value'), value: 40 },
    );
    await setDeviceValue(
      { gladys, client },
      { device, feature: feature('number:202:value'), value: 3 },
    );
    assert.deepEqual(commands, [
      ['number', 202, 35],
      ['number', 202, 15],
    ]);
  });

  it('sends Boolean.Set for "Enable thermostat"', async () => {
    const { gladys, client, commands, published } = harness();
    await setDeviceValue(
      { gladys, client },
      { device, feature: feature('boolean:202:binary'), value: 0 },
    );
    assert.deepEqual(commands, [['boolean', 202, false]]);
    assert.deepEqual(published, [[feature('boolean:202:binary').external_id, 0]]);
  });

  it('refuses to write a component whose access has no `w`', async () => {
    const { gladys, client, commands } = harness();
    await assert.rejects(
      setDeviceValue(
        { gladys, client },
        { device, feature: feature('boolean:203:binary'), value: 1 },
      ),
      /read-only/,
    );
    await assert.rejects(
      setDeviceValue(
        { gladys, client },
        { device, feature: feature('number:201:value'), value: 1 },
      ),
      /read-only/,
    );
    assert.deepEqual(commands, []);
  });

  it('falls back on the Gladys feature when no metadata is known', async () => {
    const { gladys, client, commands } = harness(null);
    await setDeviceValue(
      { gladys, client },
      {
        device,
        feature: feature('number:202:value', { read_only: false, min: 15, max: 30 }),
        value: 31,
      },
    );
    assert.deepEqual(commands, [['number', 202, 30]]);
    await assert.rejects(
      setDeviceValue(
        { gladys, client },
        { device, feature: feature('boolean:203:binary', { read_only: true }), value: 1 },
      ),
      /read-only/,
    );
  });

  it('drives a real fake device end to end over HTTP', async () => {
    const status = structuredClone(ST1820_STATUS);
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status,
      components: ST1820_COMPONENTS,
    });
    try {
      const { client } = routerFor();
      const target = {
        ...device,
        params: [
          { name: 'SHELLY_ID', value: ST1820_INFO.id },
          { name: 'IP_ADDRESS', value: shelly.host },
        ],
      };
      const gladys = { async publishState() {} };
      await setDeviceValue(
        { gladys, client },
        { device: target, feature: feature('number:202:value'), value: 21.5 },
      );
      await setDeviceValue(
        { gladys, client },
        { device: target, feature: feature('boolean:202:binary'), value: 0 },
      );
      assert.deepEqual(
        shelly.calls
          .filter((call) => call.method.endsWith('.Set'))
          .map((call) => [call.method, call.params]),
        [
          ['Number.Set', { id: 202, value: 21.5 }],
          ['Boolean.Set', { id: 202, value: false }],
        ],
      );
      assert.equal(status['number:202'].value, 21.5);
      assert.equal(status['boolean:202'].value, false);
    } finally {
      await shelly.close();
    }
  });
});

describe('prepareNumberValue', () => {
  it('rounds to the step without floating-point noise', () => {
    assert.equal(prepareNumberValue(21.26, { step: 0.5 }), 21.5);
    assert.equal(prepareNumberValue(0.1 + 0.2, { step: 0.1 }), 0.3);
    assert.equal(prepareNumberValue(7, {}), 7);
  });

  it('keeps the range when the bounds are off the step grid', () => {
    assert.equal(prepareNumberValue(34.9, { min: 15.2, max: 34.9, step: 0.5 }), 34.9);
  });
});

describe('ST1820 real-time updates', () => {
  const engines = [];
  const devices = [];
  after(async () => {
    engines.forEach((engine) => engine.stop());
    await Promise.all(devices.map((device) => device.close()));
  });

  it('a NotifyStatus on number:202 updates the setpoint feature on the real-time lane', async () => {
    const shelly = await startFakeShelly({
      info: ST1820_INFO,
      status: structuredClone(ST1820_STATUS),
      components: ST1820_COMPONENTS,
    });
    devices.push(shelly);
    const config = normalizeConfig({ realtime_interval: '1' });
    const { client } = routerFor({ realtime_interval: '1' });
    const published = [];
    const gladysDevice = {
      external_id: `ext:shelly:device:${ST1820_INFO.id}`,
      params: [
        { name: 'SHELLY_ID', value: ST1820_INFO.id },
        { name: 'IP_ADDRESS', value: shelly.host },
      ],
    };
    const telemetry = createTelemetry({
      gladys: {
        async getDevices() {
          return [gladysDevice];
        },
        async publishStates(states) {
          published.push(...states);
        },
        async publishTransports() {},
        externalIds: (type, id) => externalIdsFor(id),
      },
      client,
      getConfig: () => config,
    });
    engines.push(telemetry);

    // The first poll after a restart reads the metadata it never had.
    await telemetry.refreshValues();
    assert.ok(client.cachedComponents(ST1820_INFO.id));
    await waitFor(() => telemetry.wsHub.isLive(ST1820_INFO.id));
    published.length = 0;

    // Someone turns the knob on the thermostat itself.
    shelly.push({ 'number:202': { value: 23.5, source: 'ui' } });
    const id = `ext:shelly:device:${ST1820_INFO.id}:number:202:value`;
    const state = await waitFor(() => published.find((s) => s.device_feature_external_id === id));
    assert.equal(state.state, 23.5);

    // A slow-moving reading pushed alongside stays OFF the real-time lane.
    published.length = 0;
    shelly.push({ 'number:201': { value: 24.8 }, 'boolean:203': { value: true } });
    await waitFor(() =>
      published.find((s) => s.device_feature_external_id.endsWith(':boolean:203:binary')),
    );
    assert.ok(!published.some((s) => s.device_feature_external_id.endsWith(':number:201:value')));
  });
});
