import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { createTelemetry } from '../../src/shelly/telemetry.js';
import { PRO_3EM_STATUS, PRO_4PM_STATUS, startFakeShelly } from '../helpers/fakeShelly.js';

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

describe('telemetry with the real-time push channel', () => {
  const devices = [];
  const engines = [];
  after(async () => {
    engines.forEach((engine) => engine.stop());
    await Promise.all(devices.map((device) => device.close()));
  });

  /**
   * Build a telemetry engine wired to a real fake device, with a fake Gladys
   * recording everything published.
   */
  function engineFor(device, rawConfig = {}, { now } = {}) {
    const config = normalizeConfig(rawConfig);
    const published = [];
    const httpPolls = () => device.calls.filter((c) => c.method === 'Shelly.GetStatus').length;

    const gladysDevice = {
      external_id: `ext:shelly:device:${device.info.id}`,
      params: [
        { name: 'SHELLY_ID', value: device.info.id },
        { name: 'IP_ADDRESS', value: device.host },
      ],
    };

    const gladys = {
      async getDevices() {
        return [gladysDevice];
      },
      async publishStates(states) {
        published.push(...states);
      },
      async publishTransports() {},
      externalIds(type, platformId) {
        return {
          device: `ext:shelly:${type}:${platformId}`,
          feature: (key) => `ext:shelly:${type}:${platformId}:${key}`,
        };
      },
    };

    const client = createShellyClient({
      getConfig: () => config,
      cloud: {
        async getStatus() {
          throw new Error('cloud not configured');
        },
      },
    });

    const telemetry = createTelemetry({
      gladys,
      client,
      getConfig: () => config,
      ...(now ? { now } : {}),
    });
    engines.push(telemetry);
    return { telemetry, published, httpPolls, gladysDevice };
  }

  const featureId = (device, key) => `ext:shelly:device:${device.info.id}:${key}`;

  it('publishes a pushed relay change within a second, without waiting for a cycle', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-ece334ea4d10', mac: 'ECE334EA4D10', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    // 1 s real-time cadence so the test does not wait for the 5 s default.
    const { telemetry, published } = engineFor(device, { realtime_interval: '1' });

    // One cycle opens the real-time connection for the created device.
    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-ece334ea4d10'));
    published.length = 0;

    // Someone flips the relay on the wall.
    device.push({ 'switch:1': { id: 1, output: true } });

    const state = await waitFor(() =>
      published.find((s) => s.device_feature_external_id === featureId(device, 'switch:1:binary')),
    );
    // This is the whole point of #2: 30 s of latency becomes ~1 s.
    assert.equal(state.state, 1);
  });

  it('puts control-relevant values on the real-time lane and leaves the rest behind', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-a', mac: 'A', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    const { telemetry, published } = engineFor(device, { realtime_interval: '1' });

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-a'));
    published.length = 0;

    // switch:1 starts off and idle in the fixture, so every value below moves.
    device.push({
      'switch:1': { id: 1, output: true, apower: 99.9, voltage: 240.5, aenergy: { total: 999 } },
    });
    await waitFor(() =>
      published.find((s) => s.device_feature_external_id === featureId(device, 'switch:1:binary')),
    );

    const sent = (key) =>
      published.some((s) => s.device_feature_external_id === featureId(device, key));

    // The relay state and its power are what a control scene reacts to.
    assert.equal(sent('switch:1:power'), true);
    // Voltage and the energy counter are not: a Pro 3EM pushes about once a
    // SECOND across ~25 measurements, and forwarding all of it would be
    // ~900 states/minute against a 300/minute cap.
    assert.equal(sent('switch:1:voltage'), false);
    assert.equal(sent('switch:1:energy'), false);
  });

  it('puts every phase of a three-phase meter on the real-time lane, not just the total', async () => {
    // The bench symptom this fixes: on the SAME Pro 3EM the total power
    // refreshed every 5 s while L1/L2/L3 waited for the 30 s cycle, so the
    // device looked fast and slow at once ("ça dépend"). A per-phase load is
    // exactly as real-time as their sum.
    const device = await startFakeShelly({
      info: { id: 'shellypro3em-phases', mac: 'F1', gen: 2 },
      status: structuredClone(PRO_3EM_STATUS),
    });
    devices.push(device);
    const { telemetry, published } = engineFor(device, { realtime_interval: '1' });

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro3em-phases'));
    published.length = 0;

    device.push({
      'em:0': {
        id: 0,
        a_act_power: 111.1,
        b_act_power: 222.2,
        c_act_power: 333.3,
        total_act_power: 666.6,
        a_voltage: 231.9,
        a_current: 9.876,
        a_aprt_power: 444.4,
      },
    });
    await waitFor(() =>
      published.find(
        (s) => s.device_feature_external_id === featureId(device, 'em:0:total_active_power'),
      ),
    );

    const sent = (key) =>
      published.some((s) => s.device_feature_external_id === featureId(device, key));

    assert.equal(sent('em:0:l1_active_power'), true);
    assert.equal(sent('em:0:l2_active_power'), true);
    assert.equal(sent('em:0:l3_active_power'), true);
    // The lane stays about POWER: adding voltage, current and apparent power
    // would triple its cost for values nobody controls anything with.
    assert.equal(sent('em:0:l1_voltage'), false);
    assert.equal(sent('em:0:l1_current'), false);
    assert.equal(sent('em:0:l1_apparent_power'), false);
  });

  it('slows its own lane down rather than losing states to the rate limit', async () => {
    // The lane is sized by the FLEET, not by the configuration: the same
    // feature list is free on one meter and over budget on ten. So it measures
    // what it publishes and stretches itself — a slower lane is visible, a
    // state the host API refuses is not.
    const device = await startFakeShelly({
      info: { id: 'shellypro3em-budget', mac: 'F2', gen: 2 },
      status: structuredClone(PRO_3EM_STATUS),
    });
    devices.push(device);
    // A frozen clock keeps every state inside the one-minute budget window, so
    // a fleet's worth of traffic can be spent without waiting a real minute.
    const frozen = Date.now();
    const { telemetry, published } = engineFor(
      device,
      { realtime_interval: '1' },
      { now: () => frozen },
    );

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro3em-budget'));

    // Spend three times the safe rate (240/min), which asks the lane for a
    // three times longer interval: 1 s becomes 3 s.
    let spin = 0;
    while (published.length < 720) {
      spin += 1;
      assert.ok(spin < 200, 'the budget should be spent in far fewer cycles than this');
      const em = { id: 0 };
      Object.entries(device.status['em:0']).forEach(([key, value]) => {
        em[key] = key === 'id' || typeof value !== 'number' ? value : value + spin;
      });
      device.status['em:0'] = em;
      device.push({ 'em:0': em });
      // The push travels over a real socket: give it a tick to land, otherwise
      // the cycle below drains an empty buffer and the budget never fills.
       
      await new Promise((resolve) => setTimeout(resolve, 5));
       
      await telemetry.refreshValues();
    }

    // Let any flush armed at the OLD interval fire, so what follows is measured
    // against the stretched one and not against a timer from before.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    published.length = 0;

    device.push({ 'em:0': { id: 0, total_act_power: -4242.4 } });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.equal(
      published.some((s) => s.state === -4242.4),
      false,
      'the lane must not still run at the configured interval once over budget',
    );

    // Still published, just later: slower is a trade-off, dropped is a bug.
    await waitFor(() => published.some((s) => s.state === -4242.4), { timeout: 5000 });
  });

  it('serves a live device from its buffer instead of polling it over HTTP', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-b', mac: 'B', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    const { telemetry, published, httpPolls } = engineFor(device);

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-b'));
    const pollsAfterFirstCycle = httpPolls();
    published.length = 0;

    // A fresh measurement arrives over the push channel...
    device.push({ 'switch:0': { id: 0, output: true, apower: 123.4 } });
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-b'));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // ...and the next cycle publishes it from the buffer, with no HTTP call.
    await telemetry.refreshValues();

    assert.equal(httpPolls(), pollsAfterFirstCycle);
    const power = published.find(
      (s) => s.device_feature_external_id === featureId(device, 'switch:0:power'),
    );
    assert.equal(power.state, 123.4);
  });

  it('falls back to polling a device that is not pushing', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-c', mac: 'C', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    // Preferring the cloud means no WebSocket at all — the poll path must
    // still carry everything on its own.
    const { telemetry, published, httpPolls } = engineFor(device, { GLADYS_PREFER_LOCAL: true });

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-c'));

    telemetry.wsHub.stop();
    published.length = 0;
    const before = httpPolls();

    // Move a value on the device so the cycle has something to report: with
    // nothing changed the dedup would (correctly) publish nothing, and the
    // assertion below would be testing the dedup rather than the fallback.
    device.status['switch:2'].apower = 55.5;

    await telemetry.refreshValues();

    assert.ok(httpPolls() > before, 'the device must be read over HTTP again');
    assert.equal(
      published.find((s) => s.device_feature_external_id === featureId(device, 'switch:2:power'))
        .state,
      55.5,
    );
  });

  it('drops the buffer of a device whose socket died, rather than publishing stale values', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-d', mac: 'D', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    const { telemetry, published } = engineFor(device);

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-d'));
    published.length = 0;

    device.push({ 'switch:0': { id: 0, apower: 777.7 } });
    device.dropSockets();
    await waitFor(() => !telemetry.wsHub.isLive('shellypro4pm-d'));

    // The buffered 777.7 was never confirmed by a live socket: the cycle must
    // re-read the device rather than publish a value it cannot vouch for.
    await telemetry.refreshValues();
    assert.equal(
      published.some((s) => s.state === 777.7),
      false,
    );
  });

  it('stops every real-time connection when telemetry stops', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-e', mac: 'E', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    const { telemetry } = engineFor(device);

    await telemetry.refreshValues();
    await waitFor(() => device.connectedClients() === 1);

    telemetry.stop();
    await waitFor(() => device.connectedClients() === 0);
  });
});
