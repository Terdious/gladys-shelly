import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';

const CLOUD_CONFIG = {
  cloud_enabled: true,
  cloud_server: 'shelly-53-eu.shelly.cloud',
  cloud_auth_key: 'key',
};

/** A cloud client stub recording what it was asked to do. */
function fakeCloud({ status = { 'switch:0': { output: true } }, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async getStatus(id) {
      calls.push(['getStatus', id]);
      if (fail) {
        throw fail;
      }
      return status;
    },
    async setRelay(id, channel, on) {
      calls.push(['setRelay', id, channel, on]);
      if (fail) {
        throw fail;
      }
      return {};
    },
  };
}

/**
 * Build a client whose LOCAL transport is a fake `fetch`.
 *
 * Injecting at the fetch seam (rather than stubbing the RPC client) means the
 * real rpc.js code runs: the routing assertions below also prove the request
 * that would hit the wire is a well-formed RPC call.
 */
function clientWith({ rawConfig = {}, localResult, localHttpStatus, cloud = fakeCloud() }) {
  const config = normalizeConfig(rawConfig);
  const localCalls = [];

  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    localCalls.push([request.method, new URL(url).hostname, request.params]);
    if (localResult instanceof Error) {
      throw localResult;
    }
    if (localHttpStatus) {
      return {
        ok: false,
        status: localHttpStatus,
        headers: { get: () => null },
        async json() {
          return {};
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return { id: request.id, result: localResult };
      },
    };
  };

  const client = createShellyClient({ getConfig: () => config, cloud, fetchImpl });
  return { client, localCalls, cloud };
}

describe('getStatus transport routing', () => {
  it('uses the local transport when it works', async () => {
    const { client, localCalls, cloud } = clientWith({
      rawConfig: CLOUD_CONFIG,
      localResult: { 'switch:0': { output: false } },
    });

    const result = await client.getStatus({ shellyId: 'shellyplug-abc', host: '10.5.0.9' });

    assert.equal(result.transport, 'local');
    assert.equal(result.degraded, undefined);
    assert.equal(localCalls.length, 1);
    // The cloud must not be touched when local works: that is the whole point.
    assert.deepEqual(cloud.calls, []);
  });

  it('falls back to the cloud and flags the result as degraded', async () => {
    const { client, cloud } = clientWith({
      rawConfig: CLOUD_CONFIG,
      localResult: new Error('EHOSTUNREACH'),
    });

    const result = await client.getStatus({ shellyId: 'shellyplug-abc', host: '10.5.0.9' });

    assert.equal(result.transport, 'cloud');
    // "It works, but not nominally" — the badge exists precisely for this.
    assert.equal(result.degraded, true);
    assert.match(result.message.en, /local network/i);
    assert.deepEqual(cloud.calls, [['getStatus', 'shellyplug-abc']]);
  });

  it('explains a degraded fallback caused by an authentication problem', async () => {
    // A 401 with no password configured is what a protected device looks like
    // from the integration's side.
    const { client } = clientWith({
      rawConfig: CLOUD_CONFIG,
      localHttpStatus: 401,
    });

    const result = await client.getStatus({ shellyId: 'shellyplug-abc', host: '10.5.0.9' });

    assert.equal(result.degraded, true);
    assert.match(result.message.en, /password/i);
  });

  it('goes straight to the cloud, nominally, when the user prefers the cloud', async () => {
    const { client, localCalls, cloud } = clientWith({
      rawConfig: { ...CLOUD_CONFIG, GLADYS_PREFER_LOCAL: false },
      localResult: { 'switch:0': { output: false } },
    });

    const result = await client.getStatus({ shellyId: 'shellyplug-abc', host: '10.5.0.9' });

    assert.equal(result.transport, 'cloud');
    // Explicitly choosing the cloud is not a degraded state.
    assert.equal(result.degraded, undefined);
    assert.deepEqual(localCalls, []);
    assert.equal(cloud.calls.length, 1);
  });

  it('still uses local when the cloud is preferred but not configured', async () => {
    const { client, localCalls } = clientWith({
      rawConfig: { GLADYS_PREFER_LOCAL: false },
      localResult: { 'switch:0': { output: true } },
    });

    const result = await client.getStatus({ shellyId: 'shellyplug-abc', host: '10.5.0.9' });

    assert.equal(result.transport, 'local');
    assert.equal(localCalls.length, 1);
  });

  it('reports the LOCAL failure when both transports fail', async () => {
    const { client } = clientWith({
      rawConfig: CLOUD_CONFIG,
      localResult: new Error('EHOSTUNREACH 10.5.0.9'),
      cloud: fakeCloud({ fail: new Error('cloud down') }),
    });

    // The local error is the actionable one (wrong IP, device unplugged);
    // "cloud down" would send the user chasing the wrong problem.
    await assert.rejects(
      () => client.getStatus({ shellyId: 'shellyplug-abc', host: '10.5.0.9' }),
      /EHOSTUNREACH/,
    );
  });

  it('fails clearly when there is no address and no cloud', async () => {
    const { client } = clientWith({ localResult: {} });
    await assert.rejects(
      () => client.getStatus({ shellyId: 'shellyplug-abc' }),
      /no usable transport/,
    );
  });
});

describe('setSwitch transport routing', () => {
  it('sends the command locally and reports the transport used', async () => {
    const { client, localCalls } = clientWith({ localResult: {} });

    const transport = await client.setSwitch({ shellyId: 'plug', host: '10.5.0.9' }, 2, true);

    assert.equal(transport, 'local');
    assert.deepEqual(localCalls, [['Switch.Set', '10.5.0.9', { id: 2, on: true }]]);
  });

  it('falls back to the cloud when the device is unreachable locally', async () => {
    const { client, cloud } = clientWith({
      rawConfig: CLOUD_CONFIG,
      localResult: new Error('timeout'),
    });

    const transport = await client.setSwitch({ shellyId: 'plug', host: '10.5.0.9' }, 0, false);

    assert.equal(transport, 'cloud');
    assert.deepEqual(cloud.calls, [['setRelay', 'plug', 0, false]]);
  });

  it('throws when the command could not be delivered at all', async () => {
    const { client } = clientWith({
      rawConfig: CLOUD_CONFIG,
      localResult: new Error('timeout'),
      cloud: fakeCloud({ fail: new Error('cloud down') }),
    });

    // Gladys acks a command as successful when the handler resolves: a
    // swallowed failure would leave the UI showing a state the relay never took.
    await assert.rejects(
      () => client.setSwitch({ shellyId: 'plug', host: '10.5.0.9' }, 0, true),
      /timeout/,
    );
  });
});
