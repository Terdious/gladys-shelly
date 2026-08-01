import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { discoverDevices, forgetSeenHosts } from '../../src/shelly/discovery.js';
import { createMqttHub, parseGen1Topic } from '../../src/shelly/mqttHub.js';
import { startFakeBroker, startMqttShelly } from '../helpers/fakeBroker.js';

/** Poll until `predicate()` is truthy (or fail after `timeout` ms). */
async function waitFor(predicate, { timeout = 4000, interval = 20 } = {}) {
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

const externalIds = (type, platformId) => ({
  device: `ext:shelly:${type}:${platformId}`,
  feature: (key) => `ext:shelly:${type}:${platformId}:${key}`,
});

describe('parseGen1Topic', () => {
  it('folds the one-scalar-per-topic dialect into the component shape', () => {
    // Gen1 MQTT has no JSON anywhere: every value is its own topic. Rewriting
    // it here is what lets the SAME mapper serve both generations.
    assert.deepEqual(parseGen1Topic('shellies/shellyem3-483F/emeter/0/power', '-8.40'), {
      shellyId: 'shellyem3-483F',
      status: { 'em:0': { id: 0, a_act_power: -8.4 } },
    });
    assert.deepEqual(parseGen1Topic('shellies/shellyem3-483F/emeter/2/voltage', '228.40'), {
      shellyId: 'shellyem3-483F',
      status: { 'em:0': { id: 0, c_voltage: 228.4 } },
    });
    // Cumulated counters land on emdata, in watt-hours (no /60 here).
    assert.deepEqual(parseGen1Topic('shellies/shellyem3-483F/emeter/1/total', '6537028.17'), {
      shellyId: 'shellyem3-483F',
      status: { 'emdata:0': { id: 0, b_total_act_energy: 6537028.17 } },
    });
    assert.deepEqual(parseGen1Topic('shellies/shellyplug-s-a1/relay/0', 'on'), {
      shellyId: 'shellyplug-s-a1',
      status: { 'switch:0': { id: 0, output: true } },
    });
  });

  it('converts relay energy from watt-minutes, unlike emeter energy', () => {
    // The Gen1 asymmetry that silently multiplies energy by 60 when missed.
    const fragment = parseGen1Topic('shellies/shellyplug-s-a1/relay/0/energy', '600');
    assert.equal(fragment.status['switch:0'].aenergy.total, 10);
  });

  it('ignores topics it does not understand', () => {
    assert.equal(parseGen1Topic('shellies/x/announce', '{}'), undefined);
    assert.equal(parseGen1Topic('something/else', 'x'), undefined);
    assert.equal(parseGen1Topic('shellies/x/emeter/0/power', 'not-a-number'), undefined);
  });
});

describe('the MQTT hub against a real broker', () => {
  let broker;
  const devices = [];
  const hubs = [];

  before(async () => {
    broker = await startFakeBroker();
  });
  after(async () => {
    hubs.forEach((hub) => hub.stop());
    await Promise.all(devices.map((device) => device.close()));
    await broker.close();
  });

  function hubFor(rawConfig = {}) {
    const config = normalizeConfig({
      mqtt_enabled: true,
      mqtt_server: broker.address,
      ...rawConfig,
    });
    const pushed = [];
    const hub = createMqttHub({
      getConfig: () => config,
      onStatus: (shellyId, status) => pushed.push([shellyId, status]),
    });
    hubs.push(hub);
    hub.start();
    return { hub, pushed, config };
  }

  it('discovers a device from its push frames, whatever its topic prefix', async () => {
    // The prefix is user-configurable in the Shelly UI, so a computed
    // `<id>/events/rpc` subscription would miss a renamed device. `src` is the
    // authoritative identity.
    const device = await startMqttShelly({
      address: broker.address,
      shellyId: 'shellyplusplugs-e465b8454ce0',
      prefix: 'maison/cuisine/lave-vaisselle',
    });
    devices.push(device);
    const { hub, pushed } = hubFor();

    await waitFor(() => hub.isConnected());
    device.push({ 'switch:0': { id: 0, output: true, apower: 42.5 } });

    await waitFor(() => hub.knows('shellyplusplugs-e465b8454ce0'));
    const [shellyId, status] = await waitFor(() => pushed.find(([, s]) => s['switch:0']));
    assert.equal(shellyId, 'shellyplusplugs-e465b8454ce0');
    assert.equal(status['switch:0'].apower, 42.5);
    // The prefix is remembered so commands can be addressed back to it.
    assert.equal(hub.devices()[0].prefix, 'maison/cuisine/lave-vaisselle');
  });

  it('performs an RPC round trip over two topics', async () => {
    const device = await startMqttShelly({
      address: broker.address,
      shellyId: 'shellyplus1pm-aaaa',
      status: { 'switch:0': { id: 0, output: false, apower: 7.5 } },
    });
    devices.push(device);
    const { hub } = hubFor();

    await waitFor(() => hub.isConnected());
    device.push({ 'switch:0': { id: 0, output: false } });
    await waitFor(() => hub.knows('shellyplus1pm-aaaa'));

    const status = await hub.request('shellyplus1pm-aaaa', 'Shelly.GetStatus');
    assert.equal(status['switch:0'].apower, 7.5);
  });

  it('refuses to command a device that never published', async () => {
    const { hub } = hubFor();
    await waitFor(() => hub.isConnected());
    await assert.rejects(
      () => hub.request('shellyplus1pm-never-seen', 'Shelly.GetStatus'),
      /not reachable over MQTT/,
    );
  });

  it('reads a Gen1 device through its scalar topics', async () => {
    const device = await startMqttShelly({
      address: broker.address,
      shellyId: 'shellyem3-483fdac37e3f',
      control: false,
    });
    devices.push(device);
    const { hub, pushed } = hubFor();

    await waitFor(() => hub.isConnected());
    device.pushGen1('emeter/0/power', '-8.40');

    const [shellyId, status] = await waitFor(() => pushed.find(([, s]) => s['em:0']));
    assert.equal(shellyId, 'shellyem3-483fdac37e3f');
    assert.equal(status['em:0'].a_act_power, -8.4);
  });

  it('stays quiet when the user did not configure a broker', async () => {
    const config = normalizeConfig({});
    const hub = createMqttHub({ getConfig: () => config, onStatus: () => {} });
    hubs.push(hub);
    hub.start();
    assert.equal(hub.isConnected(), false);
    assert.deepEqual(hub.devices(), []);
  });
});

describe('MQTT as a discovery source', () => {
  let broker;
  const devices = [];
  const hubs = [];

  before(async () => {
    broker = await startFakeBroker();
  });
  after(async () => {
    hubs.forEach((hub) => hub.stop());
    await Promise.all(devices.map((device) => device.close()));
    await broker.close();
    forgetSeenHosts();
  });

  it('finds a device that has NO local address at all', async () => {
    // The bench case: a Plug S that answers HTTP perfectly but never appears in
    // any mDNS browse. Over MQTT it needs no address — the broker carries both
    // the status that builds its features and, later, the commands.
    forgetSeenHosts();
    const device = await startMqttShelly({
      address: broker.address,
      shellyId: 'shellyplusplugs-e465b8454ce0',
      status: {
        'switch:0': {
          id: 0,
          output: true,
          apower: 12.3,
          voltage: 231.4,
          aenergy: { total: 45678.9 },
        },
      },
      info: { id: 'shellyplusplugs-e465b8454ce0', model: 'SNPL-00112EU', gen: 2 },
      config: { sys: { device: { name: 'Lave-vaisselle' } } },
    });
    devices.push(device);

    const config = normalizeConfig({ mqtt_enabled: true, mqtt_server: broker.address });
    const hub = createMqttHub({ getConfig: () => config, onStatus: () => {} });
    hubs.push(hub);
    hub.start();
    await waitFor(() => hub.isConnected());
    device.push({ 'switch:0': { id: 0, output: true } });
    await waitFor(() => hub.knows('shellyplusplugs-e465b8454ce0'));

    const client = createShellyClient({
      getConfig: () => config,
      cloud: {
        async getStatus() {
          throw new Error('cloud not configured');
        },
      },
    });

    const found = await discoverDevices({
      // mDNS announces nothing at all, which is the whole point.
      gladys: {
        async scanNetwork() {
          return [];
        },
        externalIds,
      },
      client,
      config,
      mqttHub: hub,
    });

    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Lave-vaisselle');
    assert.equal(found[0].external_id, 'ext:shelly:device:shellyplusplugs-e465b8454ce0');
    assert.ok(found[0].features.some((f) => f.external_id.endsWith(':switch:0:binary')));
    // No IP_ADDRESS param: this device is reached through the broker.
    assert.equal(
      found[0].params.find((param) => param.name === 'IP_ADDRESS'),
      undefined,
    );
  });

  it('routes a command over MQTT when there is no local address', async () => {
    const device = await startMqttShelly({
      address: broker.address,
      shellyId: 'shellyplus1pm-bbbb',
      status: { 'switch:0': { id: 0, output: false } },
    });
    devices.push(device);

    const config = normalizeConfig({ mqtt_enabled: true, mqtt_server: broker.address });
    const hub = createMqttHub({ getConfig: () => config, onStatus: () => {} });
    hubs.push(hub);
    hub.start();
    await waitFor(() => hub.isConnected());
    device.push({ 'switch:0': { id: 0, output: false } });
    await waitFor(() => hub.knows('shellyplus1pm-bbbb'));

    const client = createShellyClient({
      getConfig: () => config,
      cloud: {
        async setRelay() {
          throw new Error('the cloud must not be reached before MQTT');
        },
      },
      mqttHub: hub,
    });

    // No host: local cannot even be attempted, MQTT carries the command.
    const transport = await client.setSwitch({ shellyId: 'shellyplus1pm-bbbb' }, 0, true);

    assert.equal(transport, 'local');
    assert.equal(device.status['switch:0'].output, true);
  });
});
