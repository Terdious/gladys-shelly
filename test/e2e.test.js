// -----------------------------------------------------------------------------
// End-to-end test: the REAL @gladysassistant/integration-sdk client wired by
// the REAL setupIntegration() from index.js, connected to a fake Gladys core
// (WebSocket + REST) and a fake Shelly Pro 4PM (HTTP RPC), exercising:
//   1. fresh install -> "local only" connection status, no configuration
//      needed (a Shelly setup has no login step);
//   2. Scan -> the device is discovered through its configured address and
//      published with its features;
//   3. the user creates it -> a poll publishes its states and its transport;
//   4. the user flips a switch -> the relay actually moves, the command is
//      acked and the new state is published;
//   5. a command to an unreachable device -> acked as FAILED, not silently
//      swallowed.
// -----------------------------------------------------------------------------

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GladysIntegration, WEBSOCKET_MESSAGE_TYPES } from '@gladysassistant/integration-sdk';

import { setupIntegration } from '../index.js';
import { startFakeGladysCore, waitFor } from './helpers/fakeGladysCore.js';
import { PRO_4PM_STATUS, startFakeShelly } from './helpers/fakeShelly.js';

const { EXTERNAL_INTEGRATION } = WEBSOCKET_MESSAGE_TYPES;

let core;
let shelly;
let gladys;
let integration;
let messageId = 0;

// The fake core serves this object on GET /config and this array on GET
// /device: the test mutates them to play the user's actions.
const coreConfig = {};
const coreDevices = [];

/**
 * Send a server-initiated command and wait for its ack.
 * @param {string} type WebSocket message type
 * @param {object} payload message payload
 * @returns {Promise<object>} the command result
 */
async function sendAndWaitResult(type, payload) {
  messageId += 1;
  const id = `msg-${messageId}`;
  core.send(type, { message_id: id, ...payload });
  return waitFor(() => core.state.commandResults.find((result) => result.message_id === id));
}

before(async () => {
  shelly = await startFakeShelly({
    info: {
      id: 'shellypro4pm-ece334ea4d10',
      mac: 'ECE334EA4D10',
      model: 'SPSW-004PE16EU',
      gen: 2,
      auth_en: false,
    },
    // Deep-copy the fixture: Switch.Set mutates it, and other test files read it.
    status: structuredClone(PRO_4PM_STATUS),
    config: {
      sys: { device: { name: 'Éclairages RDC' } },
      'switch:0': { name: 'Salle de bain' },
    },
  });

  // The device is reachable by its address; mDNS is not available in the test
  // environment, which is exactly the "manual address" path users fall back to.
  coreConfig.manual_hosts = shelly.host;
  coreConfig.refresh_interval = '3600';

  core = await startFakeGladysCore({ config: coreConfig, devices: coreDevices });

  gladys = new GladysIntegration({
    hostApiUrl: core.url,
    token: 'integration-token',
    selector: 'shelly',
  });
  integration = setupIntegration(gladys);

  await gladys.connect();
});

after(async () => {
  integration.telemetry.stop();
  await gladys.disconnect();
  await core.close();
  await shelly.close();
});

describe('a local-only install', () => {
  it('reports itself connected without any credentials', async () => {
    const status = await waitFor(() => core.state.connectionStatuses.at(-1));
    // A Shelly install with an empty form is fully functional: reporting
    // "not connected" the way a cloud integration does would be a lie.
    assert.equal(status.connected, true);
    assert.match(status.message.en, /local network only/i);
  });
});

describe('discovery', () => {
  it('publishes the device found at the configured address', async () => {
    core.send(EXTERNAL_INTEGRATION.SCAN_REQUEST, {});
    const discovered = await waitFor(() => core.state.discovered.at(-1));

    assert.equal(discovered.length, 1);
    const device = discovered[0];
    assert.equal(device.external_id, 'ext:shelly:device:shellypro4pm-ece334ea4d10');
    assert.equal(device.name, 'Éclairages RDC');

    // Four relays, each with its On/Off, plus the metering features.
    const binaries = device.features.filter((feature) => feature.external_id.endsWith(':binary'));
    assert.equal(binaries.length, 4);
    assert.equal(
      binaries.every((feature) => feature.read_only === false),
      true,
    );
    assert.ok(device.features.some((feature) => feature.name === 'Salle de bain — On/Off'));
    assert.ok(device.features.some((feature) => feature.unit === 'kilowatt-hour'));

    // The address is remembered so the next poll does not need a re-scan.
    const params = Object.fromEntries(device.params.map((p) => [p.name, p.value]));
    assert.equal(params.IP_ADDRESS, shelly.host);
  });
});

