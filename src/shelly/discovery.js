// -----------------------------------------------------------------------------
// Device discovery.
//
// Three sources feed ONE candidate host list, in decreasing order of trust:
//   1. mDNS, mediated by the Gladys core — integration containers run on a
//      bridge network, so multicast never reaches them; the core browses on the
//      host network and hands us the RAW records (contract B.16);
//   2. the addresses the user typed by hand (other VLAN, mDNS off, static IP);
//   3. the addresses of the devices already created in Gladys, so a re-scan
//      never LOSES a device just because its mDNS announcement was missed.
//
// Every candidate is then probed over unicast HTTP (which does cross the
// bridge NAT): `GET /shelly` identifies it, `Shelly.GetStatus` tells us what it
// can do, `Shelly.GetConfig` gives the names the user set in the Shelly app.
//
// Two properties matter as much as the result itself, because a scan the user
// cannot see into is a scan they cannot fix:
//   - every candidate that produced NO device is reported at INFO level with
//     the reason. "13 candidates, 10 devices" is a dead end; "10.5.0.44: no
//     answer" is an address to check;
//   - results are published INCREMENTALLY (after the first browse round, then
//     again once merged), so the Discovery page fills up progressively instead
//     of staying empty for the whole scan.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

import { mapWithConcurrency } from './async.js';
import {
  DEVICE_TYPE,
  GEN1_MDNS_NAME_PREFIX,
  MDNS_ROUND_TIMEOUT_SECONDS,
  MDNS_ROUNDS,
  MDNS_SERVICE_NAME,
  POLL_CONCURRENCY,
  SKIP_REASON,
} from './constants.js';
import { buildDevice, readGeneration, readHost, readShellyId } from './deviceMapping.js';
import { getGen1Settings, getGen1Status } from './gen1/rest.js';
import { normalizeGen1Info, normalizeGen1Settings, normalizeGen1Status } from './gen1/normalize.js';
import { getShellyInfo, ShellyAuthError } from './rpc.js';

/**
 * Whether an mDNS record is worth probing, given the service it announces on.
 *
 * Two services are declared, and they need OPPOSITE rules:
 *
 *   - `_shelly._tcp` is Shelly's own service, so everything on it is a Shelly.
 *     Keep it all — a device named in the app announces under THAT name
 *     ("Prise Lave-vaisselle", "Pro3 L1 Batiment Perso"), so any test of the
 *     form "the name starts with shelly" silently loses exactly the devices the
 *     user cared enough about to name;
 *   - `_http._tcp` is where Gen1 devices announce, and it is shared with every
 *     printer and NAS on the LAN. Here the `shelly*` name prefix is the only
 *     thing separating a Shelly 3EM from a laser printer, so it is required.
 *
 * A record whose name carries no service at all (some cores hand over the
 * instance name alone) is kept: we asked the core for these two services and
 * nothing else, and a needless probe costs one failed HTTP request that the
 * scan summary reports — while a wrong drop costs a device.
 *
 * @param {string} name the record name
 * @returns {boolean} true when the record is worth probing
 */
function isProbableShelly(name) {
  const match = name.match(/\._([a-z0-9-]+)\._(?:tcp|udp)\b/i);
  if (!match || match[1].toLowerCase() === MDNS_SERVICE_NAME) {
    return true;
  }
  return name.toLowerCase().startsWith(GEN1_MDNS_NAME_PREFIX);
}

/**
 * Keep the usable IPv4 addresses out of a batch of raw mDNS records.
 * @param {object[]} records records handed over by the core
 * @returns {string[]} deduplicated IPv4 addresses
 */
function extractShellyHosts(records) {
  const hosts = (records || [])
    .filter((record) => isProbableShelly(`${record?.name || ''}`))
    .flatMap((record) => record?.addresses || [])
    // IPv6 link-local addresses are announced too and are not reachable from
    // the container: keep the IPv4 ones.
    .filter((address) => typeof address === 'string' && address.includes('.'));

  return [...new Set(hosts)];
}

