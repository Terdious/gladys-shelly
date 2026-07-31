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
  MDNS_ROUND_TIMEOUT_SECONDS,
  MDNS_ROUNDS,
  MDNS_SERVICE,
  POLL_CONCURRENCY,
  SKIP_REASON,
} from './constants.js';
import { buildDevice, readHost, readShellyId } from './deviceMapping.js';
import { getShellyInfo, ShellyAuthError } from './rpc.js';

/**
 * Keep the usable IPv4 addresses out of a batch of raw mDNS records.
 * @param {object[]} records records handed over by the core
 * @returns {string[]} deduplicated IPv4 addresses
 */
function extractShellyHosts(records) {
  const hosts = (records || [])
    .filter((record) => {
      // The core browses everything it was asked to; keep only the Shelly
      // service in case a future core widens the capture.
      const name = `${record?.name || ''}`;
      return name.includes(MDNS_SERVICE) || name.toLowerCase().startsWith('shelly');
    })
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
 * Probe ONE candidate address and build the Gladys device behind it.
 *
 * Always resolves to an OUTCOME, never to `undefined`: a probe that finds
 * nothing is the interesting case, and the reason is the whole diagnostic.
 *
 * @param {object} params probe inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.client the transport router
 * @param {string} params.host address to probe
 * @param {typeof fetch} [params.fetchImpl] fetch implementation (tests)
 * @returns {Promise<{host: string, device?: object, reason?: string, detail?: string, model?: string}>} the outcome
 */
export async function probeHost({ gladys, client, host, fetchImpl = fetch }) {
  let info;
  try {
    info = await getShellyInfo({ host, fetchImpl });
  } catch (err) {
    return { host, reason: SKIP_REASON.NO_ANSWER, detail: err.message };
  }

  if (!info || !info.id) {
    return { host, reason: SKIP_REASON.NOT_A_SHELLY };
  }

  // Gen1 devices answer /shelly too, but with a completely different API
  // (/status, /relay/0) and no `gen` field. Detect them explicitly so the log
  // says why they are skipped instead of failing later with a cryptic RPC
  // error.
  const generation = Number(info.gen);
  if (!Number.isFinite(generation) || generation < 2) {
    return {
      host,
      reason: SKIP_REASON.GEN1,
      model: info.type || info.model || 'unknown model',
    };
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

  // The config only carries the user-set names: a failure here costs nice
  // labels, not the device.
  let config;
  try {
    config = await rpc.call('Shelly.GetConfig');
  } catch (err) {
    logger.debug(`${host} (${info.id}) did not answer Shelly.GetConfig: ${err.message}`);
  }

  return {
    host,
    device: buildDevice({
      info,
      status,
      config,
      host,
      externalIds: gladys.externalIds(DEVICE_TYPE, info.id),
    }),
  };
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
 * @returns {Promise<object[]>} the discovered devices
 */
export async function discoverDevices({
  gladys,
  client,
  config,
  knownDevices = [],
  fetchImpl = fetch,
  onProgress,
}) {
  const knownHosts = knownDevices.map((device) => readHost(device)).filter(Boolean);

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
      probeHost({ gladys, client, host, fetchImpl }),
    );
    results.forEach((outcome) => {
      outcomes.set(outcome.host, outcome);
      if (outcome.device) {
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
  const seededCount = await probeNewHosts([...mdnsHosts, ...config.manualHosts, ...knownHosts]);
  logger.info(
    `Discovery: round 1 probed ${seededCount} address(es) — ` +
      `${mdnsHosts.size} from mDNS, ${config.manualHosts.length} configured by hand, ` +
      `${knownHosts.length} already known; ${byExternalId.size} device(s) so far`,
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

  const devices = [...byExternalId.values()];
  const skipped = [...outcomes.values()].filter((outcome) => !outcome.device);

  // The addresses mDNS announced, listed in full: when a device is missing,
  // the first question is whether it announced itself at all, and this is the
  // line the user can compare with their router's lease table.
  if (mdnsHosts.size > 0) {
    logger.info(
      `Discovery: mDNS announced ${mdnsHosts.size} address(es): ${[...mdnsHosts].join(', ')}`,
    );
  }
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
    .map((device) => ({ device, shellyId: readShellyId(device), host: readHost(device) }))
    .filter((target) => Boolean(target.shellyId));
}
