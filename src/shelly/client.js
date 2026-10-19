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
import { COMPONENTS_RETRY_MS, TRANSPORT_MESSAGES } from './constants.js';
import {
  clearLocalCircuit,
  isLocalInCooldown,
  LOCAL_FAILURE_THRESHOLD,
  recordLocalFailure,
  recordLocalSuccess,
} from './localCircuit.js';
import { normalizeGen1Status } from './gen1/normalize.js';
import { gen1Get, getGen1Status } from './gen1/rest.js';
import { buildCommand } from './commands.js';
import { createRpcClient, ShellyAuthError, ShellyConnectionError } from './rpc.js';
import {
  fetchVirtualComponents,
  hidesVirtualStatus,
  mergeVirtualStatus,
  VIRTUAL_SET_METHOD,
} from './virtualComponents.js';

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
   * Virtual-component metadata per Shelly id (`Shelly.GetComponents`). Read at
   * every discovery, and lazily after a restart; never on every poll, because
   * it is paginated and does not change unless the device is reconfigured.
   */
  const componentsCache = new Map();
  /** When a metadata read last failed, so it is not retried on every cycle. */
  const componentsFailedAt = new Map();

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
   * Send a command over the LOCAL transport of its generation.
   * @param {string} shellyId the Shelly device id
   * @param {string} host IP address or hostname
   * @param {number} gen hardware generation
   * @param {object} command a command from commands.js
   * @returns {Promise<unknown>} the device answer
   */
  async function localCommand(shellyId, host, gen, command) {
    if (gen === 1) {
      if (!command.gen1) {
        throw new Error(`${shellyId}: ${command.rpc.method} has no Gen1 equivalent`);
      }
      const { deviceUsername, devicePassword } = getConfig();
      return gen1Get({
        host,
        path: command.gen1,
        username: deviceUsername,
        password: devicePassword,
        fetchImpl,
      });
    }
    return rpcFor(shellyId, host).call(command.rpc.method, command.rpc.params);
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
   * RPC call on one device over its local address, for the follow-up reads of
   * a status that just succeeded there.
   * @param {string} shellyId the Shelly device id
   * @param {string} host IP address or hostname
   * @returns {(method: string, params?: object) => Promise<object>} the call
   */
  function localCall(shellyId, host) {
    return (method, params) => rpcFor(shellyId, host).call(method, params);
  }

  /**
   * Complete the status of a device that hides its virtual components from
   * `Shelly.GetStatus` (LinkedGo ST1820): their values are only served by
   * `Shelly.GetComponents`, so it is read on every poll of such a device — and
   * only of such a device. The metadata it carries refreshes the cache on the
   * way.
   *
   * Never throws: the status that was read is still worth publishing, so a
   * failed completion costs one cycle of thermostat values, not the device.
   *
   * @param {string} shellyId the Shelly device id
   * @param {object} status the `Shelly.GetStatus` result
   * @param {(method: string, params?: object) => Promise<object>} call RPC call on the device
   * @returns {Promise<object>} the completed status
   */
  async function completeStatus(shellyId, status, call) {
    if (!hidesVirtualStatus(status)) {
      return status;
    }
    try {
      const components = await fetchVirtualComponents(call);
      rememberComponents(shellyId, components);
      return mergeVirtualStatus(status, components);
    } catch (err) {
      logger.debug(`${shellyId}: Shelly.GetComponents failed (${err.message})`);
      return status;
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
        return {
          status: await completeStatus(shellyId, attempt.result, localCall(shellyId, host)),
          transport: DEVICE_TRANSPORTS.LOCAL,
        };
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
            status: await completeStatus(shellyId, status, (method, params) =>
              mqttHub.request(shellyId, method, params),
            ),
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
        return {
          status: await completeStatus(shellyId, attempt.result, localCall(shellyId, host)),
          transport: DEVICE_TRANSPORTS.LOCAL,
        };
      }
      throw attempt.error;
    }

    throw localError || new Error(`${shellyId}: no usable transport (no known address, no cloud)`);
  }

  /**
   * Send a command (commands.js) over whichever transport works.
   * @param {object} target the device to reach
   * @param {string} target.shellyId the Shelly device id
   * @param {string} [target.host] last known IP address or hostname
   * @param {number} [target.gen] hardware generation
   * @param {object} command the command, spelled for every transport
   * @returns {Promise<string>} the transport that carried the command
   */
  async function sendCommand({ shellyId, host, gen = 2 }, command) {
    const config = getConfig();
    const cloudUsable = isCloudConfigured(config) && Boolean(command.cloud);
    const localFirst = config.preferLocal && Boolean(host);

    // A command is a deliberate user action. When there is no cloud to fall
    // back on, the local call is the ONLY path: pay the timeout rather than
    // refusing a click because the poll loop parked the device.
    const runLocal = () => localCommand(shellyId, host, gen, command);
    const bypassCooldown = !cloudUsable;

    let localError;
    if (localFirst) {
      const attempt = await tryLocal(shellyId, host, runLocal, { bypassCooldown });
      if (attempt.ok) {
        return DEVICE_TRANSPORTS.LOCAL;
      }
      localError = attempt.error;
    }

    if (mqttHub && mqttHub.knows(shellyId) && gen !== 1) {
      try {
        await mqttHub.request(shellyId, command.rpc.method, command.rpc.params);
        return DEVICE_TRANSPORTS.LOCAL;
      } catch (mqttError) {
        logger.debug(`${shellyId}: MQTT command failed (${mqttError.message})`);
      }
    }

    if (cloudUsable) {
      try {
        await cloud.command(shellyId, command.cloud.path, command.cloud.body);
        return DEVICE_TRANSPORTS.CLOUD;
      } catch (cloudError) {
        throw localError || cloudError;
      }
    }

    if (!localFirst && host) {
      const attempt = await tryLocal(shellyId, host, runLocal, { bypassCooldown });
      if (attempt.ok) {
        return DEVICE_TRANSPORTS.LOCAL;
      }
      throw attempt.error;
    }

    throw localError || new Error(`${shellyId}: no usable transport to send the command`);
  }

  /**
   * Turn a relay channel on or off, over whichever transport works.
   * @param {object} target the device to reach
   * @param {number} channel relay channel index
   * @param {boolean} on desired state
   * @returns {Promise<string>} the transport that carried the command
   */
  function setSwitch(target, channel, on) {
    return sendCommand(
      target,
      buildCommand({ family: 'switch', index: channel, suffix: 'binary' }, on ? 1 : 0),
    );
  }

  /**
   * Call one Gen2+ RPC method over the local network: HTTP first, then the MQTT
   * broker.
   *
   * There is no cloud step on purpose: the Shelly Cloud control API only knows
   * relays and covers, so a `Number.Set` or a paginated `Shelly.GetComponents`
   * cannot be relayed through it. Failing with that reason beats pretending.
   *
   * @param {object} target the device to reach
   * @param {string} target.shellyId the Shelly device id
   * @param {string} [target.host] last known IP address or hostname
   * @param {string} method RPC method name
   * @param {object} [params] method parameters
   * @param {object} [options] behaviour options
   * @param {boolean} [options.command] a user action: probe even a parked device
   * @returns {Promise<{result: unknown, transport: string}>} the answer and its transport
   */
  async function callRpc({ shellyId, host }, method, params, { command = false } = {}) {
    const viaMqtt = Boolean(mqttHub && mqttHub.knows(shellyId));
    let localError;
    if (host) {
      // Same rule as `setSwitch`: a command with no other path pays the timeout
      // rather than being refused because the poll loop parked the device.
      const attempt = await tryLocal(
        shellyId,
        host,
        () => rpcFor(shellyId, host).call(method, params),
        { bypassCooldown: command && !viaMqtt },
      );
      if (attempt.ok) {
        return { result: attempt.result, transport: DEVICE_TRANSPORTS.LOCAL };
      }
      localError = attempt.error;
    }

    if (viaMqtt) {
      try {
        const result = await mqttHub.request(shellyId, method, params);
        return { result, transport: DEVICE_TRANSPORTS.LOCAL };
      } catch (mqttError) {
        logger.debug(`${shellyId}: MQTT ${method} failed (${mqttError.message})`);
        localError = localError || mqttError;
      }
    }

    throw (
      localError ||
      new Error(
        `${shellyId}: ${method} needs the local network or MQTT — the Shelly Cloud cannot relay it`,
      )
    );
  }

  /**
   * Read the circuit-breaker state of a device, for the diagnostic.
   * @param {string} shellyId the Shelly device id
   * @returns {object|undefined} the breaker entry
   */
  function localHealth(shellyId) {
    const entry = circuit.get(shellyId);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Remember the virtual-component metadata read by a discovery.
   * @param {string} shellyId the Shelly device id
   * @param {Record<string, object>} components metadata per component key
   */
  function rememberComponents(shellyId, components) {
    componentsCache.set(shellyId, components);
    componentsFailedAt.delete(shellyId);
  }

  /**
   * The virtual-component metadata already known for a device, without any I/O
   * (the push path is synchronous and must never wait on the network).
   * @param {string} shellyId the Shelly device id
   * @returns {Record<string, object>|undefined} metadata per component key
   */
  function cachedComponents(shellyId) {
    return componentsCache.get(shellyId);
  }

  /**
   * The virtual-component metadata of a device, read once if not known yet
   * (typically after a container restart, before any re-scan).
   *
   * Never throws: without metadata a device keeps its features and values, so
   * a failure costs presentation details, not the device. A failure is
   * remembered for a while so a device that cannot answer is not asked again
   * on every cycle.
   *
   * @param {object} target the device to reach
   * @returns {Promise<Record<string, object>|undefined>} metadata per component key
   */
  async function componentsFor(target) {
    const cached = componentsCache.get(target.shellyId);
    if (cached) {
      return cached;
    }
    const failedAt = componentsFailedAt.get(target.shellyId);
    if (failedAt !== undefined && now() - failedAt < COMPONENTS_RETRY_MS) {
      return undefined;
    }
    try {
      const components = await fetchVirtualComponents(
        async (method, params) => (await callRpc(target, method, params)).result,
      );
      rememberComponents(target.shellyId, components);
      return components;
    } catch (err) {
      componentsFailedAt.set(target.shellyId, now());
      logger.debug(`${target.shellyId}: Shelly.GetComponents failed (${err.message})`);
      return undefined;
    }
  }

  /**
   * Write a virtual component (`Number.Set`, `Boolean.Set`).
   *
   * Addressed by `id`, which every virtual component has; the `owner` + `role`
   * addressing of the HVAC documentation only works for components that carry
   * a role.
   *
   * @param {object} target the device to reach
   * @param {string} family `number` or `boolean`
   * @param {number} id component index
   * @param {number|boolean} value value to write
   * @returns {Promise<string>} the transport that carried the command
   */
  async function setVirtual(target, family, id, value) {
    const method = VIRTUAL_SET_METHOD[family];
    if (!method) {
      throw new Error(`${target.shellyId}: ${family}:${id} cannot be written`);
    }
    const { transport } = await callRpc(target, method, { id, value }, { command: true });
    return transport;
  }

  return {
    getStatus,
    sendCommand,
    setSwitch,
    localHealth,
    setVirtual,
    componentsFor,
    cachedComponents,
    rememberComponents,
    reset,
    rpcFor,
  };
}
