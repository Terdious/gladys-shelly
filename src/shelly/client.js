// -----------------------------------------------------------------------------
// Dual-transport router: local RPC first, Shelly Cloud as a fallback.
//
// This is the only module that decides HOW a given device is reached, and it
// is the single source of truth for the transport badge Gladys renders. Every
// call returns both the payload AND the transport that produced it, so the
// caller never has to guess (or worse, keep its own parallel bookkeeping).
//
// Policy:
//   - `preferLocal` (the core's "Prefer the local connection" toggle) true:
//     try local, fall back to cloud, and mark the result DEGRADED — falling
//     back is exactly the "works, but not nominally" case the badge exists for;
//   - `preferLocal` false: go to the cloud directly, nominal, no degradation;
//   - nothing works: `unreachable`, and the error is surfaced to the caller.
//
// An RPC client is cached per device so the digest challenge survives between
// polls (one round trip instead of two on an authenticated device); the cache
// is keyed by host so a DHCP lease change naturally builds a fresh client.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import { isCloudConfigured } from '../config.js';
import { TRANSPORT_MESSAGES } from './constants.js';
import { createRpcClient, ShellyAuthError } from './rpc.js';

/**
 * Create the transport router.
 * @param {object} options router options
 * @param {() => object} options.getConfig accessor to the current normalized config
 * @param {object} options.cloud the Shelly Cloud client
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @returns {object} the router
 */
export function createShellyClient({ getConfig, cloud, fetchImpl = fetch }) {
  /** @type {Map<string, {client: object, host: string, username: string, password: string}>} */
  const rpcClients = new Map();

  /**
   * Get (or build) the RPC client of one device.
   * The cached entry is dropped when the host or the credentials changed, so a
   * password fix in the configuration takes effect on the very next call
   * instead of after a container restart.
   * @param {string} shellyId the Shelly device id
   * @param {string} host IP address or hostname
   * @returns {object} the RPC client
   */
  function rpcFor(shellyId, host) {
    const { deviceUsername, devicePassword } = getConfig();
    const cached = rpcClients.get(shellyId);
    if (
      cached &&
      cached.host === host &&
      cached.username === deviceUsername &&
      cached.password === devicePassword
    ) {
      return cached.client;
    }
    const client = createRpcClient({
      host,
      username: deviceUsername,
      password: devicePassword,
      fetchImpl,
    });
    rpcClients.set(shellyId, {
      client,
      host,
      username: deviceUsername,
      password: devicePassword,
    });
    return client;
  }

  /** Forget the cached RPC clients (credentials changed, devices re-discovered). */
  function reset() {
    rpcClients.clear();
  }

  /**
   * Fetch the full status of one device, over whichever transport works.
   * @param {object} target the device to reach
   * @param {string} target.shellyId the Shelly device id
   * @param {string} [target.host] last known IP address or hostname
   * @returns {Promise<{status: object, transport: string, degraded?: boolean, message?: object}>} status and transport
   */
  async function getStatus({ shellyId, host }) {
    const config = getConfig();
    const cloudUsable = isCloudConfigured(config);
    const localFirst = config.preferLocal && Boolean(host);

    let localError;
    if (localFirst) {
      try {
        const status = await rpcFor(shellyId, host).call('Shelly.GetStatus');
        return { status, transport: DEVICE_TRANSPORTS.LOCAL };
      } catch (err) {
        localError = err;
      }
    }

    if (cloudUsable) {
      try {
        const status = await cloud.getStatus(shellyId);
        if (status) {
          // Reaching the cloud after a local failure works, but it is not the
          // nominal path: say so, with the reason the user can act on.
          const degraded = localFirst
            ? {
                degraded: true,
                message:
                  localError instanceof ShellyAuthError
                    ? TRANSPORT_MESSAGES.AUTH_FAILED
                    : TRANSPORT_MESSAGES.CLOUD_FALLBACK,
              }
            : {};
          return { status, transport: DEVICE_TRANSPORTS.CLOUD, ...degraded };
        }
      } catch (cloudError) {
        // Report the LOCAL failure when we tried local first: it is the one
        // the user can actually fix (wrong IP, wrong password).
        throw localError || cloudError;
      }
    }

    // Not preferring local but no cloud configured: local is all we have left.
    if (!localFirst && host) {
      const status = await rpcFor(shellyId, host).call('Shelly.GetStatus');
      return { status, transport: DEVICE_TRANSPORTS.LOCAL };
    }

    throw localError || new Error(`${shellyId}: no usable transport (no known address, no cloud)`);
  }

  /**
   * Turn a relay channel on or off, over whichever transport works.
   * @param {object} target the device to reach
   * @param {string} target.shellyId the Shelly device id
   * @param {string} [target.host] last known IP address or hostname
   * @param {number} channel relay channel index
   * @param {boolean} on desired state
   * @returns {Promise<string>} the transport that carried the command
   */
  async function setSwitch({ shellyId, host }, channel, on) {
    const config = getConfig();
    const cloudUsable = isCloudConfigured(config);
    const localFirst = config.preferLocal && Boolean(host);

    let localError;
    if (localFirst) {
      try {
        await rpcFor(shellyId, host).call('Switch.Set', { id: channel, on });
        return DEVICE_TRANSPORTS.LOCAL;
      } catch (err) {
        localError = err;
      }
    }

    if (cloudUsable) {
      try {
        await cloud.setRelay(shellyId, channel, on);
        return DEVICE_TRANSPORTS.CLOUD;
      } catch (cloudError) {
        throw localError || cloudError;
      }
    }

    if (!localFirst && host) {
      await rpcFor(shellyId, host).call('Switch.Set', { id: channel, on });
      return DEVICE_TRANSPORTS.LOCAL;
    }

    throw localError || new Error(`${shellyId}: no usable transport to send the command`);
  }

  return { getStatus, setSwitch, reset, rpcFor };
}
