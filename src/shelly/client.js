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

import { DEVICE_TRANSPORTS, logger } from '@gladysassistant/integration-sdk';

import { isCloudConfigured } from '../config.js';
import { TRANSPORT_MESSAGES } from './constants.js';
import {
  clearLocalCircuit,
  isLocalInCooldown,
  LOCAL_FAILURE_THRESHOLD,
  recordLocalFailure,
  recordLocalSuccess,
} from './localCircuit.js';
import { normalizeGen1Status } from './gen1/normalize.js';
import { getGen1Status, setGen1Relay } from './gen1/rest.js';
import { createRpcClient, ShellyAuthError, ShellyConnectionError } from './rpc.js';

/**
 * Create the transport router.
 * @param {object} options router options
 * @param {() => object} options.getConfig accessor to the current normalized config
 * @param {object} options.cloud the Shelly Cloud client
 * @param {object} [options.mqttHub] the MQTT hub, tried between local and cloud
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @param {() => number} [options.now] clock (tests)
 * @returns {object} the router
 */
export function createShellyClient({
  getConfig,
  cloud,
  mqttHub,
  fetchImpl = fetch,
  now = Date.now,
}) {
  /** @type {Map<string, {client: object, host: string, username: string, password: string}>} */
  const rpcClients = new Map();
  /** Per-device local health, so an unreachable device is not retried every cycle. */
  const circuit = new Map();

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
    // A password fix or a re-discovered address makes every parked device
    // worth probing again: keeping them parked would hide the repair for up to
    // a full cooldown.
    clearLocalCircuit(circuit);
  }

  /**
   * Read the status of one device over its LOCAL transport, whichever that is.
   *
   * The generation is the only thing that differs: Gen1 answers `GET /status`
   * with a flat document and Basic auth, Gen2+ answers `Shelly.GetStatus` with
   * a component-keyed one and digest. Normalizing here means every caller above
   * — telemetry, the real-time lane, the badges — sees one shape.
   *
   * @param {string} shellyId the Shelly device id
   * @param {string} host IP address or hostname
   * @param {number} gen hardware generation
   * @returns {Promise<object>} the component-keyed status
   */
  async function localGetStatus(shellyId, host, gen) {
    if (gen === 1) {
      const { deviceUsername, devicePassword } = getConfig();
      const raw = await getGen1Status({
        host,
        username: deviceUsername,
        password: devicePassword,
        fetchImpl,
      });
      return normalizeGen1Status(raw);
    }
    return rpcFor(shellyId, host).call('Shelly.GetStatus');
  }

  /**
   * Flip a relay over the LOCAL transport of its generation.
   * @param {string} shellyId the Shelly device id
   * @param {string} host IP address or hostname
   * @param {number} gen hardware generation
   * @param {number} channel relay channel index
   * @param {boolean} on desired state
   * @returns {Promise<unknown>} the device answer
   */
  async function localSetSwitch(shellyId, host, gen, channel, on) {
    if (gen === 1) {
      const { deviceUsername, devicePassword } = getConfig();
      return setGen1Relay(
        { host, username: deviceUsername, password: devicePassword, fetchImpl },
        channel,
        on,
      );
    }
    return rpcFor(shellyId, host).call('Switch.Set', { id: channel, on });
  }

  /**
   * Run one local RPC call through the circuit breaker.
   *
   * Returns a result object rather than throwing, because "local did not work"
   * is a normal branch here (the cloud fallback follows), not an exception.
   *
   * @param {string} shellyId the Shelly device id
   * @param {string} host IP address or hostname
   * @param {() => Promise<unknown>} run the call to perform
   * @param {object} [options] behaviour options
   * @param {boolean} [options.bypassCooldown] probe even while parked
   * @returns {Promise<{ok: boolean, result?: unknown, error?: Error}>} the outcome
   */
  async function tryLocal(shellyId, host, run, { bypassCooldown = false } = {}) {
    const timestamp = now();
    if (!bypassCooldown && isLocalInCooldown(circuit, shellyId, timestamp)) {
      // Skipping the call is the whole point: it is what saves the per-cycle
      // timeout on a device that is simply unplugged.
      return {
        ok: false,
        error: new ShellyConnectionError(
          `${shellyId}: locally unreachable, parked for a few minutes before the next probe`,
        ),
      };
    }

    try {
      const result = await run();
      recordLocalSuccess(circuit, shellyId);
      return { ok: true, result };
    } catch (error) {
      const { tripped, cooldownMs } = recordLocalFailure(circuit, shellyId, timestamp);
      if (tripped) {
        // Logged once, on the threshold crossing only — the point of the
        // breaker is to stop the every-cycle WARN as much as the every-cycle
        // timeout.
        logger.warn(
          `${shellyId} failed ${LOCAL_FAILURE_THRESHOLD} local calls in a row ` +
            `(${error.message}) — pausing local probes for ${Math.round(cooldownMs / 60000)} min`,
        );
      }
      return { ok: false, error };
    }
  }

  /**
   * Fetch the full status of one device, over whichever transport works.
   * @param {object} target the device to reach
   * @param {string} target.shellyId the Shelly device id
   * @param {string} [target.host] last known IP address or hostname
   * @returns {Promise<{status: object, transport: string, degraded?: boolean, message?: object}>} status and transport
   */
  async function getStatus({ shellyId, host, gen = 2 }) {
    const config = getConfig();
    const cloudUsable = isCloudConfigured(config);
    const localFirst = config.preferLocal && Boolean(host);

    let localError;
    if (localFirst) {
      const attempt = await tryLocal(shellyId, host, () => localGetStatus(shellyId, host, gen));
      if (attempt.ok) {
        return { status: attempt.result, transport: DEVICE_TRANSPORTS.LOCAL };
      }
      localError = attempt.error;
    }

    // MQTT sits BETWEEN local and cloud, which is the order the user asked for
    // and the order that makes sense: it is still their own broker on their own
    // network, so it is neither as direct as local nor as remote as the cloud.
    if (mqttHub && mqttHub.knows(shellyId)) {
      try {
        const status = await mqttHub.request(shellyId, 'Shelly.GetStatus');
        if (status) {
          return {
            status,
            transport: DEVICE_TRANSPORTS.LOCAL,
            ...(localFirst ? { degraded: true, message: TRANSPORT_MESSAGES.MQTT_FALLBACK } : {}),
          };
        }
      } catch (mqttError) {
        logger.debug(`${shellyId}: MQTT read failed (${mqttError.message})`);
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
      const attempt = await tryLocal(shellyId, host, () => localGetStatus(shellyId, host, gen));
      if (attempt.ok) {
        return { status: attempt.result, transport: DEVICE_TRANSPORTS.LOCAL };
      }
      throw attempt.error;
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
  async function setSwitch({ shellyId, host, gen = 2 }, channel, on) {
    const config = getConfig();
    const cloudUsable = isCloudConfigured(config);
    const localFirst = config.preferLocal && Boolean(host);

    // A command is a deliberate user action. When there is no cloud to fall
    // back on, the local call is the ONLY path: pay the timeout rather than
    // refusing a click because the poll loop parked the device.
    const runSwitch = () => localSetSwitch(shellyId, host, gen, channel, on);
    const bypassCooldown = !cloudUsable;

    let localError;
    if (localFirst) {
      const attempt = await tryLocal(shellyId, host, runSwitch, { bypassCooldown });
      if (attempt.ok) {
        return DEVICE_TRANSPORTS.LOCAL;
      }
      localError = attempt.error;
    }

    if (mqttHub && mqttHub.knows(shellyId)) {
      try {
        await mqttHub.request(shellyId, 'Switch.Set', { id: channel, on });
        return DEVICE_TRANSPORTS.LOCAL;
      } catch (mqttError) {
        logger.debug(`${shellyId}: MQTT command failed (${mqttError.message})`);
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
      const attempt = await tryLocal(shellyId, host, runSwitch, { bypassCooldown });
      if (attempt.ok) {
        return DEVICE_TRANSPORTS.LOCAL;
      }
      throw attempt.error;
    }

    throw localError || new Error(`${shellyId}: no usable transport to send the command`);
  }

  return { getStatus, setSwitch, reset, rpcFor };
}
