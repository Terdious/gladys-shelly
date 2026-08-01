import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { normalizeConfig } from '../../src/config.js';
import { createShellyClient } from '../../src/shelly/client.js';
import { SKIP_REASON } from '../../src/shelly/constants.js';
import {
  browseMdns,
  buildTargets,
  describeSkip,
  discoverDevices,
  probeHost,
} from '../../src/shelly/discovery.js';
import {
  GEN1_3EM_INFO,
  GEN1_3EM_STATUS,
  PRO_4PM_STATUS,
  startFakeShelly,
} from '../helpers/fakeShelly.js';

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

  it('keeps a device that was RENAMED in the Shelly app', async () => {
    // A Shelly renamed in the app announces under that name, not under
    // `shellypro3-<mac>`. Testing "the name starts with shelly" loses exactly
    // the devices the user cared enough about to name — and loses them in the
    // way that reads as "my device is not supported".
    const gladys = fakeGladys({
      mdns: [
        { name: 'Pro3 L1 Batiment Perso._shelly._tcp.local.', addresses: ['10.5.0.209'] },
        { name: 'Prise Lave-vaisselle._shelly._tcp.local.', addresses: ['10.5.0.190'] },
        // Some cores hand over the instance name alone, with no service suffix:
        // there is nothing left to match on, and the record is still a Shelly.
        { name: 'Arrivee EDF - L1', addresses: ['10.5.0.174'] },
      ],
    });

    assert.deepEqual(await browseMdns(gladys), ['10.5.0.209', '10.5.0.190', '10.5.0.174']);
  });

  it('keeps a Gen1 device on _http._tcp but not the printers sharing it', async () => {
    // Gen1 announces on the GENERIC _http._tcp service, which every printer and
    // NAS also uses. There the `shelly*` prefix is the only thing telling a
    // 3EM from a LaserJet, so it is required — the opposite of the rule that
    // applies on Shelly's own service.
    const gladys = fakeGladys({
      mdns: [
        { name: 'shellyem3-483FDAC37E3F._http._tcp.local.', addresses: ['10.5.0.174'] },
        { name: 'HP LaserJet._http._tcp.local.', addresses: ['10.5.0.200'] },
        { name: 'diskstation._smb._tcp.local.', addresses: ['10.5.0.201'] },
      ],
    });

    assert.deepEqual(await browseMdns(gladys), ['10.5.0.174']);
  });

  it('merges several browse rounds, because one snapshot comes back short', async () => {
    // A device that was busy or unlucky with multicast collisions during the
    // first browse answers the second. Losing it would look to the user like
    // "my Shelly is not supported".
    let round = 0;
    const gladys = {
      async scanNetwork() {
        round += 1;
        return round === 1
          ? [{ name: 'a._shelly._tcp.local', addresses: ['10.5.0.171'] }]
          : [{ name: 'b._shelly._tcp.local', addresses: ['10.5.0.172'] }];
      },
    };

    assert.deepEqual(await browseMdns(gladys), ['10.5.0.171', '10.5.0.172']);
    assert.equal(round, 2);
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

  it('discovers a Gen1 3EM with the SAME features as a Gen2 Pro 3EM', async () => {
    // The point of the normalizer: whichever generation is behind the clamp,
    // the user gets the same feature names, so the same dashboards and scenes
    // work. If this drifts, a Gen1 3EM becomes a second thing to configure.
    const gen1 = await startFakeShelly({
      info: GEN1_3EM_INFO,
      gen1Status: structuredClone(GEN1_3EM_STATUS),
      gen1Settings: { name: 'Arrivée EDF - L1', relays: [{ name: 'Contacteur' }] },
    });
    devices.push(gen1);

    const { client, config } = routerFor({ manual_hosts: gen1.host });
    const found = await discoverDevices({ gladys: fakeGladys(), client, config });

    assert.equal(found.length, 1);
    const device = found[0];
    assert.equal(device.name, 'Arrivée EDF - L1');
    // The id is derived the way Shelly itself does it, so external ids and
    // selectors stay reconstructible across re-discoveries.
    assert.equal(device.external_id, 'ext:shelly:device:shem3-483fdac37e3f');

    const keys = device.features.map((feature) => feature.external_id);
    const suffix = (key) => `ext:shelly:device:shem3-483fdac37e3f:${key}`;
    // Three phases folded onto ONE em:0, exactly like a Pro 3EM reports them.
    assert.ok(keys.includes(suffix('em:0:l1_active_power')));
    assert.ok(keys.includes(suffix('em:0:l3_voltage')));
    assert.ok(keys.includes(suffix('em:0:total_active_power')));
    assert.ok(keys.includes(suffix('emdata:0:l2_total_energy')));
    // The relay the 3EM carries, named from /settings.
    assert.ok(keys.includes(suffix('switch:0:binary')));
    assert.ok(device.features.some((feature) => feature.name === 'Contacteur — On/Off'));
  });

  it('reads Gen1 values through the same state mapper', async () => {
    const gen1 = await startFakeShelly({
      info: GEN1_3EM_INFO,
      gen1Status: structuredClone(GEN1_3EM_STATUS),
    });
    devices.push(gen1);

    const { client, config } = routerFor({ manual_hosts: gen1.host });
    const found = await discoverDevices({ gladys: fakeGladys(), client, config });
    const { status } = await client.getStatus({
      shellyId: 'shem3-483fdac37e3f',
      host: gen1.host,
      gen: 1,
    });

    assert.equal(found.length, 1);
    // total_power is taken from the device, not summed from the phases.
    assert.equal(status['em:0'].total_act_power, -1050.756);
    assert.equal(status['em:0'].a_act_power, -8.4);
    // Apparent power is DERIVED (U x I), because Gen1 does not report it.
    assert.equal(Math.round(status['em:0'].a_aprt_power), Math.round(227.8 * 2.76));
    assert.equal(status['emdata:0'].a_total_act_energy, 7915525.36);
    assert.equal(status['switch:0'].output, false);
  });

  it('flips a Gen1 relay over REST, not RPC', async () => {
    const gen1 = await startFakeShelly({
      info: GEN1_3EM_INFO,
      gen1Status: structuredClone(GEN1_3EM_STATUS),
    });
    devices.push(gen1);

    const { client } = routerFor();
    const transport = await client.setSwitch(
      { shellyId: 'shem3-483fdac37e3f', host: gen1.host, gen: 1 },
      0,
      true,
    );

    assert.equal(transport, 'local');
    assert.equal(gen1.gen1Status.relays[0].ison, true);
    assert.ok(gen1.gen1Calls.some((url) => url === '/relay/0?turn=on'));
  });

  it('authenticates a Gen1 device with BASIC, not digest', async () => {
    // Sending a digest header to a Gen1 device yields a 401 loop against a
    // password that is perfectly correct — the classic Gen1 trap.
    const locked = await startFakeShelly({
      info: GEN1_3EM_INFO,
      gen1Status: structuredClone(GEN1_3EM_STATUS),
      password: 'hunter2',
    });
    devices.push(locked);

    const withoutPassword = routerFor({ manual_hosts: locked.host });
    assert.deepEqual(
      await discoverDevices({
        gladys: fakeGladys(),
        client: withoutPassword.client,
        config: withoutPassword.config,
      }),
      [],
    );

    const withPassword = routerFor({ manual_hosts: locked.host, device_password: 'hunter2' });
    const found = await discoverDevices({
      gladys: fakeGladys(),
      client: withPassword.client,
      config: withPassword.config,
    });
    assert.equal(found.length, 1);
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

  it('publishes what it has after each round instead of only at the end', async () => {
    // A full scan runs two browse rounds and takes ~25 s: leaving the Discovery
    // page empty for that whole time reads as "nothing found".
    const first = await startFakeShelly({
      info: { id: 'shellypro4pm-aaaa', mac: 'AAAA', model: 'SPSW-004PE16EU', gen: 2 },
      status: structuredClone(PRO_4PM_STATUS),
    });
    const second = await startFakeShelly({
      info: { id: 'shellyplusplugs-bbbb', mac: 'BBBB', model: 'SNPL-00112EU', gen: 2 },
    });
    devices.push(first, second);

    // The second device only answers the second browse — the exact case the
    // multi-round scan exists for.
    let round = 0;
    const gladys = {
      ...fakeGladys(),
      async scanNetwork() {
        round += 1;
        return round === 1
          ? [{ name: 'a._shelly._tcp.local', addresses: [first.host] }]
          : [{ name: 'b._shelly._tcp.local', addresses: [second.host] }];
      },
    };

    const { client, config } = routerFor();
    const progress = [];
    const found = await discoverDevices({
      gladys,
      client,
      config,
      onProgress: (partial) => progress.push(partial.length),
    });

    assert.equal(found.length, 2);
    // One device was already on screen before the second browse even started.
    assert.deepEqual(progress, [1, 2]);
  });

  it('keeps scanning when publishing a partial result fails', async () => {
    const shelly = await startFakeShelly();
    devices.push(shelly);

    const { client, config } = routerFor({ manual_hosts: shelly.host });
    const found = await discoverDevices({
      gladys: fakeGladys(),
      client,
      config,
      onProgress: () => {
        throw new Error('core busy');
      },
    });

    // A hiccup on the progress channel must not cost the user the scan.
    assert.equal(found.length, 1);
  });
});

describe('probeHost outcomes', () => {
  const devices = [];
  after(async () => {
    await Promise.all(devices.map((device) => device.close()));
  });

  /** A router wired to the real RPC stack, with no cloud configured. */
  function routerFor(rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    return createShellyClient({
      getConfig: () => config,
      cloud: {
        async getStatus() {
          throw new Error('cloud not configured');
        },
      },
    });
  }

  const gladys = {
    externalIds: (type, platformId) => ({
      device: `ext:shelly:${type}:${platformId}`,
      feature: (key) => `ext:shelly:${type}:${platformId}:${key}`,
    }),
  };

  it('says WHY an address produced no device, instead of just dropping it', async () => {
    // "13 candidates, 10 devices" is a dead end for a user whose Shelly is
    // missing. Every skipped address must carry a reason they can act on.
    const outcome = await probeHost({ gladys, client: routerFor(), host: '127.0.0.1:1' });

    assert.equal(outcome.device, undefined);
    assert.equal(outcome.reason, SKIP_REASON.NO_ANSWER);
    assert.equal(outcome.host, '127.0.0.1:1');
    assert.match(describeSkip(outcome), /no answer/i);
  });

  it('recognises a Gen1 device, which has no `id` at all', async () => {
    // Regression test for the bench report. A Shelly 3EM was reported as
    // "answered /shelly but without a device id — not a Shelly", because the
    // `id` test ran BEFORE the generation test and no Gen1 device has an `id`.
    // The Gen1 branch was unreachable for every real Gen1 device.
    const gen1 = await startFakeShelly({
      info: GEN1_3EM_INFO,
      gen1Status: structuredClone(GEN1_3EM_STATUS),
    });
    devices.push(gen1);

    const outcome = await probeHost({
      gladys,
      client: routerFor(),
      config: normalizeConfig({}),
      host: gen1.host,
    });

    assert.equal(outcome.reason, undefined);
    assert.equal(outcome.device.external_id, 'ext:shelly:device:shem3-483fdac37e3f');
  });

  it('still reports a genuine non-Shelly as such', async () => {
    // The permissive `_http._tcp` browse will hand over printers and NAS boxes.
    // Widening the Gen1 test must not turn every HTTP responder into a Shelly.
    const notAShelly = await startFakeShelly({ info: { product: 'LaserJet', serial: '42' } });
    devices.push(notAShelly);

    const outcome = await probeHost({ gladys, client: routerFor(), host: notAShelly.host });

    assert.equal(outcome.reason, SKIP_REASON.NOT_A_SHELLY);
  });

  it('names a password-protected device as such', async () => {
    const locked = await startFakeShelly({ password: 'hunter2' });
    devices.push(locked);

    const outcome = await probeHost({ gladys, client: routerFor(), host: locked.host });

    assert.equal(outcome.reason, SKIP_REASON.NEEDS_PASSWORD);
    // The sentence has to name the fix, not just the symptom.
    assert.match(describeSkip(outcome), /requires a password/i);
  });

  it('returns the device when the probe succeeds', async () => {
    const shelly = await startFakeShelly();
    devices.push(shelly);

    const outcome = await probeHost({ gladys, client: routerFor(), host: shelly.host });

    assert.equal(outcome.reason, undefined);
    assert.equal(outcome.device.external_id, 'ext:shelly:device:shellyplusplugs-fcb467266e2c');
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
