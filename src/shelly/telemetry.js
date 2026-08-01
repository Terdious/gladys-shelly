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
// Real-time push (issue #2) is layered ON TOP of the poll loop rather than
// replacing it, because a Pro 3EM pushes `NotifyStatus` about once a SECOND
// across ~16 instantaneous measurements: forwarding that verbatim would be
// ~900 states/minute against a 300/minute cap. So pushed values are COALESCED
// per device and split into two lanes:
//   - the REAL-TIME lane (`realtime: true` in features.js, plus the
//     controllable states) flushes at the configured `realtime_interval`,
//     5 s by default. It carries what a human feels (a relay flipping on the
//     wall) and what a control scene reacts to (total active power steering a
//     battery, per-relay power). It is deliberately NARROW: at 5 s there are
//     12 windows per minute, so the whole integration can afford roughly 25
//     real-time features before it starts losing states to the rate limit;
//   - everything else (per-phase detail, voltages, currents, energy counters,
//     temperatures) rides the normal refresh interval, but is served from the
//     freshest pushed value instead of an HTTP round trip.
// `recordPublishRate` watches that budget and warns before states start being
// dropped, because silent loss would be indistinguishable from a bug.
//
// A live device is still polled occasionally as a safety net, so a missed
// reconnection or a silently dropped socket cannot freeze its values forever.
//
// The loop is deliberately forgiving: one device failing is a badge, not an
// outage.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, logger } from '@gladysassistant/integration-sdk';

import { mapWithConcurrency } from './async.js';
import { DEVICE_TYPE, POLL_CONCURRENCY, STATE_KEEP_ALIVE_MS } from './constants.js';
import { buildStates } from './deviceMapping.js';
import { buildFeatureSpecs } from './features.js';
import { buildTargets, discoverDevices } from './discovery.js';
import { createMqttHub } from './mqttHub.js';
import { createWsHub } from './wsHub.js';

/** Maximum number of states accepted by one POST /state (host API limit). */
const STATE_BATCH_SIZE = 100;

/**
 * The host API rate-limits states at 300 per minute per integration. The
 * real-time lane spends that budget deliberately, so it is kept to the handful
 * of values a control scene actually reacts to — `realtime: true` in
 * features.js (total active power, per-relay power) plus the controllable
 * states. Everything else (per-phase detail, energy counters, temperatures)
 * rides the normal refresh interval.
 *
 * Budget arithmetic, worth keeping in mind before widening the lane: at a 5 s
 * cadence there are 12 windows per minute, so the whole integration can afford
 * about 25 real-time features before it starts losing states to the limit.
 */
const STATE_RATE_LIMIT_PER_MINUTE = 300;

/** Warn once per minute when the real-time lane gets close to the cap. */
const RATE_WARNING_THRESHOLD = 0.8;

/** How often a live (pushing) device is still polled, as a safety net, in ms. */
const LIVE_SAFETY_NET_MS = 5 * 60 * 1000;

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
 * @param {object} [options.WebSocketImpl] WebSocket implementation (tests)
 * @returns {object} the telemetry engine
 */
