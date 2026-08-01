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
//     5 s by default. It carries every instantaneous POWER value and every
//     on/off state: what a human feels (a relay flipping on the wall) and what
//     a control scene reacts to (total and per-phase power steering a battery
//     or shedding a load);
//   - everything else (voltages, currents, apparent power, energy counters,
//     temperatures) rides the normal refresh interval, but is served from the
//     freshest pushed value instead of an HTTP round trip.
//
// The lane is not sized by a fixed feature list, because the same list costs
// nothing on one Pro 3EM and blows the budget on ten. It MEASURES what it
// publishes and stretches its own interval when the fleet is big enough to
// need it (see `effectiveRealtimeSeconds`), which is the only way a value that
// never changes can be free while a value that always changes is not.
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
import { buildTargets, discoverDevices, publishDiscovered } from './discovery.js';
import { createMqttHub } from './mqttHub.js';
import { createWsHub } from './wsHub.js';

/** Maximum number of states accepted by one POST /state (host API limit). */
const STATE_BATCH_SIZE = 100;

/**
 * The host API rate-limits states at 300 per minute per integration. The
 * real-time lane spends that budget on the values a human watches and a scene
 * reacts to — `realtime: true` in features.js (total and per-phase active
 * power, per-relay power) plus the controllable states. Everything else
 * (voltages, currents, energy counters, temperatures) rides the normal refresh
 * interval.
 *
 * Only real CHANGES are published, so the cost of the lane is the number of
 * values that actually move, not the number declared — which is why the
 * cadence is derived from the measured rate rather than from the feature
 * count. See `REALTIME_SAFE_RATE`.
 */
const STATE_RATE_LIMIT_PER_MINUTE = 300;

/** Warn once per minute when the real-time lane gets close to the cap. */
const RATE_WARNING_THRESHOLD = 0.8;

/**
 * States per minute the real-time lane is allowed to reach before it slows
 * itself down, out of the 300/minute the host API accepts. The margin below the
 * cap is what the refresh cycle spends on everything the lane does not carry.
 *
 * This exists because the lane is sized by the fleet, not by the configuration:
 * one Pro 3EM feeds 4 fast values, ten feed 40, and the interval that is right
 * for the first is wrong for the second. Rather than ask the user to work that
 * out, the lane MEASURES what it actually publishes and stretches its own
 * interval when the budget gets tight — a value that never changes costs
 * nothing, so the real cost cannot be derived from the device count alone.
 */
const REALTIME_SAFE_RATE = 240;

/**
 * Rate the lane must fall back UNDER before it speeds up again.
 *
 * The gap with `REALTIME_SAFE_RATE` is deliberate. Slowing down lowers the rate
 * just below the threshold, which — with a single threshold — immediately reads
 * as "there is room again", and the lane flips back and forth every few
 * seconds. The bench showed exactly that: 5 s, 6 s, 5 s, 6 s, four times a
 * minute. A decision only holds if the measurement has room to settle on the
 * other side of it.
 */
const REALTIME_RELAX_RATE = 200;

/**
 * Minimum time between two cadence changes, in ms.
 *
 * The rate is measured over a ROLLING MINUTE, so a change made now is only
 * fully reflected in the measurement a minute later. Deciding faster than that
 * means deciding on a number that still describes the previous cadence.
 */
const REALTIME_ADJUST_DWELL_MS = 60000;