/**
 * Run ONE mDNS browse round through the core.
 *
 * Returns `null` — not `[]` — when the browse itself could not run, so the
 * caller can tell "the core cannot scan" (stop, use the other sources) from
 * "the browse ran and nobody answered" (worth another round).
 *
 * @param {object} gladys the SDK instance
 * @param {number} [timeoutSeconds] browse duration
 * @returns {Promise<string[]|null>} the addresses, or null when the browse failed
 */
export async function browseMdnsOnce(gladys, timeoutSeconds = MDNS_ROUND_TIMEOUT_SECONDS) {
  try {
    const records = await gladys.scanNetwork('mdns', { timeoutSeconds });
    // The record NAMES, not just the addresses, and at INFO: "my Shelly is
    // missing" is answered by whether it announced itself at all and under what
    // name — a device renamed in the app announces under that name. Burying
    // this at debug is what made a whole class of missing device undiagnosable.
    const announced = (records || []).map(
      (record) =>
        `${record?.name || '(no name)'} -> ${(record?.addresses || []).join('/') || '(no address)'}`,
    );
    if (announced.length > 0) {
      logger.info(`mDNS browse: ${announced.length} record(s) — ${announced.join('; ')}`);
    } else {
      logger.info('mDNS browse: nothing answered');
    }
    return extractShellyHosts(records);
  } catch (err) {
    logger.warn(
      `mDNS scan unavailable (${err.message}) — falling back to the configured addresses`,
    );
    return null;
  }
}

/**
 * Browse the LAN for Shelly devices through the core-mediated mDNS scan.
 *
 * Degrades to an empty list — never throws — because mDNS is one source among
 * three: a core without mediated discovery, a 403 on an undeclared capture or
 * a network with multicast filtered must still leave manual hosts working.
 *
 * @param {object} gladys the SDK instance
 * @param {object} [options] browse options
 * @param {number} [options.timeoutSeconds] duration of one round
 * @param {number} [options.rounds] number of rounds merged
 * @returns {Promise<string[]>} the IP addresses announced by Shelly devices
 */
export async function browseMdns(
  gladys,
  { timeoutSeconds = MDNS_ROUND_TIMEOUT_SECONDS, rounds = MDNS_ROUNDS } = {},
) {
  // Several rounds, merged. One browse is a snapshot: a device that was busy,
  // asleep on its radio, or simply unlucky with multicast collisions answers
  // the next one. On a fleet of a dozen Shelly devices a single short browse
  // reliably comes back short — which looks exactly like "the device is not
  // supported" to the user, and is the worst kind of silent failure.
  const hosts = new Set();
  for (let round = 0; round < rounds; round += 1) {
    const found = await browseMdnsOnce(gladys, timeoutSeconds);
    if (found === null) {
      return [];
    }
    found.forEach((host) => hosts.add(host));
  }
  return [...hosts];
}

/**
 * Turn a skip outcome into the sentence a user can act on.
 * @param {{host: string, reason: string, detail?: string, model?: string}} outcome the skipped probe
 * @returns {string} a one-line explanation
 */
export function describeSkip({ host, reason, detail, model }) {
  switch (reason) {
    case SKIP_REASON.NO_ANSWER:
      return `${host}: no answer on /shelly (${detail}) — device off, wrong address, or on another VLAN`;
    case SKIP_REASON.NOT_A_SHELLY:
      return `${host}: answered /shelly but without a device id — not a Shelly`;
    case SKIP_REASON.GEN1:
      return `${host}: Gen1 Shelly (${model}) — not supported yet, see the roadmap`;
    case SKIP_REASON.NEEDS_PASSWORD:
      return `${host}: the device requires a password — set it in the integration configuration`;
    case SKIP_REASON.NO_STATUS:
      return `${host}: did not answer Shelly.GetStatus (${detail})`;
    default:
      return `${host}: skipped (${reason})`;
  }
}

