import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createCloudClient,
  normalizeCloudId,
  ShellyCloudAuthError,
  ShellyCloudError,
} from '../../src/shelly/cloudClient.js';

const CONFIG = {
  cloudServer: 'shelly-53-eu.shelly.cloud',
  cloudAuthKey: 'the-key',
};

/** A fetch stub recording the requests and replying with a canned payload. */
function fakeFetch(payload, { status = 200, throwOn = null } = {}) {
  const requests = [];
  const impl = async (url, options) => {
    requests.push({ url, body: Object.fromEntries(new URLSearchParams(options.body)) });
    if (throwOn) {
      throw throwOn;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      },
    };
  };
  impl.requests = requests;
  return impl;
}

describe('normalizeCloudId', () => {
  it('turns any Shelly identifier into the id the Cloud API expects', () => {
    // The single most common wiring mistake: sending the LOCAL id to the cloud.
    assert.equal(normalizeCloudId('shellypro3em-2cbcbba663cc'), '2cbcbba663cc');
    assert.equal(normalizeCloudId('2C:BC:BB:A6:63:CC'), '2cbcbba663cc');
    assert.equal(normalizeCloudId('2cbcbba663cc'), '2cbcbba663cc');
    assert.equal(normalizeCloudId(undefined), '');
  });
});

describe('createCloudClient', () => {
  it('posts the auth key form-encoded and unwraps the envelope', async () => {
    const fetchImpl = fakeFetch({
      isok: true,
      data: { device_status: { 'switch:0': { output: true } } },
    });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    const status = await cloud.getStatus('shellyplusplugs-fcb467266e2c');

    assert.deepEqual(status, { 'switch:0': { output: true } });
    assert.equal(fetchImpl.requests[0].url, 'https://shelly-53-eu.shelly.cloud/device/status');
    assert.deepEqual(fetchImpl.requests[0].body, {
      id: 'fcb467266e2c',
      auth_key: 'the-key',
    });
  });

  it('keys all_status by the normalized cloud id', async () => {
    const fetchImpl = fakeFetch({
      isok: true,
      data: {
        devices_status: {
          '2CBCBBA663CC': { 'em:0': { a_act_power: 12 } },
          fcb467266e2c: { 'switch:0': { output: false } },
        },
      },
    });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    const statuses = await cloud.getAllStatus();

    assert.deepEqual(Object.keys(statuses).sort(), ['2cbcbba663cc', 'fcb467266e2c']);
  });

  it('sends a relay command with the on/off vocabulary of the API', async () => {
    const fetchImpl = fakeFetch({ isok: true, data: {} });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    await cloud.setRelay('shellypro4pm-ece334ea4d10', 2, false);

    assert.equal(
      fetchImpl.requests[0].url,
      'https://shelly-53-eu.shelly.cloud/device/relay/control',
    );
    assert.deepEqual(fetchImpl.requests[0].body, {
      id: 'ece334ea4d10',
      channel: '2',
      turn: 'off',
      auth_key: 'the-key',
    });
  });

  it('recognizes a rejected key in the body, not only in the HTTP status', async () => {
    // The API answers 200 with `isok: false` for a bad key.
    const fetchImpl = fakeFetch({ isok: false, errors: { auth_key: 'invalid' } });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    await assert.rejects(() => cloud.getAllStatus(), ShellyCloudAuthError);
  });

  it('recognizes a rejected key from the HTTP status too', async () => {
    const fetchImpl = fakeFetch({}, { status: 401 });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    await assert.rejects(() => cloud.getAllStatus(), ShellyCloudAuthError);
  });

  it('treats a non-auth API error as transient', async () => {
    const fetchImpl = fakeFetch({ isok: false, errors: { device: 'not online' } });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    await assert.rejects(
      () => cloud.getStatus('plug'),
      (err) => err instanceof ShellyCloudError && err.transient === true,
    );
  });

  it('refuses to call anything when the credentials are missing', async () => {
    const fetchImpl = fakeFetch({ isok: true, data: {} });
    const cloud = createCloudClient({ getConfig: () => ({}), fetchImpl });

    await assert.rejects(() => cloud.getAllStatus(), ShellyCloudAuthError);
    // Nothing must leave the container without a key to authenticate it.
    assert.equal(fetchImpl.requests.length, 0);
  });

  it('counts the devices of the account when checking the credentials', async () => {
    const fetchImpl = fakeFetch({
      isok: true,
      data: { devices_status: { a1b2c3d4e5f6: {}, 112233445566: {} } },
    });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    assert.equal(await cloud.checkCredentials(), 2);
  });

  it('turns a network failure into a transient error', async () => {
    const fetchImpl = fakeFetch({}, { throwOn: new Error('ENOTFOUND') });
    const cloud = createCloudClient({ getConfig: () => CONFIG, fetchImpl });

    await assert.rejects(
      () => cloud.getAllStatus(),
      (err) => err instanceof ShellyCloudError && err.transient === true,
    );
  });
});