/** Longest the lane will stretch itself to, in seconds, however big the fleet. */
const MAX_REALTIME_SECONDS = 60;

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
  /** Real-time states published since the last summary, and when it was logged. */
  let realtimePublished = 0;
  let lastRealtimeSummaryAt = 0;
  /** Cadence the lane is running at, and when it last changed. */
  let currentRealtimeSeconds = null;
  let lastCadenceChangeAt = 0;
  /** When the host API last answered "Too Many Requests", the one authoritative signal. */
  let rateLimitedAt = 0;

  let timer = null;
  let fastFlushTimer = null;
  let running = false;
  /** The discovery currently in flight, so two callers share one scan. */
  let discoveryInFlight = null;

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

  /**
   * Devices whose FULL status we have obtained over MQTT.
   *
   * Publishing on MQTT is not the same as being readable over MQTT, and the
   * difference decides whether this device can stop being polled. Pushed frames
   * are PARTIAL — they carry what moved — so a device served from them alone
   * never reports a value that does not change: an idle relay's power, a
   * voltage that holds steady. Those features would sit on "no recent value"
   * forever while their neighbours update, which is precisely what the bench
   * saw.
   *
   * So a device only counts as live once it has answered `Shelly.GetStatus`
   * over the broker, exactly like the WebSocket handshake. A device that
   * publishes but has "MQTT Control" disabled keeps being polled over HTTP,
   * which is the correct outcome rather than a silently starved one.
   */
  const mqttSeeded = new Set();

  // MQTT feeds the SAME buffer as the WebSocket: `<prefix>/events/rpc` carries
  // identical `NotifyStatus` frames, and the Gen1 dialect is normalized into
  // the same component shape before it gets here. One push path, three sources.
  const mqttHub = createMqttHub({
    getConfig,
    onStatus: (shellyId, status) => bufferPushedStatus(shellyId, status),
    onDeviceSeen: (shellyId) => {
      // The MQTT equivalent of the WebSocket handshake: one full snapshot, so
      // every feature has a value before we rely on partial frames.
      mqttHub
        .request(shellyId, 'Shelly.GetStatus')
        .then((status) => {
          if (!status) {
            return;
          }
          mqttSeeded.add(shellyId);
          bufferPushedStatus(shellyId, status);
          logger.info(`${shellyId}: full status read over MQTT — real-time updates flowing`);
        })
        .catch((err) => {
          logger.info(
            `${shellyId}: publishes on MQTT but did not answer a full status read ` +
              `(${err.message}) — it stays on the polling path. Tick "Enable MQTT Control" ` +
              'on the device to serve it from the broker.',
          );
        });
    },
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
   * How many states were published in the last minute, across both lanes.
   * @param {number} timestamp current time
   * @returns {number} the rolling one-minute count
   */
  function currentPublishRate(timestamp) {
    const windowStart = timestamp - 60000;
    return publishTimestamps.filter((at) => at > windowStart).length;
  }

  /**
   * The cadence the real-time lane runs at.
   *
   * The configured interval is a FLOOR, not a promise: it is what the lane runs
   * at whenever the budget allows, and it does on any ordinary installation. On
   * a fleet large enough to spend more than `REALTIME_SAFE_RATE` states a
   * minute, the lane stretches itself. Losing states to the host API would be
   * worse than a slower lane: a dropped state is invisible, a slower one is
   * merely slower, and it is announced.
   *
   * Three rules keep this a controller rather than a coin flip:
   *   - it reacts to overload IN PROPORTION (publishing half as often costs
   *     half as much, so a big fleet reaches its cadence in one or two steps
   *     instead of crawling there a second at a time);
   *   - it speeds back up ONE SECOND AT A TIME, and only once the rate has
   *     fallen well under the threshold (`REALTIME_RELAX_RATE`);
   *   - it holds any decision for a full measurement window, because the rate
   *     it reads is a rolling minute and a fresher number would still describe
   *     the previous cadence.
   * A "Too Many Requests" from the host bypasses the dwell: that is not our
   * estimate of the budget, it is the budget itself talking.
   *
   * @returns {number} the interval in seconds, or 0 when the lane is disabled
   */
  function effectiveRealtimeSeconds() {
    const { realtimeSeconds } = getConfig();
    if (!realtimeSeconds) {
      currentRealtimeSeconds = null;
      return 0;
    }
    const timestamp = now();
    // First call, or the user just changed the setting: honour it as-is. A
    // configured value ABOVE the current one is never overridden — the user
    // asking for a slower lane is not something to regulate around.
    if (currentRealtimeSeconds === null || currentRealtimeSeconds < realtimeSeconds) {
      currentRealtimeSeconds = realtimeSeconds;
      lastCadenceChangeAt = timestamp;
      return currentRealtimeSeconds;
    }

    const rate = currentPublishRate(timestamp);
    const refused = rateLimitedAt > lastCadenceChangeAt;
    if (!refused && timestamp - lastCadenceChangeAt < REALTIME_ADJUST_DWELL_MS) {
      return currentRealtimeSeconds;
    }

    let next = currentRealtimeSeconds;
    if (refused || rate > REALTIME_SAFE_RATE) {
      // `rate` can sit below the threshold and still have been refused (a burst
      // inside the window), so a proportional step needs a floor of one second.
      const scaled = Math.ceil(currentRealtimeSeconds * (rate / REALTIME_SAFE_RATE));
      next = Math.min(Math.max(scaled, currentRealtimeSeconds + 1), MAX_REALTIME_SECONDS);
    } else if (rate < REALTIME_RELAX_RATE) {
      next = Math.max(currentRealtimeSeconds - 1, realtimeSeconds);
    }
    if (next === currentRealtimeSeconds) {
      return currentRealtimeSeconds;
    }

    if (next > currentRealtimeSeconds) {
      logger.info(
        `Real-time lane slowed to ${next}s (you asked for ${realtimeSeconds}s): ` +
          `${refused ? 'Gladys refused states' : `the fleet is publishing ${rate} states/min`}, ` +
          `and the limit is ${STATE_RATE_LIMIT_PER_MINUTE}/min. It speeds back up on its own; ` +
          'create fewer devices, or raise the refresh interval, to stay at ' +
          `${realtimeSeconds}s.`,
      );
    } else {
      logger.info(`Real-time lane back to ${next}s (${rate} states/min, there is room again)`);
    }
    currentRealtimeSeconds = next;
    lastCadenceChangeAt = timestamp;
    return currentRealtimeSeconds;
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
        if (/too many requests|rate limit|429/i.test(err.message || '')) {
          // The host just told us the budget is spent. That beats any estimate
          // we could make, so it slows the lane down without waiting for the
          // dwell — and it is not the same event as "we are getting close".
          rateLimitedAt = timestamp;
          logger.warn(
            `Gladys refused ${batch.length} state(s): over the ` +
              `${STATE_RATE_LIMIT_PER_MINUTE}/min limit. They are retried on the next cycle, ` +
              'and the real-time lane slows down.',
          );
        } else {
          logger.warn(`Publishing ${batch.length} state(s) failed: ${err.message}`);
        }
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
    const published = await publishStates(states, timestamp);
    realtimePublished += published;

    // Once a minute, at INFO. "Are my values really refreshing every 5 s?" is
    // not a question a user should have to answer by staring at a dashboard,
    // and a debug-level line is invisible where it matters.
    if (lastRealtimeSummaryAt === 0) {
      lastRealtimeSummaryAt = timestamp;
    } else if (timestamp - lastRealtimeSummaryAt >= 60000) {
      const realtimeSeconds = effectiveRealtimeSeconds();
      logger.info(
        `Real-time lane: ${realtimePublished} state(s) published in the last minute ` +
          `(every ${realtimeSeconds}s, from ${wsHub.liveCount()} WebSocket and ` +
          `${mqttSeeded.size} MQTT device(s)); ${currentPublishRate(timestamp)}/` +
          `${STATE_RATE_LIMIT_PER_MINUTE} states/min of the Gladys budget used`,
      );
      realtimePublished = 0;
      lastRealtimeSummaryAt = timestamp;
    }
  }

  /** Arm the debounce that flushes the real-time lane at the current cadence. */
  function scheduleFastFlush() {
    if (fastFlushTimer) {
      return;
    }
    const realtimeSeconds = effectiveRealtimeSeconds();
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
    const isLive = wsHub.isLive(target.shellyId) || mqttSeeded.has(target.shellyId);

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
    // Two scans at once make the core reject the second mDNS browse with a
    // `Conflict`, which the bench hit by saving the configuration while a manual
    // scan was running. The second caller waits for the first instead: it wants
    // the result, not its own browse.
    if (discoveryInFlight) {
      logger.info('A discovery is already running — waiting for it instead of starting a second');
      return discoveryInFlight;
    }
    discoveryInFlight = runDiscovery().finally(() => {
      discoveryInFlight = null;
    });
    return discoveryInFlight;
  }

  /**
   * Run ONE discovery and publish the result.
   * @returns {Promise<object[]>} the discovered devices
   */
  async function runDiscovery() {
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
    const createdExternalIds = new Set(
      (knownDevices || []).map((device) => device.external_id).filter(Boolean),
    );
    const publish = (list) => publishDiscovered({ gladys, devices: list, createdExternalIds });

    const devices = await discoverDevices({
      gladys,
      client,
      config,
      knownDevices,
      fetchImpl,
      mqttHub,
      onProgress: publish,
    });
    await publish(devices);
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
    mqttSeeded.clear();
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
    effectiveRealtimeSeconds,
  };
}