/**
 * Finish probing a device that identified itself as Gen1.
 * @param {object} params probe inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.config the normalized configuration
 * @param {string} params.host address being probed
 * @param {object} params.info the raw Gen1 `/shelly` identity document
 * @param {typeof fetch} [params.fetchImpl] fetch implementation (tests)
 * @returns {Promise<object>} the outcome
 */
async function probeGen1Host({ gladys, config, host, info, fetchImpl }) {
  const credentials = {
    host,
    username: config?.deviceUsername,
    password: config?.devicePassword,
    fetchImpl,
  };

  let status;
  try {
    status = await getGen1Status(credentials);
  } catch (err) {
    return {
      host,
      reason: err instanceof ShellyAuthError ? SKIP_REASON.NEEDS_PASSWORD : SKIP_REASON.NO_STATUS,
      detail: err.message,
    };
  }

  // Names only: a failure here costs nice labels, not the device.
  let settings;
  try {
    settings = await getGen1Settings(credentials);
  } catch (err) {
    logger.debug(`${host} did not answer /settings: ${err.message}`);
  }

  const identity = normalizeGen1Info(info);
  return {
    host,
    device: buildDevice({
      info: identity,
      status: normalizeGen1Status(status),
      config: normalizeGen1Settings(settings),
      host,
      externalIds: gladys.externalIds(DEVICE_TYPE, identity.id),
    }),
  };
}

/**
 * Probe ONE candidate address and build the Gladys device behind it.
 *
 * Always resolves to an OUTCOME, never to `undefined`: a probe that finds
 * nothing is the interesting case, and the reason is the whole diagnostic.
 *
 * @param {object} params probe inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.client the transport router
 * @param {object} [params.config] the normalized configuration (Gen1 credentials)
 * @param {string} params.host address to probe
 * @param {typeof fetch} [params.fetchImpl] fetch implementation (tests)
 * @returns {Promise<{host: string, device?: object, reason?: string, detail?: string, model?: string}>} the outcome
 */
export async function probeHost({ gladys, client, config, host, fetchImpl = fetch }) {
  let info;
  try {
    info = await getShellyInfo({ host, fetchImpl });
  } catch (err) {
    return { host, reason: SKIP_REASON.NO_ANSWER, detail: err.message };
  }

  // ORDER MATTERS HERE. A Gen1 `/shelly` document has NO `id` — it identifies
  // itself with `type` and `mac`:
  //   {"type":"SHEM-3","mac":"483FDAC37E3F","auth":false,"fw":"...","num_meters":3}
  // Testing `id` first therefore sends every real Gen1 device down the
  // "not a Shelly" path and leaves the Gen1 branch below unreachable, which is
  // exactly what a Shelly 3EM looked like in the scan summary.
  const generation = Number(info?.gen);
  const isGen2Plus = Number.isFinite(generation) && generation >= 2;

  if (!info || (!info.id && !(info.type && info.mac))) {
    return { host, reason: SKIP_REASON.NOT_A_SHELLY };
  }

  // Gen1 speaks a completely different API — REST with Basic auth instead of
  // JSON-RPC with digest. Only the transport differs: normalize.js rewrites its
  // flat `/status` into the same component-keyed document the Gen2+ mapper
  // consumes, so everything below this point is shared.
  if (!isGen2Plus) {
    return probeGen1Host({ gladys, config, host, info, fetchImpl });
  }

  const rpc = client.rpcFor(info.id, host);
  let status;
  try {
    status = await rpc.call('Shelly.GetStatus');
  } catch (err) {
    return {
      host,
      reason: err instanceof ShellyAuthError ? SKIP_REASON.NEEDS_PASSWORD : SKIP_REASON.NO_STATUS,
      detail: err.message,
    };
  }

  // The device config only carries the user-set names: a failure here costs
  // nice labels, not the device. Named `deviceConfig` to keep it distinct from
  // the integration `config` this function also receives.
  let deviceConfig;
  try {
    deviceConfig = await rpc.call('Shelly.GetConfig');
  } catch (err) {
    logger.debug(`${host} (${info.id}) did not answer Shelly.GetConfig: ${err.message}`);
  }

  return {
    host,
    device: buildDevice({
      info,
      status,
      config: deviceConfig,
      host,
      externalIds: gladys.externalIds(DEVICE_TYPE, info.id),
    }),
  };
}

