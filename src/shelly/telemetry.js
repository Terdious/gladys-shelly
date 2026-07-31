// -----------------------------------------------------------------------------
// Telemetry: the loop that reads every device and publishes what changed.
//
// Two budgets shape this file:
//   - the host API rate-limits states at 300 per minute per integration, and a
//     single Pro 3EM carries ~25 features. Publishing full snapshots every
//     30 s would blow the budget with three meters, so states are DEDUPLICATED
//     and only real changes go out — with a keep-alive so a value that never
//     moves still refreshes periodically instead of looking dead;
//   - `publishStates` accepts at most 100 states per request, so batches are
//     chunked.
//
// The loop is deliberately forgiving: one device failing is a badge, not an
// outage. Only a total failure to reach anything is worth a connection-status
// change.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, logger } from '@gladysassistant/integration-sdk';

import { mapWithConcurrency } from './async.js';
import { DEVICE_TYPE, POLL_CONCURRENCY, STATE_KEEP_ALIVE_MS } from './constants.js';
import { buildStates } from './deviceMapping.js';
import { buildTargets, discoverDevices } from './discovery.js';

/** Maximum number of states accepted by one POST /state (host API limit). */
const STATE_BATCH_SIZE = 100;

/**
 * Split an array into chunks of at most `size` items.
 * @template T
 * @param {T[]} items items to chunk
 * @param {number} size maximum chunk size
 * @returns {T[][]} the chunks
 */
function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Create the telemetry engine.
 * @param {object} options engine options
 * @param {object} options.gladys the SDK instance
 * @param {object} options.client the transport router
 * @param {() => object} options.getConfig accessor to the current normalized config
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @param {() => number} [options.now] clock (tests)
 * @returns {object} the telemetry engine
 */
export function createTelemetry({ gladys, client, getConfig, fetchImpl = fetch, now = Date.now }) {
  /** Last published value per feature external id, with its publication time. */
  const lastPublished = new Map();
  /** Last published transport entry per device external id, to avoid re-publishing noise. */
  const lastTransports = new Map();

  let timer = null;
  let running = false;

  /**
   * Whether a state is worth sending: it changed, or its keep-alive expired.
   * @param {string} externalId feature external id
   * @param {number} value candidate value
   * @param {number} timestamp current time
   * @returns {boolean} true when the state must be published
   */
  function shouldPublish(externalId, value, timestamp) {
    const previous = lastPublished.get(externalId);
    if (!previous) {
      return true;
    }
    if (previous.value !== value) {
      return true;
    }
    return timestamp - previous.at >= STATE_KEEP_ALIVE_MS;
  }

  /** Forget the dedup memory so the next cycle republishes everything. */
  function resetDedup() {
    lastPublished.clear();
    lastTransports.clear();
  }

  /**
   * Publish the transports that actually changed.
   * Defensive: a core without the transport endpoint must not break telemetry.
   * @param {Array<object>} entries transport entries
   */
  async function publishTransports(entries) {
    const changed = entries.filter((entry) => {
      const signature = `${entry.transport}|${entry.degraded ? 1 : 0}`;
      if (lastTransports.get(entry.external_id) === signature) {
        return false;
      }
      lastTransports.set(entry.external_id, signature);
      return true;
    });
    if (changed.length === 0) {
      return;
    }
    try {
      await gladys.publishTransports(changed);
    } catch (err) {
      logger.debug(`publishTransports skipped (older Gladys core?): ${err.message}`);
    }
  }

  /**
   * Run ONE refresh cycle over every device the user created.
   * @returns {Promise<{devices: number, reachable: number, states: number}>} cycle metrics
   */
  async function refreshValues() {
    let devices;
    try {
      devices = await gladys.getDevices();
    } catch (err) {
      logger.warn(`Could not list the Gladys devices: ${err.message}`);
      return { devices: 0, reachable: 0, states: 0 };
    }

    const targets = buildTargets(devices);
    if (targets.length === 0) {
      return { devices: 0, reachable: 0, states: 0 };
    }

    const timestamp = now();
    const results = await mapWithConcurrency(targets, POLL_CONCURRENCY, async (target) => {
      try {
        const { status, transport, degraded, message } = await client.getStatus(target);
        return {
          target,
          states: buildStates({
            status,
            externalIds: gladys.externalIds(DEVICE_TYPE, target.shellyId),
          }),
          transport: {
            external_id: target.device.external_id,
            transport,
            ...(degraded ? { degraded: true, message } : {}),
          },
        };
      } catch (err) {
        logger.warn(`${target.shellyId} unreachable: ${err.message}`);
        return {
          target,
          states: [],
          transport: {
            external_id: target.device.external_id,
            transport: DEVICE_TRANSPORTS.UNREACHABLE,
          },
        };
      }
    });

    const usable = results.filter(Boolean);
    const reachable = usable.filter(
      (result) => result.transport.transport !== DEVICE_TRANSPORTS.UNREACHABLE,
    ).length;

    const states = usable
      .flatMap((result) => result.states)
      .filter((state) => shouldPublish(state.device_feature_external_id, state.state, timestamp));

    for (const batch of chunk(states, STATE_BATCH_SIZE)) {
      try {
        await gladys.publishStates(batch);
        batch.forEach((state) => {
          lastPublished.set(state.device_feature_external_id, {
            value: state.state,
            at: timestamp,
          });
        });
      } catch (err) {
        // Do NOT record these as published: the next cycle must retry them.
        logger.warn(`Publishing ${batch.length} state(s) failed: ${err.message}`);
      }
    }

    await publishTransports(usable.map((result) => result.transport));

    logger.debug(
      `Refresh: ${reachable}/${targets.length} device(s) reachable, ${states.length} state(s) published`,
    );
    return { devices: targets.length, reachable, states: states.length };
  }

  /**
   * Run a discovery and publish the result.
   * @returns {Promise<object[]>} the discovered devices
   */
  async function syncDiscovery() {
    const config = getConfig();
    let knownDevices = [];
    try {
      knownDevices = await gladys.getDevices();
    } catch (err) {
      logger.debug(`Could not list the known devices before the scan: ${err.message}`);
    }

    const devices = await discoverDevices({
      gladys,
      client,
      config,
      knownDevices,
      fetchImpl,
    });
    await gladys.publishDiscoveredDevices(devices);
    return devices;
  }

  /**
   * Run one cycle, swallowing its errors: the loop must survive a bad cycle.
   */
  async function safeCycle() {
    if (running) {
      // The previous cycle is still going (a slow or timing-out fleet): skip
      // this tick instead of stacking overlapping cycles.
      logger.debug('Previous refresh still running — skipping this tick');
      return;
    }
    running = true;
    try {
      await refreshValues();
    } catch (err) {
      logger.error(`Refresh cycle failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  /** Start (or restart) the refresh loop at the configured cadence. */
  function start() {
    stop();
    const { refreshSeconds } = getConfig();
    logger.info(`Telemetry started — refreshing every ${refreshSeconds}s`);
    // Run one cycle immediately so the user does not wait a full interval
    // after a restart or a configuration change.
    safeCycle();
    timer = setInterval(safeCycle, refreshSeconds * 1000);
    // Do not hold the event loop open just for the poll timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /** Stop the refresh loop. */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, refreshValues, syncDiscovery, resetDedup };
}
