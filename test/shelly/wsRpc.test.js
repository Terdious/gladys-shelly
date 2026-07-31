import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { buildWsAuth, createWsConnection, parseWsChallenge } from '../../src/shelly/wsRpc.js';
import { createWsHub } from '../../src/shelly/wsHub.js';
import { startFakeShelly } from '../helpers/fakeShelly.js';

/** Poll until `predicate()` is truthy (or fail after `timeout` ms). */
async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
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

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('parseWsChallenge', () => {
  it('reads the challenge out of the JSON string inside the error message', () => {
    // The device does not send structured fields here — it sends a JSON
    // DOCUMENT inside `message`, which is the whole reason this parser exists.
    const challenge = parseWsChallenge({
      code: 401,
      message: JSON.stringify({
        auth_type: 'digest',
        nonce: 1234567,
        nc: 1,
        realm: 'shellypro4pm-abc',
        algorithm: 'SHA-256',
      }),
    });
    assert.equal(challenge.nonce, 1234567);
    assert.equal(challenge.realm, 'shellypro4pm-abc');
  });

  it('ignores anything that is not a 401 digest challenge', () => {
    assert.equal(parseWsChallenge(undefined), undefined);
    assert.equal(parseWsChallenge({ code: 404, message: 'nope' }), undefined);
    assert.equal(parseWsChallenge({ code: 401, message: 'not json' }), undefined);
    assert.equal(parseWsChallenge({ code: 401, message: '{"realm":"x"}' }), undefined);
  });
});

describe('buildWsAuth', () => {
  it('uses the CONSTANT HA2 of the WebSocket scheme, not the method and uri', () => {
    // This is the trap: the HTTP channel hashes "POST:/rpc", the WebSocket
    // channel hashes the literal "dummy_method:dummy_uri" on both sides.
    // Getting it wrong yields an endless 401 loop with a correct password.
    const auth = buildWsAuth({
      challenge: { realm: 'shellypro4pm-abc', nonce: 42 },
      username: 'admin',
      password: 'hunter2',
      nc: 1,
      cnonce: 'fixed',
    });

    const ha1 = sha256('admin:shellypro4pm-abc:hunter2');
    const ha2 = sha256('dummy_method:dummy_uri');
    assert.equal(auth.response, sha256(`${ha1}:42:1:fixed:auth:${ha2}`));
    assert.notEqual(auth.response, sha256(`${ha1}:42:1:fixed:auth:${sha256('POST:/rpc')}`));
  });

  it('carries the fields the device expects', () => {
    const auth = buildWsAuth({
      challenge: { realm: 'r', nonce: 7 },
      username: 'admin',
      password: 'p',
      nc: 3,
      cnonce: 'c',
    });
    assert.equal(auth.algorithm, 'SHA-256');
    assert.equal(auth.username, 'admin');
    assert.equal(auth.realm, 'r');
    assert.equal(auth.nonce, 7);
    assert.equal(auth.nc, 3);
    assert.equal(auth.cnonce, 'c');
  });
});