/**
 * Addresses that have ALREADY answered as a Shelly, remembered across scans.
 *
 * An mDNS browse is a 12-second window and comes back with a different subset
 * every time — a reference installation reported 19, then 23, then 27 records
 * for the same fleet, with several devices systematically absent. Home
 * Assistant does nothing cleverer: it simply listens PERMANENTLY and
 * accumulates.
 *
 * Remembering every address that ever answered, and re-probing it in unicast on
 * the next scan, is the closest equivalent available within a short window: a
 * device seen once is never lost again. Unicast is cheap, reliable, and crosses
 * the bridge network that multicast cannot.
 *
 * Module-level, so the memory spans scans within one container lifetime. It is
 * deliberately NOT persisted: an address is a DHCP lease, and re-probing stale
 * ones on every start would cost a timeout per dead entry. Devices the user
 * actually created carry their address in their params and are seeded from
 * there regardless.
 */
const seenShellyHosts = new Set();

/** Forget the remembered addresses (used by the tests). */
export function forgetSeenHosts() {
  seenShellyHosts.clear();
}

/**
 * Add the devices that publish to the MQTT broker but were not found locally.
 *
 * These need no IP address: `<prefix>/rpc` serves both the status read that
 * builds their features and, later, the commands. That is the whole point —
 * a device mDNS never announces is still fully usable this way.
 *
 * @param {object} params inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.mqttHub the MQTT hub
 * @param {Map<string, object>} params.found devices already found, keyed by external id
 * @returns {Promise<number>} how many devices MQTT added
 */
async function probeMqttDevices({ gladys, mqttHub, found }) {
  let added = 0;
  for (const { shellyId } of mqttHub.devices()) {
    const externalIds = gladys.externalIds(DEVICE_TYPE, shellyId);
    if (found.has(externalIds.device)) {
      continue;
    }
    try {
      const [status, deviceConfig, info] = await Promise.all([
        mqttHub.request(shellyId, 'Shelly.GetStatus'),
        mqttHub.request(shellyId, 'Shelly.GetConfig').catch(() => undefined),
        mqttHub.request(shellyId, 'Shelly.GetDeviceInfo').catch(() => undefined),
      ]);
      if (!status) {
        continue;
      }
      found.set(
        externalIds.device,
        buildDevice({
          info: { id: shellyId, model: info?.model, gen: info?.gen ?? 2, name: info?.name },
          status,
          config: deviceConfig,
          // No host on purpose: this device is reached through the broker. A
          // later local discovery fills the address in and it upgrades itself.
          host: undefined,
          externalIds,
        }),
      );
      added += 1;
    } catch (err) {
      logger.info(
        `Discovery: ${shellyId} publishes on MQTT but did not answer a request ` +
          `(${err.message}) — tick "Enable MQTT Control" on the device to use it this way`,
      );
    }
  }
  return added;
}

/**
 * Run a full discovery and return the devices found.
 *
 * @param {object} params discovery inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.client the transport router
 * @param {object} params.config the normalized configuration
 * @param {object[]} [params.knownDevices] devices already created in Gladys
 * @param {typeof fetch} [params.fetchImpl] fetch implementation (tests)
 * @param {(devices: object[]) => Promise<void>|void} [params.onProgress] called
 *   with the devices found so far, after each browse round, so the Discovery
 *   page can fill up while the scan is still running
 * @param {object} [params.mqttHub] the MQTT hub, used as a fourth source
 * @returns {Promise<object[]>} the discovered devices
 */
