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
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

import { mapWithConcurrency } from './async.js';
import { DEVICE_TYPE, MDNS_SERVICE, POLL_CONCURRENCY } from './constants.js';
import { buildDevice, readHost, readShellyId } from './deviceMapping.js';
import { getShellyInfo, ShellyAuthError } from './rpc.js';

/**
 * Browse the LAN for Shelly devices through the core-mediated mDNS scan.
 *
 * Degrades to an empty list — never throws — because mDNS is one source among
 * three: a core without mediated discovery, a 403 on an undeclared capture or
 * a network with multicast filtered must still leave manual hosts working.
 *
 * @param {object} gladys the SDK instance
 * @param {number} [timeoutSeconds] scan duration
 * @returns {Promise<string[]>} the IP addresses announced by Shelly devices
 */
export async function browseMdns(gladys, timeoutSeconds = 6) {
  let records;
  try {
    records = await gladys.scanNetwork('mdns', { timeoutSeconds });
  } catch (err) {
    logger.warn(
      `mDNS scan unavailable (${err.message}) — falling back to the configured addresses`,
    );
    return [];
  }

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
 * Probe ONE candidate address and build the Gladys device behind it.
 * @param {object} params probe inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.client the transport router
 * @param {string} params.host address to probe
 * @param {typeof fetch} [params.fetchImpl] fetch implementation (tests)
 * @returns {Promise<object|undefined>} the Gladys device, or undefined
 */
export async function probeHost({ gladys, client, host, fetchImpl = fetch }) {
  let info;
  try {
    info = await getShellyInfo({ host, fetchImpl });
  } catch (err) {
    logger.debug(`No Shelly device at ${host}: ${err.message}`);
    return undefined;
  }

  if (!info || !info.id) {
    logger.debug(`${host} answered /shelly without an id — ignored`);
    return undefined;
  }

  // Gen1 devices answer /shelly too, but with a completely different API
  // (/status, /relay/0) and no `gen` field. Detect them explicitly so the log
  // says why they are skipped instead of failing later with a cryptic RPC
  // error.
  const generation = Number(info.gen);
  if (!Number.isFinite(generation) || generation < 2) {
    logger.info(
      `${host} is a Gen1 Shelly (${info.type || info.model || 'unknown model'}) — not supported yet`,
    );
    return undefined;
  }

  const rpc = client.rpcFor(info.id, host);
  let status;
  try {
    status = await rpc.call('Shelly.GetStatus');
  } catch (err) {
    if (err instanceof ShellyAuthError) {
      logger.warn(
        `${host} (${info.id}) requires a password: set it in the integration configuration`,
      );
    } else {
      logger.warn(`${host} (${info.id}) did not answer Shelly.GetStatus: ${err.message}`);
    }
    return undefined;
  }

  // The config only carries the user-set names: a failure here costs nice
  // labels, not the device.
  let config;
  try {
    config = await rpc.call('Shelly.GetConfig');
  } catch (err) {
    logger.debug(`${host} (${info.id}) did not answer Shelly.GetConfig: ${err.message}`);
  }

  return buildDevice({
    info,
    status,
    config,
    host,
    externalIds: gladys.externalIds(DEVICE_TYPE, info.id),
  });
}

/**
 * Run a full discovery and return the devices found.
 * @param {object} params discovery inputs
 * @param {object} params.gladys the SDK instance
 * @param {object} params.client the transport router
 * @param {object} params.config the normalized configuration
 * @param {object[]} [params.knownDevices] devices already created in Gladys
 * @param {typeof fetch} [params.fetchImpl] fetch implementation (tests)
 * @returns {Promise<object[]>} the discovered devices
 */
export async function discoverDevices({
  gladys,
  client,
  config,
  knownDevices = [],
  fetchImpl = fetch,
}) {
  const mdnsHosts = await browseMdns(gladys);
  const knownHosts = knownDevices.map((device) => readHost(device)).filter(Boolean);

  const candidates = [...new Set([...mdnsHosts, ...config.manualHosts, ...knownHosts])];
  logger.info(
    `Discovery: ${candidates.length} candidate address(es) — ${mdnsHosts.length} from mDNS, ` +
      `${config.manualHosts.length} configured by hand, ${knownHosts.length} already known`,
  );

  const probed = await mapWithConcurrency(candidates, POLL_CONCURRENCY, (host) =>
    probeHost({ gladys, client, host, fetchImpl }),
  );

  // A device can answer on several addresses (mDNS + a manual entry pointing at
  // the same box): deduplicate on the external id, which is derived from the
  // Shelly id and is therefore the hardware identity.
  const byExternalId = new Map();
  probed.filter(Boolean).forEach((device) => {
    byExternalId.set(device.external_id, device);
  });

  const devices = [...byExternalId.values()];
  logger.info(`Discovery: ${devices.length} Shelly device(s) found`);
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