describe('createWsConnection against a fake device', () => {
  const devices = [];
  const connections = [];
  after(async () => {
    connections.forEach((connection) => connection.close());
    await Promise.all(devices.map((device) => device.close()));
  });

  /** Open a connection to a fake device, tracked for cleanup. */
  function connectTo(device, { password = '' } = {}) {
    const received = [];
    const connection = createWsConnection({
      shellyId: device.info.id,
      host: device.host,
      getCredentials: () => ({ username: 'admin', password }),
      onStatus: (status) => received.push(status),
    });
    connections.push(connection);
    return { connection, received };
  }

  it('connects and receives a pushed partial status', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { received } = connectTo(device);

    await waitFor(() => device.connectedClients() === 1);
    device.push({ 'switch:0': { id: 0, output: true, apower: 42.5 } });

    const status = await waitFor(() => received[0]);
    // A PARTIAL document, exactly the shape Shelly.GetStatus returns — which
    // is what lets the existing mapper consume it unchanged.
    assert.equal(status['switch:0'].output, true);
    assert.equal(status['switch:0'].apower, 42.5);
  });

  it('receives a full status push too', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { received } = connectTo(device);

    await waitFor(() => device.connectedClients() === 1);
    device.push({ 'switch:0': { id: 0, output: false } }, 'NotifyFullStatus');

    const status = await waitFor(() => received[0]);
    assert.equal(status['switch:0'].output, false);
  });

  it('answers the in-payload digest challenge and completes the request', async () => {
    const device = await startFakeShelly({ password: 'hunter2' });
    devices.push(device);
    const { connection } = connectTo(device, { password: 'hunter2' });

    await waitFor(() => device.connectedClients() === 1);
    const status = await connection.request('Shelly.GetStatus');

    assert.ok(status['switch:0']);
    // The first attempt was refused, the replay carried the auth object.
    assert.equal(device.wsCalls.length, 1);
  });

  it('rejects a wrong password instead of looping on the challenge', async () => {
    const device = await startFakeShelly({ password: 'right' });
    devices.push(device);
    const { connection } = connectTo(device, { password: 'wrong' });

    await waitFor(() => device.connectedClients() === 1);
    await assert.rejects(() => connection.request('Shelly.GetStatus'), /wrong device password/);
  });

  it('reports a missing password rather than retrying forever', async () => {
    const device = await startFakeShelly({ password: 'hunter2' });
    devices.push(device);
    const { connection } = connectTo(device);

    await waitFor(() => device.connectedClients() === 1);
    await assert.rejects(() => connection.request('Shelly.GetStatus'), /no password configured/);
  });

  it('reconnects on its own after the device drops the socket', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { received } = connectTo(device);

    await waitFor(() => device.connectedClients() === 1);
    device.dropSockets();
    await waitFor(() => device.connectedClients() === 0);

    // A device rebooting or a Wi-Fi drop must heal without anything else
    // noticing — the backoff starts at 1 s.
    await waitFor(() => device.connectedClients() === 1, { timeout: 6000 });
    device.push({ 'switch:0': { id: 0, output: true } });
    assert.ok(await waitFor(() => received[0]));
  });

  it('stops reconnecting once closed', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { connection } = connectTo(device);

    await waitFor(() => device.connectedClients() === 1);
    connection.close();
    await waitFor(() => device.connectedClients() === 0);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(device.connectedClients(), 0);
    assert.equal(connection.isConnected(), false);
  });
});

describe('createWsHub', () => {
  const devices = [];
  const hubs = [];
  after(async () => {
    hubs.forEach((hub) => hub.stop());
    await Promise.all(devices.map((device) => device.close()));
  });

  function hubFor(rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    const pushed = [];
    const hub = createWsHub({
      getConfig: () => config,
      onStatus: (shellyId, status) => pushed.push([shellyId, status]),
    });
    hubs.push(hub);
    return { hub, pushed };
  }

  it('opens a connection per target and routes its pushes', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { hub, pushed } = hubFor();

    hub.sync([{ shellyId: device.info.id, host: device.host }]);
    await waitFor(() => hub.isLive(device.info.id));

    device.push({ 'switch:0': { id: 0, output: true } });
    const [shellyId, status] = await waitFor(() => pushed[0]);
    assert.equal(shellyId, device.info.id);
    assert.equal(status['switch:0'].output, true);
  });

  it('closes the connection of a device that disappeared', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { hub } = hubFor();

    hub.sync([{ shellyId: device.info.id, host: device.host }]);
    await waitFor(() => device.connectedClients() === 1);

    // The user deleted the device in Gladys.
    hub.sync([]);
    await waitFor(() => device.connectedClients() === 0);
    assert.equal(hub.size(), 0);
  });

  it('does not connect at all when the user prefers the cloud', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { hub } = hubFor({ GLADYS_PREFER_LOCAL: false });

    hub.sync([{ shellyId: device.info.id, host: device.host }]);

    // Real-time push is a LOCAL capability: holding sockets open would be
    // pure waste when the user asked to route through the cloud.
    assert.equal(hub.size(), 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(device.connectedClients(), 0);
  });

  it('skips a device with no known address', async () => {
    const { hub } = hubFor();
    hub.sync([{ shellyId: 'shellyplug-abc' }]);
    assert.equal(hub.size(), 0);
  });

  it('is idempotent: syncing the same targets keeps the same connection', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const { hub } = hubFor();
    const target = [{ shellyId: device.info.id, host: device.host }];

    hub.sync(target);
    await waitFor(() => device.connectedClients() === 1);
    hub.sync(target);
    hub.sync(target);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // Re-syncing every cycle must not churn sockets.
    assert.equal(device.connectedClients(), 1);
    assert.equal(hub.size(), 1);
  });
});
