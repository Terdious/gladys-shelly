import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  buildDigestHeader,
  createRpcClient,
  getShellyInfo,
  parseDigestChallenge,
  ShellyAuthError,
  ShellyConnectionError,
  ShellyRpcError,
} from '../../src/shelly/rpc.js';
import { startFakeShelly } from '../helpers/fakeShelly.js';

describe('parseDigestChallenge', () => {
  it('reads quoted and unquoted parameters', () => {
    const challenge = parseDigestChallenge(
      'Digest qop="auth", realm="shellypro4pm-abc", nonce="6f1a2b", algorithm=SHA-256',
    );
    assert.equal(challenge.realm, 'shellypro4pm-abc');
    assert.equal(challenge.nonce, '6f1a2b');
    assert.equal(challenge.algorithm, 'SHA-256');
    assert.equal(challenge.qop, 'auth');
  });

  it('returns an empty object on a missing or unreadable header', () => {
    assert.deepEqual(parseDigestChallenge(undefined), {});
    assert.deepEqual(parseDigestChallenge(''), {});
  });
});

describe('buildDigestHeader', () => {
  it('is deterministic for a given cnonce', () => {
    const args = {
      challenge: { realm: 'shellypro4pm-abc', nonce: 'abcdef' },
      username: 'admin',
      password: 'hunter2',
      method: 'POST',
      uri: '/rpc',
      nc: 1,
      cnonce: 'fixed-cnonce',
    };
    assert.equal(buildDigestHeader(args), buildDigestHeader(args));
  });

  it('pads the nonce counter to 8 hex digits, as RFC 7616 requires', () => {
    const header = buildDigestHeader({
      challenge: { realm: 'r', nonce: 'n' },
      username: 'admin',
      password: 'p',
      method: 'POST',
      uri: '/rpc',
      nc: 3,
      cnonce: 'c',
    });
    assert.match(header, /nc=00000003/);
    assert.match(header, /algorithm=SHA-256/);
    assert.match(header, /qop=auth/);
  });

  it('changes when the password changes', () => {
    const base = {
      challenge: { realm: 'r', nonce: 'n' },
      username: 'admin',
      method: 'POST',
      uri: '/rpc',
      nc: 1,
      cnonce: 'c',
    };
    assert.notEqual(
      buildDigestHeader({ ...base, password: 'a' }),
      buildDigestHeader({ ...base, password: 'b' }),
    );
  });
});

describe('createRpcClient against a fake device', () => {
  const devices = [];
  after(async () => {
    await Promise.all(devices.map((device) => device.close()));
  });

  it('calls a method on an unauthenticated device', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const client = createRpcClient({ host: device.host });

    const status = await client.call('Shelly.GetStatus');
    assert.equal(status['switch:0'].aenergy.total, 1234.5);
    assert.equal(device.calls.length, 1);
    assert.equal(device.calls[0].method, 'Shelly.GetStatus');
  });

  it('answers a digest challenge and reuses it on later calls', async () => {
    const device = await startFakeShelly({ password: 'hunter2' });
    devices.push(device);
    const client = createRpcClient({ host: device.host, password: 'hunter2' });

    await client.call('Shelly.GetStatus');
    // First call: 401 challenge then the authorized replay -> one accepted RPC.
    assert.equal(device.calls.length, 1);

    await client.call('Shelly.GetStatus');
    // The challenge is cached, so the second call goes through in ONE round
    // trip: exactly one more accepted RPC, not two.
    assert.equal(device.calls.length, 2);
  });

  it('rejects a wrong password with a non-transient error', async () => {
    const device = await startFakeShelly({ password: 'right' });
    devices.push(device);
    const client = createRpcClient({ host: device.host, password: 'wrong' });

    await assert.rejects(() => client.call('Shelly.GetStatus'), ShellyAuthError);
  });

  it('reports a missing password rather than looping on the challenge', async () => {
    const device = await startFakeShelly({ password: 'hunter2' });
    devices.push(device);
    const client = createRpcClient({ host: device.host });

    await assert.rejects(
      () => client.call('Shelly.GetStatus'),
      (err) => err instanceof ShellyAuthError && /no password configured/.test(err.message),
    );
  });

  it('surfaces a JSON-RPC error as a ShellyRpcError', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const client = createRpcClient({ host: device.host });

    await assert.rejects(() => client.call('Nope.Method'), ShellyRpcError);
  });

  it('turns a transport failure into a transient ShellyConnectionError', async () => {
    const client = createRpcClient({
      host: '127.0.0.1',
      port: 1,
      timeoutMs: 200,
    });
    await assert.rejects(
      () => client.call('Shelly.GetStatus'),
      (err) => err instanceof ShellyConnectionError && err.transient === true,
    );
  });

  it('sets a switch and the device reflects it', async () => {
    const device = await startFakeShelly();
    devices.push(device);
    const client = createRpcClient({ host: device.host });

    await client.call('Switch.Set', { id: 0, on: true });
    assert.equal(device.status['switch:0'].output, true);
  });
});

describe('getShellyInfo', () => {
  it('reads the identity endpoint without credentials', async () => {
    const device = await startFakeShelly({ password: 'hunter2' });
    const info = await getShellyInfo({ host: device.host });
    assert.equal(info.id, 'shellyplusplugs-fcb467266e2c');
    assert.equal(info.gen, 2);
    // The device tells us authentication is on, which is how discovery can
    // warn about a missing password instead of failing later.
    assert.equal(info.auth_en, true);
    await device.close();
  });

  it('fails with a transient error on a dead host', async () => {
    await assert.rejects(
      () => getShellyInfo({ host: '127.0.0.1', port: 1, timeoutMs: 200 }),
      ShellyConnectionError,
    );
  });
});
