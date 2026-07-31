import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import {
  clearLocalCircuit,
  isLocalInCooldown,
  LOCAL_COOLDOWN_MS,
  LOCAL_FAILURE_THRESHOLD,
  recordLocalFailure,
  recordLocalSuccess,
} from '../../src/shelly/localCircuit.js';

describe('localCircuit', () => {
  it('parks a device only after the threshold of consecutive failures', () => {
    const circuit = new Map();
    const now = 1_000_000;

    for (let index = 1; index < LOCAL_FAILURE_THRESHOLD; index += 1) {
      const { tripped } = recordLocalFailure(circuit, 'plug', now);
      assert.equal(tripped, false);
      assert.equal(isLocalInCooldown(circuit, 'plug', now), false);
    }

    const { tripped, cooldownMs } = recordLocalFailure(circuit, 'plug', now);
    assert.equal(tripped, true);
    assert.equal(cooldownMs, LOCAL_COOLDOWN_MS);
    assert.equal(isLocalInCooldown(circuit, 'plug', now), true);
  });

  it('reports tripped only ONCE, so the warning is not logged every cycle', () => {
    const circuit = new Map();
    const now = 1_000_000;
    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD; index += 1) {
      recordLocalFailure(circuit, 'plug', now);
    }
    // Still failing: re-armed, but silently.
    assert.equal(recordLocalFailure(circuit, 'plug', now).tripped, false);
    assert.equal(recordLocalFailure(circuit, 'plug', now).tripped, false);
  });

  it('lets the cooldown expire so a device recovers by itself', () => {
    const circuit = new Map();
    const now = 1_000_000;
    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD; index += 1) {
      recordLocalFailure(circuit, 'plug', now);
    }
    assert.equal(isLocalInCooldown(circuit, 'plug', now + LOCAL_COOLDOWN_MS - 1), true);
    assert.equal(isLocalInCooldown(circuit, 'plug', now + LOCAL_COOLDOWN_MS + 1), false);
  });

  it('clears the failure count on a success', () => {
    const circuit = new Map();
    const now = 1_000_000;
    recordLocalFailure(circuit, 'plug', now);
    recordLocalFailure(circuit, 'plug', now);
    recordLocalSuccess(circuit, 'plug');
    // The count restarted: one more failure must not park the device.
    assert.equal(recordLocalFailure(circuit, 'plug', now).tripped, false);
  });

  it('tracks each device independently', () => {
    const circuit = new Map();
    const now = 1_000_000;
    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD; index += 1) {
      recordLocalFailure(circuit, 'dead', now);
    }
    assert.equal(isLocalInCooldown(circuit, 'dead', now), true);
    assert.equal(isLocalInCooldown(circuit, 'alive', now), false);
  });

  it('clears one device or the whole circuit', () => {
    const circuit = new Map();
    const now = 1_000_000;
    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD; index += 1) {
      recordLocalFailure(circuit, 'a', now);
      recordLocalFailure(circuit, 'b', now);
    }
    clearLocalCircuit(circuit, 'a');
    assert.equal(isLocalInCooldown(circuit, 'a', now), false);
    assert.equal(isLocalInCooldown(circuit, 'b', now), true);

    clearLocalCircuit(circuit);
    assert.equal(isLocalInCooldown(circuit, 'b', now), false);
  });
});

describe('the client under a tripped circuit', () => {
  /** A client whose local transport always fails, with a controllable clock. */
  function failingClient({ rawConfig = {}, cloudStatus = { 'switch:0': { output: true } } } = {}) {
    const config = normalizeConfig(rawConfig);
    let clock = 1_000_000;
    let localAttempts = 0;
    const cloudCalls = [];

    const client = createShellyClient({
      getConfig: () => config,
      cloud: {
        async getStatus(id) {
          cloudCalls.push(id);
          return cloudStatus;
        },
        async setRelay(id, channel, on) {
          cloudCalls.push([id, channel, on]);
        },
      },
      fetchImpl: async () => {
        localAttempts += 1;
        throw new Error('EHOSTUNREACH');
      },
      now: () => clock,
    });

    return {
      client,
      cloudCalls,
      localAttempts: () => localAttempts,
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  const CLOUD_CONFIG = {
    cloud_enabled: true,
    cloud_server: 'shelly-53-eu.shelly.cloud',
    cloud_auth_key: 'key',
  };

  it('stops paying the local timeout once the device is parked', async () => {
    const { client, localAttempts } = failingClient({ rawConfig: CLOUD_CONFIG });
    const target = { shellyId: 'plug', host: '10.5.0.9' };

    // Enough cycles to trip the breaker, then several more.
    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD + 5; index += 1) {
      await client.getStatus(target);
    }

    // Without the breaker this would be THRESHOLD + 5 local attempts, each
    // burning a full timeout on a device that is simply unplugged.
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD);
  });

  it('still serves the device from the cloud while parked, and stays degraded', async () => {
    const { client, cloudCalls } = failingClient({ rawConfig: CLOUD_CONFIG });
    const target = { shellyId: 'plug', host: '10.5.0.9' };

    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD + 2; index += 1) {
      await client.getStatus(target);
    }
    const result = await client.getStatus(target);

    assert.equal(result.transport, 'cloud');
    // Parked is still "not nominal": the badge must keep its orange dot.
    assert.equal(result.degraded, true);
    assert.equal(cloudCalls.length, LOCAL_FAILURE_THRESHOLD + 3);
  });

  it('re-probes the device once the cooldown expires', async () => {
    const { client, localAttempts, advance } = failingClient({ rawConfig: CLOUD_CONFIG });
    const target = { shellyId: 'plug', host: '10.5.0.9' };

    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD + 3; index += 1) {
      await client.getStatus(target);
    }
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD);

    advance(LOCAL_COOLDOWN_MS + 1);
    await client.getStatus(target);

    // A device that comes back must heal on its own, without a restart.
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD + 1);
  });

  it('un-parks every device when the credentials are fixed', async () => {
    const { client, localAttempts } = failingClient({ rawConfig: CLOUD_CONFIG });
    const target = { shellyId: 'plug', host: '10.5.0.9' };

    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD + 3; index += 1) {
      await client.getStatus(target);
    }
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD);

    // A password fix must take effect now, not after a full cooldown.
    client.reset();
    await client.getStatus(target);
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD + 1);
  });

  it('still attempts a user command locally when there is no cloud to fall back on', async () => {
    const { client, localAttempts } = failingClient();
    const target = { shellyId: 'plug', host: '10.5.0.9' };

    for (let index = 0; index < LOCAL_FAILURE_THRESHOLD; index += 1) {
      await assert.rejects(() => client.getStatus(target));
    }
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD);

    // Refusing a deliberate click because the POLL loop parked the device
    // would be user-hostile: the command is the only path, so it is attempted.
    await assert.rejects(() => client.setSwitch(target, 0, true));
    assert.equal(localAttempts(), LOCAL_FAILURE_THRESHOLD + 1);
  });
});
