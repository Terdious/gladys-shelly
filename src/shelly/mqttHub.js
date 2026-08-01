// -----------------------------------------------------------------------------
// MQTT: a third transport, and the only reliable INVENTORY of a large fleet.
//
// mDNS is a short multicast window. On a real installation the same fleet came
// back as 19, then 23, then 27 records, with several devices systematically
// absent — so devices that exist, work, and answer HTTP perfectly were simply
// never discoverable. Every one of them was already publishing to the user's
// broker.
//
// A device that publishes announces itself CONTINUOUSLY, with no window to
// miss, so MQTT is used for three things at once:
//   1. discovery   — the `src` of any frame names a device we may not know;
//   2. telemetry   — `<prefix>/events/rpc` carries the SAME JSON-RPC
//                    `NotifyStatus` frames as the WebSocket, so the existing
//                    mapper consumes them unchanged;
//   3. control     — `<prefix>/rpc` accepts requests when the device has
//                    "MQTT Control" enabled, so a device unreachable locally is
//                    still commandable without going through the cloud.
//
// Two protocol facts shape this file:
//
//   - the topic prefix is CONFIGURABLE per device (it defaults to the device
//     id, but the Shelly UI lets it be anything). Subscribing to a computed
//     `<id>/events/rpc` would therefore miss renamed prefixes, so we subscribe
//     to the wildcard `+/events/rpc` and take the identity from the `src` field
//     of the payload — which is authoritative;
//   - Gen1 speaks a completely different MQTT dialect: no JSON-RPC at all, but
//     one scalar value per topic under `shellies/<id>/...`. That is handled in
//     `parseGen1Topic` and folded into the same component-keyed shape.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import mqtt from 'mqtt';

import { COMPONENT } from './constants.js';

/** Our own `src`, and therefore the topic devices send their RPC replies to. */
const RPC_SRC = 'gladys-shelly';

/** How long an RPC request over MQTT waits for its reply, in ms. */
const RPC_TIMEOUT_MS = 10000;

/**
 * Gen2+ push topics: `<prefix>/events/rpc`, where the prefix is user-defined.
 *
 * `+` matches exactly ONE level, and MQTT has no wildcard for "any number of
 * levels followed by a fixed suffix" — `#` is only valid as a trailing
 * wildcard. A prefix containing slashes (`maison/cuisine/lave-vaisselle`) is
 * therefore missed by `+/events/rpc` alone.
 *
 * Subscribing to `#` would catch everything, but on a shared broker that means
 * receiving and parsing every unrelated message on the installation. So the
 * subscription is bounded to prefixes of up to three levels, which covers the
 * Shelly default (the device id, one level) and any realistic nesting.
 */
const GEN2_EVENTS_TOPICS = ['+/events/rpc', '+/+/events/rpc', '+/+/+/events/rpc'];

/** Gen1 root topic. Gen1 has no configurable prefix — it is always `shellies`. */
const GEN1_ROOT = 'shellies';

/**
 * Parse a Gen1 MQTT topic into a component-keyed fragment.
 *
 * Gen1 publishes ONE SCALAR PER TOPIC, with no JSON anywhere:
 *
 *   shellies/shellyem3-483FDAC37E3F/emeter/0/power          -> "-8.40"
 *   shellies/shellyem3-483FDAC37E3F/emeter/0/voltage        -> "227.80"
 *   shellies/shellyem3-483FDAC37E3F/emeter/0/total          -> "7915525.36"
 *   shellies/shellyplug-s-xxxx/relay/0                      -> "on"
 *   shellies/shellyht-xxxx/sensor/temperature               -> "21.5"
 *
 * so a fragment here is always a single field of a single component. The caller
 * merges fragments, which is exactly how partial `NotifyStatus` documents are
 * already handled.
 *
 * @param {string} topic the MQTT topic
 * @param {string} payload the raw payload
 * @returns {{shellyId: string, status: object}|undefined} the fragment, or undefined
 */