export function createTelemetry({
  gladys,
  client,
  getConfig,
  fetchImpl = fetch,
  now = Date.now,
  WebSocketImpl,
  mqttImpl,
}) {
  /** Last published value per feature external id, with its publication time. */
  const lastPublished = new Map();
  /** Last published transport entry per device external id, to avoid re-publishing noise. */
  const lastTransports = new Map();
  /** Last successful poll per device, so a live device is still checked periodically. */
  const lastPolledAt = new Map();
  /** Freshest pushed value per device: Map<shellyId, Map<featureExternalId, {state, fast}>>. */
  const pushBuffer = new Map();
  /** Timestamps of the states published in the last minute, for the budget guard. */
  let publishTimestamps = [];
  let lastRateWarningAt = 0;

  let timer = null;
  let fastFlushTimer = null;
  let running = false;

  const wsHub = createWsHub({
    getConfig,
    onStatus: (shellyId, status) => bufferPushedStatus(shellyId, status),
    onConnectionChange: (shellyId, connected) => {
      if (!connected) {
        // Values buffered behind a socket that just died are stale by
        // definition: the reconnection (or the safety-net poll) re-reads them.
        pushBuffer.delete(shellyId);
      }
    },
    ...(WebSocketImpl ? { WebSocketImpl } : {}),
  });

  // MQTT feeds the SAME buffer as the WebSocket: `<prefix>/events/rpc` carries
  // identical `NotifyStatus` frames, and the Gen1 dialect is normalized into
  // the same component shape before it gets here. One push path, three sources.
  const mqttHub = createMqttHub({
    getConfig,
    onStatus: (shellyId, status) => bufferPushedStatus(shellyId, status),
    ...(mqttImpl ? { mqttImpl } : {}),
  });

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
   * Record a status document pushed over the WebSocket.
   *
   * The document is PARTIAL (only what changed), which the component-keyed
   * mapper handles natively — that is exactly why the push path needs no
   * mapping code of its own.
   *
   * @param {string} shellyId the Shelly device id
   * @param {object} status the pushed status document
   */
  function bufferPushedStatus(shellyId, status) {
    const externalIds = gladys.externalIds(DEVICE_TYPE, shellyId);
    const buffered = pushBuffer.get(shellyId) || new Map();

    buildFeatureSpecs(status).forEach((spec) => {
      const componentStatus = status[spec.componentKey];
      const value = componentStatus == null ? undefined : spec.read(componentStatus);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
      }
      buffered.set(externalIds.feature(spec.key), {
        state: value,
        // Two kinds of value earn the real-time lane: the ones whose latency a
        // human feels (a relay flipping on the wall) and the ones a control
        // scene reacts to (total power steering a battery). Everything else
        // would spend the rate-limit budget for nothing.
        fast: spec.realtime === true || spec.read_only === false,
      });
    });

    if (buffered.size > 0) {
      pushBuffer.set(shellyId, buffered);
      scheduleFastFlush();
    }
  }

  /**
   * Track how much of the 300-states-per-minute budget is being spent, and warn
   * when the real-time lane is about to cost the user actual dropped states.
   * Silence here would be the worst outcome: states would start disappearing
   * with nothing in the logs to explain why.
   * @param {number} count states just published
   * @param {number} timestamp current time
   */
  function recordPublishRate(count, timestamp) {
    const windowStart = timestamp - 60000;
    publishTimestamps = publishTimestamps.filter((at) => at > windowStart);
    for (let index = 0; index < count; index += 1) {
      publishTimestamps.push(timestamp);
    }
    if (
      publishTimestamps.length >= STATE_RATE_LIMIT_PER_MINUTE * RATE_WARNING_THRESHOLD &&
      timestamp - lastRateWarningAt >= 60000
    ) {
      lastRateWarningAt = timestamp;
      const { realtimeSeconds } = getConfig();
      logger.warn(
        `${publishTimestamps.length} states published in the last minute, close to the ` +
          `${STATE_RATE_LIMIT_PER_MINUTE}/min host API limit — raise the real-time interval ` +
          `(currently ${realtimeSeconds}s) or the refresh interval, or create fewer devices`,
      );
    }
  }

  /**
   * Publish a batch of states, remembering only what actually went through.
   * @param {Array<{device_feature_external_id: string, state: number}>} states states to publish
   * @param {number} timestamp current time
   * @returns {Promise<number>} the number of states published
   */
  async function publishStates(states, timestamp) {
    let published = 0;
    for (const batch of chunk(states, STATE_BATCH_SIZE)) {
      try {
        await gladys.publishStates(batch);
        published += batch.length;
        recordPublishRate(batch.length, timestamp);
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
    return published;
  }

  /** Flush the controllable states buffered from the push channel. */
  async function flushFast() {
    fastFlushTimer = null;
    const timestamp = now();
    const states = [];

    pushBuffer.forEach((buffered, shellyId) => {
      buffered.forEach((entry, featureExternalId) => {
        if (!entry.fast) {
          return;
        }
        // Taken out of the buffer whether or not it is published: an unchanged
        // value has nothing left to say, and the slow path would re-send it.
        buffered.delete(featureExternalId);
        if (shouldPublish(featureExternalId, entry.state, timestamp)) {
          states.push({ device_feature_external_id: featureExternalId, state: entry.state });
        }
      });
      if (buffered.size === 0) {
        pushBuffer.delete(shellyId);
      }
    });

    if (states.length === 0) {
      return;
    }
    await publishStates(states, timestamp);
    logger.debug(`Real-time push: ${states.length} state(s) published`);
  }

  /** Arm the debounce that flushes the real-time lane at the configured cadence. */
  function scheduleFastFlush() {
    if (fastFlushTimer) {
      return;
    }
    const { realtimeSeconds } = getConfig();
    if (!realtimeSeconds) {
      // Lane disabled: those values ride the normal refresh cycle like the rest.
      return;
    }
    fastFlushTimer = setTimeout(() => {
      flushFast().catch((err) => logger.warn(`Real-time flush failed: ${err.message}`));
    }, realtimeSeconds * 1000);
    if (typeof fastFlushTimer.unref === 'function') {
      fastFlushTimer.unref();
    }
  }

  /**
   * Drain everything still buffered for one device (the measurements the fast
   * flush deliberately left behind).
   * @param {string} shellyId the Shelly device id
   * @returns {Array<{device_feature_external_id: string, state: number}>} the states
   */
  function drainBuffer(shellyId) {
    const buffered = pushBuffer.get(shellyId);
    if (!buffered) {
      return [];
    }
    pushBuffer.delete(shellyId);
    return [...buffered.entries()].map(([featureExternalId, entry]) => ({
      device_feature_external_id: featureExternalId,
      state: entry.state,
    }));
  }

  /**
   * Read ONE device: from its push buffer when it is live, over HTTP otherwise.
   * @param {object} target the device to read
   * @param {number} timestamp current time
   * @returns {Promise<object>} the states and the transport entry
   */
  async function readDevice(target, timestamp) {
    const external_id = target.device.external_id;
    const lastPoll = lastPolledAt.get(target.shellyId) || 0;
    // Live over EITHER push channel. A Gen1 device has no WebSocket at all, so
    // MQTT is the only way it can ever be live — and a Gen2 device the local
    // network cannot reach may still be pushing to the broker.
    const isLive = wsHub.isLive(target.shellyId) || mqttHub.knows(target.shellyId);

    // A live device is served from its buffer, EXCEPT once every safety-net
    // interval: a socket can stay open and silent (device wedged, firmware
    // bug), and only a real read can tell that apart from "nothing changed".
    if (isLive && timestamp - lastPoll < LIVE_SAFETY_NET_MS) {
      return {
        target,
        states: drainBuffer(target.shellyId),
        transport: { external_id, transport: DEVICE_TRANSPORTS.LOCAL },
      };
    }

    try {
      const { status, transport, degraded, message } = await client.getStatus(target);
      lastPolledAt.set(target.shellyId, timestamp);
      return {
        target,
        states: buildStates({
          status,
          externalIds: gladys.externalIds(DEVICE_TYPE, target.shellyId),
        }),
        transport: {
          external_id,
          transport,
          ...(degraded ? { degraded: true, message } : {}),
        },
      };
    } catch (err) {
      logger.warn(`${target.shellyId} unreachable: ${err.message}`);
      return {
        target,
        states: [],
        transport: { external_id, transport: DEVICE_TRANSPORTS.UNREACHABLE },
      };
    }
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
    // Keep the real-time connections in step with the devices that exist right
    // now — the same list drives both channels, so there is no second
    // inventory to drift.
    wsHub.sync(targets);

    if (targets.length === 0) {
      return { devices: 0, reachable: 0, states: 0 };
    }

    const timestamp = now();
    const results = await mapWithConcurrency(targets, POLL_CONCURRENCY, (target) =>
      readDevice(target, timestamp),
    );

    const usable = results.filter(Boolean);
    const reachable = usable.filter(
      (result) => result.transport.transport !== DEVICE_TRANSPORTS.UNREACHABLE,
    ).length;

    const states = usable
      .flatMap((result) => result.states)
      .filter((state) => shouldPublish(state.device_feature_external_id, state.state, timestamp));

    const published = await publishStates(states, timestamp);
    await publishTransports(usable.map((result) => result.transport));

    logger.debug(
      `Refresh: ${reachable}/${targets.length} device(s) reachable ` +
        `(${wsHub.liveCount()} pushing in real time), ${published} state(s) published`,
    );
    return { devices: targets.length, reachable, states: published };
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

    // A full scan runs two mDNS browse rounds and takes ~25 s. Publishing only
    // at the end leaves the Discovery page empty for that whole time, which
    // reads as "nothing found": publish after each round instead, so the list
    // fills up as devices are identified.
    const devices = await discoverDevices({
      gladys,
      client,
      config,
      knownDevices,
      fetchImpl,
      mqttHub,
      onProgress: (partial) => gladys.publishDiscoveredDevices(partial),
    });
    await gladys.publishDiscoveredDevices(devices);
    return devices;
  }

  /** Run one cycle, swallowing its errors: the loop must survive a bad cycle. */
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
    const { refreshSeconds, realtimeSeconds } = getConfig();
    logger.info(
      `Telemetry started — refreshing every ${refreshSeconds}s, real-time lane ` +
        (realtimeSeconds ? `every ${realtimeSeconds}s` : 'disabled'),
    );
    mqttHub.start();
    // Run one cycle immediately so the user does not wait a full interval
    // after a restart or a configuration change.
    safeCycle();
    timer = setInterval(safeCycle, refreshSeconds * 1000);
    // Do not hold the event loop open just for the poll timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  /** Stop the refresh loop and every real-time connection. */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (fastFlushTimer) {
      clearTimeout(fastFlushTimer);
      fastFlushTimer = null;
    }
    wsHub.stop();
    mqttHub.stop();
    pushBuffer.clear();
  }

  return {
    start,
    stop,
    refreshValues,
    syncDiscovery,
    resetDedup,
    // Exposed for the tests and the e2e wiring.
    wsHub,
    mqttHub,
    flushFast,
  };
}