describe('telemetry', () => {
  it('publishes the states and the transport of a created device', async () => {
    // The user creates the discovered device: the core now returns it on
    // GET /device, which is what the refresh loop iterates over.
    coreDevices.push(core.state.discovered.at(-1)[0]);

    await integration.telemetry.refreshValues();

    const byId = Object.fromEntries(
      core.state.states.map((state) => [state.device_feature_external_id, state.state]),
    );
    const prefix = 'ext:shelly:device:shellypro4pm-ece334ea4d10';
    assert.equal(byId[`${prefix}:switch:0:binary`], 1);
    assert.equal(byId[`${prefix}:switch:1:binary`], 0);
    assert.equal(byId[`${prefix}:switch:0:power`], 12.3);
    // 45678.9 Wh -> kWh
    assert.equal(byId[`${prefix}:switch:0:energy`], 45.679);

    // The SDK renames `external_id` to `device_external_id` on the wire.
    const transports = core.state.transports.at(-1);
    assert.deepEqual(transports, [{ device_external_id: prefix, transport: 'local' }]);
  });

  it('publishes only what changed on the next cycle', async () => {
    const before = core.state.states.length;
    await integration.telemetry.refreshValues();
    // Nothing moved on the device, so nothing is worth the rate limit.
    assert.equal(core.state.states.length, before);
  });
});

describe('commands', () => {
  it('flips a real relay and publishes the new state', async () => {
    const featureExternalId = 'ext:shelly:device:shellypro4pm-ece334ea4d10:switch:1:binary';
    assert.equal(shelly.status['switch:1'].output, false);

    const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.DEVICE_SET_VALUE, {
      device: coreDevices[0],
      device_feature: { external_id: featureExternalId },
      value: 1,
    });

    assert.equal(result.success, true);
    // The relay actually moved on the device, not just in our bookkeeping.
    assert.equal(shelly.status['switch:1'].output, true);
    assert.equal(
      core.state.states.filter(
        (state) => state.device_feature_external_id === featureExternalId && state.state === 1,
      ).length,
      1,
    );
  });

  it('acks a command to an unreachable device as FAILED', async () => {
    const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.DEVICE_SET_VALUE, {
      device: {
        external_id: 'ext:shelly:device:shellyplusplugs-deadbeef0000',
        params: [
          { name: 'SHELLY_ID', value: 'shellyplusplugs-deadbeef0000' },
          // Port 1 is closed: the RPC call cannot land.
          { name: 'IP_ADDRESS', value: '127.0.0.1:1' },
        ],
      },
      device_feature: {
        external_id: 'ext:shelly:device:shellyplusplugs-deadbeef0000:switch:0:binary',
      },
      value: 1,
    });

    // Resolving would ack a success and leave the Gladys UI showing a state
    // the relay never took.
    assert.equal(result.success, false);
  });

  it('refuses to write a read-only measurement', async () => {
    const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.DEVICE_SET_VALUE, {
      device: coreDevices[0],
      device_feature: {
        external_id: 'ext:shelly:device:shellypro4pm-ece334ea4d10:switch:0:power',
      },
      value: 42,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /not controllable/);
  });
});

describe('configuration updates', () => {
  it('re-runs the discovery when the user adds an address', async () => {
    const discoveriesBefore = core.state.discovered.length;

    // The bogus address is a CLOSED PORT on loopback, not an unroutable IP:
    // it is refused instantly and identically everywhere. An address like
    // 10.99.99.99 fails fast on a developer LAN but hangs until the full RPC
    // timeout on a CI runner, which made this test pass locally and time out
    // in CI — the assertion is about discovery, not about network behaviour.
    core.send(EXTERNAL_INTEGRATION.CONFIG_UPDATED, {
      config: { ...coreConfig, manual_hosts: `${shelly.host}, 127.0.0.1:1` },
    });

    // Adding an address is the user saying "find this device": they should not
    // have to click Scan afterwards.
    await waitFor(() => core.state.discovered.length > discoveriesBefore);
    const discovered = core.state.discovered.at(-1);
    // The bogus address finds nothing, the real one is still there.
    assert.equal(discovered.length, 1);
  });

  it('reports the incomplete setup when the cloud is enabled without a key', async () => {
    core.send(EXTERNAL_INTEGRATION.CONFIG_UPDATED, {
      config: { ...coreConfig, cloud_enabled: true },
    });

    const status = await waitFor(() => {
      const last = core.state.connectionStatuses.at(-1);
      return last && /incomplete/i.test(last.message?.en || '') ? last : null;
    });
    // Local still works, so the integration stays "connected" — but it says
    // exactly what is missing.
    assert.equal(status.connected, true);
  });
});
