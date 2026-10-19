import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  credentialsFor,
  normalizeConfig,
  normalizeDeviceKey,
  parseDevicePasswords,
} from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { TRANSPORT_MESSAGES, withPasswordWarning } from '../../src/shelly/constants.js';
import { createTelemetry } from '../../src/shelly/telemetry.js';
import { startFakeShelly } from '../helpers/fakeShelly.js';

describe('per-device passwords: parsing (issue #9)', () => {
  it('reads device=password entries, by Shelly id, MAC or address', () => {
    assert.deepEqual(
      parseDevicePasswords(
        'shellyplus1-a8032ab12345=first ; 10.5.0.42=second\nAA:BB:CC:DD:EE:FF=third;garage.local:80=fourth',
      ),
      [
        { key: 'shellyplus1-a8032ab12345', password: 'first' },
        { key: '10.5.0.42', password: 'second' },
        { key: 'aabbccddeeff', password: 'third' },
        { key: 'garage.local', password: 'fourth' },
      ],
    );
  });

  it('keeps a ; or a = inside a password', () => {
    assert.deepEqual(parseDevicePasswords('10.5.0.42=pa;ss=1;shellyem3-483fdac37e3f=a=b'), [
      { key: '10.5.0.42', password: 'pa;ss=1' },
      { key: 'shellyem3-483fdac37e3f', password: 'a=b' },
    ]);
  });

  it('ignores what is not an entry', () => {
    assert.deepEqual(parseDevicePasswords(''), []);
    assert.deepEqual(parseDevicePasswords(undefined), []);
    assert.deepEqual(parseDevicePasswords('no equal sign'), []);
    assert.deepEqual(parseDevicePasswords('10.5.0.42='), []);
  });

  it('normalizes the device keys', () => {
    assert.equal(normalizeDeviceKey('AA-BB-CC-DD-EE-FF'), 'aabbccddeeff');
    assert.equal(normalizeDeviceKey('http://10.5.0.42:8080/'), '10.5.0.42');
    assert.equal(normalizeDeviceKey(' ShellyPlus1-ABC '), 'shellyplus1-abc');
  });
});

describe('per-device passwords: resolution', () => {
  const config = normalizeConfig({
    device_password: 'shared',
    device_passwords: '10.5.0.42=by-ip; 2cbcbba663cc=by-mac; shellyplus1-a8032ab12345=by-id',
  });

  it('picks the device own password by id, MAC tail or address, the shared one otherwise', () => {
    assert.equal(
      credentialsFor(config, { shellyId: 'shellyplus1-a8032ab12345' }).password,
      'by-id',
    );
    assert.equal(
      credentialsFor(config, { shellyId: 'shellypro3em-2cbcbba663cc' }).password,
      'by-mac',
    );
    assert.equal(credentialsFor(config, { host: '10.5.0.42:80' }).password, 'by-ip');
    const other = credentialsFor(config, { shellyId: 'shellyplug-000000000000', host: '10.5.0.9' });
    assert.deepEqual(other, { username: 'admin', password: 'shared', perDevice: false });
  });

  it('names the devices refusing the password in the connection message, in every language', () => {
    const message = withPasswordWarning(
      { en: 'Connected.', fr: 'Connecté.', de: 'Verbunden.', es: 'Conectado.' },
      ['shellyplus1-a8032ab12345'],
      [{ external_id: 'ext:shelly:device:shellyplus1-a8032ab12345', name: 'Garage' }],
    );
    assert.match(message.en, /^Connected\. 1 device\(s\) refused the password: Garage\./);
    assert.match(message.fr, /Mots de passe par appareil/);
    assert.equal(withPasswordWarning(undefined, []), undefined);
  });
});

describe('per-device passwords: on a real (fake) device', () => {
  const devices = [];
  after(() => Promise.all(devices.map((device) => device.close())));

  /** Telemetry over one created device, recording transports and auth failures. */
  async function run(device, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const transports = [];
    let refused = [];
    const gladys = {
      devices: [],
      async getDevices() {
        return [
          {
            external_id: `ext:shelly:device:${device.info.id}`,
            params: [
              { name: 'SHELLY_ID', value: device.info.id },
              { name: 'IP_ADDRESS', value: device.host },
            ],
          },
        ];
      },
      async publishStates() {},
      async publishTransports(entries) {
        transports.push(...entries);
      },
      externalIds: (type, id) => ({
        device: `ext:shelly:${type}:${id}`,
        feature: (key) => `ext:shelly:${type}:${id}:${key}`,
      }),
    };
    const client = createShellyClient({ getConfig: () => config, cloud: {} });
    const telemetry = createTelemetry({
      gladys,
      client,
      getConfig: () => config,
      onAuthFailures: (ids) => {
        refused = ids;
      },
    });
    const metrics = await telemetry.refreshValues();
    telemetry.stop();
    return { metrics, transports, refused: () => refused };
  }

  it('reaches a device whose password differs from the shared one', async () => {
    const device = await startFakeShelly({ password: 'its-own' });
    devices.push(device);
    const { metrics, refused } = await run(device, {
      device_password: 'shared',
      device_passwords: `${device.info.id}=its-own`,
    });
    assert.equal(metrics.reachable, 1);
    assert.deepEqual(refused(), []);
  });

  it('says which device refuses the password, on its badge and to the connection status', async () => {
    const device = await startFakeShelly({ password: 'its-own' });
    devices.push(device);
    const { metrics, transports, refused } = await run(device, { device_password: 'shared' });
    assert.equal(metrics.reachable, 0);
    assert.deepEqual(transports, [
      {
        external_id: `ext:shelly:device:${device.info.id}`,
        transport: 'unreachable',
        degraded: true,
        message: TRANSPORT_MESSAGES.AUTH_FAILED,
      },
    ]);
    assert.deepEqual(refused(), [device.info.id]);
  });
});