export function parseGen1Topic(topic, payload) {
  const parts = topic.split('/');
  if (parts[0] !== GEN1_ROOT || parts.length < 3) {
    return undefined;
  }
  const shellyId = parts[1];
  const number = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  // shellies/<id>/relay/<n> -> "on" | "off"
  if (parts[2] === 'relay' && parts.length === 4) {
    return {
      shellyId,
      status: {
        [`${COMPONENT.SWITCH}:${parts[3]}`]: { id: Number(parts[3]), output: payload === 'on' },
      },
    };
  }

  // shellies/<id>/relay/<n>/power | /energy
  if (parts[2] === 'relay' && parts.length === 5) {
    const value = number(payload);
    if (value === undefined) {
      return undefined;
    }
    const key = `${COMPONENT.SWITCH}:${parts[3]}`;
    if (parts[4] === 'power') {
      return { shellyId, status: { [key]: { id: Number(parts[3]), apower: value } } };
    }
    // Gen1 relay energy is in watt-MINUTES; the mapper expects watt-hours.
    if (parts[4] === 'energy') {
      return {
        shellyId,
        status: { [key]: { id: Number(parts[3]), aenergy: { total: value / 60 } } },
      };
    }
    return undefined;
  }

  // shellies/<id>/emeter/<n>/<field> — the three phases of an EM/3EM.
  if (parts[2] === 'emeter' && parts.length === 5) {
    const value = number(payload);
    if (value === undefined) {
      return undefined;
    }
    const phase = ['a', 'b', 'c'][Number(parts[3])];
    if (!phase) {
      return undefined;
    }
    const field = {
      power: `${phase}_act_power`,
      voltage: `${phase}_voltage`,
      current: `${phase}_current`,
    }[parts[4]];
    if (field) {
      return { shellyId, status: { [`${COMPONENT.EM}:0`]: { id: 0, [field]: value } } };
    }
    // Cumulated counters live on `emdata:0`, already in watt-hours on Gen1
    // emeters — unlike the relay `energy` topic just above.
    const counter = {
      total: `${phase}_total_act_energy`,
      total_returned: `${phase}_total_act_ret_energy`,
    }[parts[4]];
    if (counter) {
      return { shellyId, status: { [`${COMPONENT.EMDATA}:0`]: { id: 0, [counter]: value } } };
    }
    return undefined;
  }

  // shellies/<id>/sensor/<field> — battery-powered sensors.
  if (parts[2] === 'sensor' && parts.length === 4) {
    const value = number(payload);
    if (value === undefined) {
      return undefined;
    }
    if (parts[3] === 'temperature') {
      return { shellyId, status: { [`${COMPONENT.TEMPERATURE}:0`]: { id: 0, tC: value } } };
    }
    if (parts[3] === 'humidity') {
      return { shellyId, status: { [`${COMPONENT.HUMIDITY}:0`]: { id: 0, rh: value } } };
    }
    if (parts[3] === 'battery') {
      return {
        shellyId,
        status: { [`${COMPONENT.DEVICEPOWER}:0`]: { id: 0, battery: { percent: value } } },
      };
    }
  }
  return undefined;
}

/**
 * Create the MQTT hub.
 *
 * @param {object} options hub options
 * @param {() => object} options.getConfig accessor to the current normalized config
 * @param {(shellyId: string, status: object, context: object) => void} options.onStatus pushed-status handler
 * @param {(shellyId: string, prefix: string) => void} [options.onDeviceSeen] called the first
 *   time a device publishes, so discovery can pick up devices mDNS never saw
 * @param {object} [options.mqttImpl] mqtt implementation (tests)
 * @returns {object} the hub
 */