export async function discoverDevices({
  gladys,
  client,
  config,
  knownDevices = [],
  fetchImpl = fetch,
  onProgress,
  mqttHub,
}) {
  const knownHosts = knownDevices.map((device) => readHost(device)).filter(Boolean);
  const rememberedHosts = [...seenShellyHosts];

  /** Every address already probed, mapped to its outcome — a host is probed once. */
  const outcomes = new Map();
  /** Devices found so far, deduplicated on the hardware identity. */
  const byExternalId = new Map();

  /**
   * Probe the addresses not seen yet and fold their outcomes in.
   * @param {string[]} hosts candidate addresses
   * @returns {Promise<number>} how many addresses were actually probed
   */
  async function probeNewHosts(hosts) {
    // A device can answer on several addresses (mDNS + a manual entry pointing
    // at the same box), and the second round re-announces the first round's
    // devices: probing an address twice would only cost time.
    const fresh = [...new Set(hosts)].filter((host) => host && !outcomes.has(host));
    if (fresh.length === 0) {
      return 0;
    }
    const results = await mapWithConcurrency(fresh, POLL_CONCURRENCY, (host) =>
      probeHost({ gladys, client, config, host, fetchImpl }),
    );
    results.forEach((outcome) => {
      outcomes.set(outcome.host, outcome);
      if (outcome.device) {
        // Remembered for every later scan, whatever mDNS decides next time.
        seenShellyHosts.add(outcome.host);
        // Deduplicate on the external id, which is derived from the Shelly id
        // and is therefore the hardware identity.
        byExternalId.set(outcome.device.external_id, outcome.device);
      }
    });
    return fresh.length;
  }

  /** Hand the devices found so far to the caller, without letting it break the scan. */
  async function reportProgress() {
    if (typeof onProgress !== 'function') {
      return;
    }
    try {
      await onProgress([...byExternalId.values()]);
    } catch (err) {
      logger.warn(`Could not publish the partial discovery result: ${err.message}`);
    }
  }

  // --- Round 1: the sources we already have, plus a first mDNS browse. -------
  const firstRound = await browseMdnsOnce(gladys);
  const mdnsHosts = new Set(firstRound || []);
  const seededCount = await probeNewHosts([
    ...mdnsHosts,
    ...config.manualHosts,
    ...knownHosts,
    ...rememberedHosts,
  ]);
  logger.info(
    `Discovery: round 1 probed ${seededCount} address(es) — ` +
      `${mdnsHosts.size} from mDNS, ${config.manualHosts.length} configured by hand, ` +
      `${knownHosts.length} already created, ${rememberedHosts.length} remembered from an ` +
      `earlier scan; ${byExternalId.size} device(s) so far`,
  );
  await reportProgress();

  // --- Round 2: a second browse, because one snapshot comes back short. ------
  // Only the addresses round 1 never saw are probed, so this round costs the
  // browse plus the genuinely new devices.
  if (firstRound !== null) {
    for (let round = 1; round < MDNS_ROUNDS; round += 1) {
      const found = await browseMdnsOnce(gladys);
      if (found === null) {
        break;
      }
      found.forEach((host) => mdnsHosts.add(host));
      const added = await probeNewHosts(found);
      if (added > 0) {
        logger.info(`Discovery: round ${round + 1} found ${added} new address(es)`);
        await reportProgress();
      }
    }
  }

  // --- MQTT: the source with no discovery window to miss ---------------------
  // A device that publishes to the broker announces itself continuously, so
  // this catches exactly the devices mDNS keeps losing — and it needs no IP
  // address at all, since both reads and commands go through the broker.
  if (mqttHub) {
    const overMqtt = await probeMqttDevices({ gladys, mqttHub, found: byExternalId });
    if (overMqtt > 0) {
      logger.info(`Discovery: ${overMqtt} device(s) found over MQTT that mDNS did not announce`);
      await reportProgress();
    }
  }

  const devices = [...byExternalId.values()];
  const skipped = [...outcomes.values()].filter((outcome) => !outcome.device);

  logger.info(
    `Discovery: ${devices.length} Shelly device(s) found, ${skipped.length} address(es) skipped`,
  );
  // One line per skipped address, at INFO: this is what turns "my Shelly is
  // missing" into something the user can act on without enabling debug logs.
  skipped.forEach((outcome) => logger.info(`Discovery: ${describeSkip(outcome)}`));
  if (devices.length === 0 && config.manualHosts.length === 0) {
    logger.info(
      'Discovery: nothing found. If your devices are on another VLAN or mDNS is filtered, ' +
        'list their IP addresses in the "Addresses added by hand" field of the configuration.',
    );
  }

  return devices;
}

