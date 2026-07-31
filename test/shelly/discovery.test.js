import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { browseMdns, buildTargets, discoverDevices } from '../../src/shelly/discovery.js';
import { PRO_4PM_STATUS, startFakeShelly } from '../helpers/fakeShelly.js';

/** Minimal stand-in for the SDK surface discovery uses. */
function fakeGladys({ mdns = [], mdnsError = null } = {}) {
  return {
    async scanNetwork(type, options) {
      if (mdnsError) {
        throw mdnsError;
      }
      this.lastScan = { type, options };
      return mdns;
    },
    externalIds(type, platformId) {
      return {
        device: `ext:shelly:${type}:${platformId}`,
        feature: (key) => `ext:shelly:${type}:${platformId}:${key}`,
      };
    },
  };
}

describe('browseMdns', () => {
  it('keeps the IPv4 addresses of the Shelly service', async () => {
    const gladys = fakeGladys({
      mdns: [
        {
          name: 'shellypro3em-2cbcbba663cc._shelly._tcp.local',
          addresses: ['10.5.0.171', 'fe80::1'],
        },
        { name: 'shellyplusplugs-fcb467266e2c._shelly._tcp.local', addresses: ['10.5.0.180'] },
        // Something else on the LAN answering the browse.
        { name: 'printer._ipp._tcp.local', addresses: ['10.5.0.200'] },
      ],
    });

    assert.deepEqual(await browseMdns(gladys), ['10.5.0.171', '10.5.0.180']);
  });

  it('degrades to an empty list when the core cannot scan', async () => {
    // A core without mediated discovery, or a 403 on an undeclared capture:
    // manual addresses must keep working, so this must not throw.
    const gladys = fakeGladys({ mdnsError: new Error('403 network_discovery not declared') });
    assert.deepEqual(await browseMdns(gladys), []);
  });
});

describe('discoverDevices', () => {
  const devices = [];
  after(async () => {
    await Promise.all(devices.map((device) => device.close()));
  });

  /** A router wired to the real RPC stack, with no cloud configured. */
  function routerFor(rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    const client = createShellyClient({
      getConfig: () => config,
      cloud: {
        async getStatus() {
          throw new Error('cloud not configured');
        },
      },
    });
    return { client, config };
  }

  it('probes an mDNS host and builds the device behind it', async () => {
    const shelly = await startFakeShelly({
      info: {
        id: 'shellypro4pm-ece334ea4d10',
        mac: 'ECE334EA4D10',
        model: 'SPSW-004PE16EU',
        gen: 2,
      },
      status: PRO_4PM_STATUS,
      config: { sys: { device: { name: 'Éclairages RDC' } }, 'switch:0': { name: 'SdB' } },
    });
    devices.push(shelly);

    const { client, config } = routerFor();
    const found = await discoverDevices({
      gladys: fakeGladys({ mdns: [{ name: 'x._shelly._tcp.local', addresses: [shelly.host] }] }),
      client,
      config,
    });

    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Éclairages RDC');
    assert.equal(found[0].external_id, 'ext:shelly:device:shellypro4pm-ece334ea4d10');
    assert.ok(found[0].features.length >= 4);
    assert.ok(found[0].features.some((feature) => feature.name === 'SdB — On/Off'));
  });

  it('deduplicates a device reachable through several addresses', async () => {
    const shelly = await startFakeShelly();
    devices.push(shelly);

    const { client, config } = routerFor({ manual_hosts: shelly.host });
    const found = await discoverDevices({
      // The same box announced over mDNS AND typed by hand.
      gladys: fakeGladys({ mdns: [{ name: 'x._shelly._tcp.local', addresses: [shelly.host] }] }),
      client,
      config,
      knownDevices: [
        {
          external_id: 'ext:shelly:device:shellyplusplugs-fcb467266e2c',
          params: [{ name: 'IP_ADDRESS', value: shelly.host }],
        },
      ],
    });

    assert.equal(found.length, 1);
  });

  it('finds a device by its manual address alone when mDNS is blind', async () => {
    const shelly = await startFakeShelly();
    devices.push(shelly);

    const { client, config } = routerFor({ manual_hosts: shelly.host });
    const found = await discoverDevices({
      gladys: fakeGladys({ mdnsError: new Error('no mediated discovery on this core') }),
      client,
      config,
    });

    assert.equal(found.length, 1);
    assert.equal(found[0].external_id, 'ext:shelly:device:shellyplusplugs-fcb467266e2c');
  });

  it('skips a Gen1 device instead of failing on it later', async () => {
    // A Gen1 answers /shelly with a completely different document and no `gen`.
    const gen1 = await startFakeShelly({
      info: {
        type: 'SHSW-25',
        mac: 'A4CF12345678',
        id: 'shellyswitch25-a4cf12345678',
        auth: false,
      },
    });
    devices.push(gen1);

    const { client, config } = routerFor({ manual_hosts: gen1.host });
    const found = await discoverDevices({ gladys: fakeGladys(), client, config });

    assert.deepEqual(found, []);
  });

  it('ignores an address that is not a Shelly at all', async () => {
    const { client, config } = routerFor({ manual_hosts: '127.0.0.1:1' });
    const found = await discoverDevices({ gladys: fakeGladys(), client, config });
    assert.deepEqual(found, []);
  });

  it('skips a password-protected device rather than half-creating it', async () => {
    const locked = await startFakeShelly({ password: 'hunter2' });
    devices.push(locked);

    // No password configured: /shelly answers, but Shelly.GetStatus does not,
    // so we cannot know the feature set — publishing a featureless device
    // would be worse than skipping it.
    const { client, config } = routerFor({ manual_hosts: locked.host });
    const found = await discoverDevices({ gladys: fakeGladys(), client, config });
    assert.deepEqual(found, []);
  });

  it('discovers a password-protected device once the password is set', async () => {
    const locked = await startFakeShelly({ password: 'hunter2' });
    devices.push(locked);

    const { client, config } = routerFor({
      manual_hosts: locked.host,
      device_password: 'hunter2',
    });
    const found = await discoverDevices({ gladys: fakeGladys(), client, config });

    assert.equal(found.length, 1);
  });
});

describe('buildTargets', () => {
  it('turns the Gladys devices back into reachability targets', () => {
    const targets = buildTargets([
      {
        external_id: 'ext:shelly:device:shellypro3em-abc',
        params: [
          { name: 'SHELLY_ID', value: 'shellypro3em-abc' },
          { name: 'IP_ADDRESS', value: '10.5.0.171' },
        ],
      },
      // A device from another integration, or a broken one: dropped.
      { external_id: 'mqtt:something' },
    ]);

    assert.equal(targets.length, 1);
    assert.equal(targets[0].shellyId, 'shellypro3em-abc');
    assert.equal(targets[0].host, '10.5.0.171');
  });

  it('tolerates an empty or missing device list', () => {
    assert.deepEqual(buildTargets([]), []);
    assert.deepEqual(buildTargets(undefined), []);
  });
});