export function createMqttHub({ getConfig, onStatus, onDeviceSeen = () => {}, mqttImpl = mqtt }) {
  let client = null;
  let connected = false;
  let requestId = 0;
  /** Devices that have published at least once: id -> topic prefix. */
  const seen = new Map();
  /** In-flight RPC requests, by id. */
  const pending = new Map();

  /**
   * Remember a device and tell the caller the first time we meet it.
   * @param {string} shellyId the Shelly device id
   * @param {string} prefix the topic prefix it publishes under
   */
  function remember(shellyId, prefix) {
    if (!shellyId || seen.get(shellyId) === prefix) {
      return;
    }
    const isNew = !seen.has(shellyId);
    seen.set(shellyId, prefix);
    if (isNew) {
      logger.info(`${shellyId}: publishing on MQTT (topic prefix "${prefix}")`);
      onDeviceSeen(shellyId, prefix);
    }
  }

  /**
   * Handle one message from the broker.
   * @param {string} topic the topic it arrived on
   * @param {Buffer} raw the raw payload
   */
  function handleMessage(topic, raw) {
    const payload = raw.toString();

    // --- Our own RPC replies ------------------------------------------------
    if (topic === `${RPC_SRC}/rpc`) {
      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        return;
      }
      const entry = pending.get(frame.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      if (frame.error) {
        entry.reject(new Error(`MQTT RPC error ${frame.error.code}: ${frame.error.message}`));
        return;
      }
      entry.resolve(frame.result);
      return;
    }

    // --- Gen1: one scalar per topic ----------------------------------------
    if (topic.startsWith(`${GEN1_ROOT}/`)) {
      const fragment = parseGen1Topic(topic, payload);
      if (fragment) {
        remember(fragment.shellyId, `${GEN1_ROOT}/${fragment.shellyId}`);
        onStatus(fragment.shellyId, fragment.status, { gen: 1 });
      }
      return;
    }

    // --- Gen2+: the same JSON-RPC notification frames as the WebSocket -------
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      logger.debug(`Unreadable MQTT payload on ${topic}`);
      return;
    }
    if (frame.method !== 'NotifyStatus' && frame.method !== 'NotifyFullStatus') {
      return;
    }
    // `src` is authoritative: the topic prefix is user-configurable, the device
    // id in `src` is not.
    // The prefix is everything before `/events/rpc`, however many levels that
    // is — it is where commands must be published back to.
    const prefix = topic.replace(/\/events\/rpc$/, '');
    const shellyId = frame.src || prefix;
    remember(shellyId, prefix);
    if (frame.params) {
      onStatus(shellyId, frame.params, { gen: 2 });
    }
  }

  /** Open the connection and subscribe, if the user configured a broker. */
  function start() {
    stop();
    const config = getConfig();
    if (!config.mqttEnabled || !config.mqttServer) {
      return;
    }

    const url = `mqtt://${config.mqttServer}`;
    logger.info(`Connecting to the MQTT broker at ${config.mqttServer}`);
    client = mqttImpl.connect(url, {
      ...(config.mqttUsername ? { username: config.mqttUsername } : {}),
      ...(config.mqttPassword ? { password: config.mqttPassword } : {}),
      clientId: `${RPC_SRC}-${Math.abs(hashString(config.mqttServer))}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    client.on('connect', () => {
      connected = true;
      logger.info('MQTT broker connected');
      client.subscribe(
        [...GEN2_EVENTS_TOPICS, `${GEN1_ROOT}/+/#`, `${RPC_SRC}/rpc`],
        { qos: 0 },
        (err) => {
          if (err) {
            logger.warn(`MQTT subscription failed: ${err.message}`);
          }
        },
      );
    });
    client.on('message', (topic, raw) => {
      try {
        handleMessage(topic, raw);
      } catch (err) {
        // One bad frame must never take the connection, or the process, down.
        logger.warn(`Failed to handle an MQTT message on ${topic}: ${err.message}`);
      }
    });
    client.on('error', (err) => logger.warn(`MQTT error: ${err.message}`));
    client.on('close', () => {
      connected = false;
    });
  }

  /**
   * Send an RPC request to one device over MQTT.
   *
   * Only works when the device has "Enable MQTT Control" ticked, which is what
   * makes `<prefix>/rpc` accept requests.
   *
   * @param {string} shellyId the Shelly device id
   * @param {string} method RPC method name
   * @param {object} [params] method parameters
   * @returns {Promise<object>} the `result` payload
   */
  function request(shellyId, method, params = undefined) {
    return new Promise((resolve, reject) => {
      const prefix = seen.get(shellyId);
      if (!client || !connected || !prefix) {
        reject(new Error(`${shellyId}: not reachable over MQTT`));
        return;
      }
      requestId += 1;
      const id = requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${shellyId}: MQTT RPC timeout`));
      }, RPC_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      pending.set(id, { resolve, reject, timer });
      client.publish(
        `${prefix}/rpc`,
        JSON.stringify({ id, src: RPC_SRC, method, ...(params ? { params } : {}) }),
      );
    });
  }

  /** Close the connection. */
  function stop() {
    pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error('MQTT hub stopped'));
    });
    pending.clear();
    if (client) {
      try {
        client.end(true);
      } catch {
        // Already closing.
      }
      client = null;
    }
    connected = false;
    seen.clear();
  }

  return {
    start,
    stop,
    request,
    isConnected: () => connected,
    /** Whether this device has ever published to the broker. */
    knows: (shellyId) => seen.has(shellyId),
    /** Every device that published, as `{shellyId, prefix}`. */
    devices: () => [...seen.entries()].map(([shellyId, prefix]) => ({ shellyId, prefix })),
  };
}

/**
 * Small stable hash, used to derive a client id that does not change between
 * restarts (a random one would leave stale sessions on the broker).
 * @param {string} value string to hash
 * @returns {number} a 32-bit hash
 */
function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