/**
 * Rebuild the reachability targets of the devices the user created in Gladys.
 * @param {object[]} devices the Gladys devices of the integration
 * @returns {Array<{device: object, shellyId: string, host: string|undefined}>} the targets
 */
export function buildTargets(devices) {
  return (devices || [])
    .map((device) => ({
      device,
      shellyId: readShellyId(device),
      host: readHost(device),
      gen: readGeneration(device),
    }))
    .filter((target) => Boolean(target.shellyId));
}

/**
 * Publish the discovered devices, shedding what does not fit rather than
 * losing the whole scan.
 *
 * `publishDiscoveredDevices` replaces the previous list, so the payload cannot
 * be split across requests — the last chunk would simply win. And the payload
 * is genuinely large: a Shelly Pro 3EM carries 24 features, so a fleet of
 * seventeen meters serializes to ~140 KB against a body limit around 100 KB. A
 * real installation reported exactly that, and the entire scan was discarded
 * with nothing usable on screen.
 *
 * So: publish everything, and if the core refuses the size, drop devices and
 * retry — starting with the ones the user has ALREADY created, which are the
 * least actionable on a Discovery page. Whatever is dropped is named in the
 * log, because a silently truncated list looks exactly like "the integration
 * did not find my device", which is the failure this whole module exists to
 * stop.
 *
 * @param {object} params inputs
 * @param {object} params.gladys the SDK instance
 * @param {object[]} params.devices the devices to publish
 * @param {Set<string>} [params.createdExternalIds] external ids the user already created
 * @returns {Promise<number>} how many devices were actually published
 */
export async function publishDiscovered({ gladys, devices, createdExternalIds = new Set() }) {
  // Least actionable last: an already-created device is shown for information
  // (and to refresh its address), a brand-new one is what the user came for.
  const ordered = [...devices].sort((a, b) => {
    const aCreated = createdExternalIds.has(a.external_id) ? 1 : 0;
    const bCreated = createdExternalIds.has(b.external_id) ? 1 : 0;
    return aCreated - bCreated;
  });

  let candidates = ordered;
  for (;;) {
    try {
      await gladys.publishDiscoveredDevices(candidates);
      if (candidates.length < devices.length) {
        const dropped = ordered.slice(candidates.length);
        logger.warn(
          `Discovery: the Gladys core refused the full list (too large), so ` +
            `${candidates.length} of ${devices.length} device(s) were published. ` +
            `Left out: ${dropped.map((device) => device.name).join(', ')}. ` +
            `Create some of the devices shown, then scan again to see the rest.`,
        );
      }
      return candidates.length;
    } catch (err) {
      // Matches both the raw body-parser message (`request entity too large`)
      // and the core's typed error once GladysAssistant/Gladys#2732 lands
      // (`PAYLOAD_TOO_LARGE`, underscored) — the underscore alone would
      // otherwise make this whole safety net silently stop working.
      const tooLarge = /too[ _-]?large|413/i.test(err.message || '');
      if (!tooLarge || candidates.length <= 1) {
        logger.warn(`Could not publish the discovery result: ${err.message}`);
        return 0;
      }
      // Halve rather than step down one by one: each attempt costs a round trip
      // with a ~100 KB body, and the list can be far over the limit.
      candidates = candidates.slice(0, Math.max(1, Math.floor(candidates.length / 2)));
    }
  }
}
