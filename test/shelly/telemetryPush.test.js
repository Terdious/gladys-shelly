import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { createTelemetry } from '../../src/shelly/telemetry.js';
import { PRO_4PM_STATUS, startFakeShelly } from '../helpers/fakeShelly.js';

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
  function engineFor(device, rawConfig = {}) {
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

    const telemetry = createTelemetry({ gladys, client, getConfig: () => config });
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
    const { telemetry, published } = engineFor(device);

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

  it('does not flush a pushed measurement on the fast path', async () => {
    const device = await startFakeShelly({
      info: { id: 'shellypro4pm-a', mac: 'A', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    devices.push(device);
    const { telemetry, published } = engineFor(device);

    await telemetry.refreshValues();
    await waitFor(() => telemetry.wsHub.isLive('shellypro4pm-a'));
    published.length = 0;

    // A Pro 3EM pushes this kind of frame about once a SECOND. Forwarding
    // measurements at that rate would be ~900 states/minute against a
    // 300/minute cap.
    // switch:1 starts off and idle in the fixture, so BOTH values really move.
    device.push({ 'switch:1': { id: 1, output: true, apower: 99.9 } });
    await waitFor(() =>
      published.find((s) => s.device_feature_external_id === featureId(device, 'switch:1:binary')),
    );

    // The relay state went out; the power reading did not.
    assert.equal(
      published.some((s) => s.device_feature_external_id === featureId(device, 'switch:1:power')),
      false,
    );
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
