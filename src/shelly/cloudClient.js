// -----------------------------------------------------------------------------
// Shelly Cloud client — the fallback channel.
//
// The Cloud Control API is a small form-encoded REST surface authenticated by
// a single `auth_key` scoped to the whole account, hosted on the per-account
// server shown next to the key in the Shelly app
// (e.g. `shelly-53-eu.shelly.cloud`).
//
// Devices are addressed by their MAC WITHOUT separators and in lowercase
// (`2cbcbba663cc`), NOT by the local id (`shellypro3em-2cbcbba663cc`) — the
// single most common mistake when wiring this API. `normalizeCloudId` is the
// one place that conversion happens.
//
// For a Gen2+ device the cloud returns the SAME component-keyed status
// document as the local RPC (`switch:0`, `em:0`…), which is what lets the rest
// of the integration parse both channels with one mapper. For a Gen1 device it
// returns the flat Gen1 `/status` document, normalized here into the same
// shape (`normalizeCloudStatus`) — the mapper never sees the difference.
//
// The API allows about ONE request per second per account (issue #6). The
// telemetry loop therefore reads the whole account in one `all_status` call
// shared by every device of the cycle (`getStatusBatched`), and every call is
// spaced so a burst of commands never trips the limit.
// -----------------------------------------------------------------------------

import { CLOUD_TIMEOUT_MS } from './constants.js';
import { normalizeGen1Status } from './gen1/normalize.js';

/** Minimum time between two Cloud API calls, in ms (documented: 1 request/s). */
export const CLOUD_MIN_INTERVAL_MS = 1100;

/** How long one `all_status` answer serves the devices of a cycle, in ms. */
export const ALL_STATUS_TTL_MS = 10000;

/** Keys the cloud adds to a status document that are not device components. */
const CLOUD_META_KEYS = ['_dev_info', '_updated', 'serial', 'getinfo'];

/** Fields only a Gen1 flat `/status` document carries. */
const GEN1_MARKERS = [
  'relays',
  'meters',
  'emeters',
  'rollers',
  'lights',
  'inputs',
  'tmp',
  'hum',
  'bat',
  'flood',
  'sensor',
];

/**
 * Turn a status document served by the cloud into the component-keyed shape:
 * cloud metadata dropped, a Gen1 flat document normalized like a local Gen1
 * read.
 * @param {object|undefined} status the cloud status document
 * @returns {object|undefined} the component-keyed status
 */
export function normalizeCloudStatus(status) {
  if (!status || typeof status !== 'object') {
    return status;
  }
  const cleaned = Object.fromEntries(
    Object.entries(status).filter(([key]) => !CLOUD_META_KEYS.includes(key)),
  );
  const generation = Number(status._dev_info?.gen);
  const looksGen1 =
    generation === 1 ||
    (!Number.isFinite(generation) &&
      !Object.keys(cleaned).some((key) => key.includes(':')) &&
      GEN1_MARKERS.some((key) => key in cleaned));
  return looksGen1 ? normalizeGen1Status(cleaned) : cleaned;
}

/** The cloud is unreachable or misbehaving right now — worth retrying. */
export class ShellyCloudError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellyCloudError';
    this.transient = true;
  }
}

/** The cloud refused the authorization key — retrying will not help. */
export class ShellyCloudAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellyCloudAuthError';
    this.transient = false;
  }
}

/**
 * Convert any form of Shelly identifier into the id the Cloud API expects.
 * Accepts a local id (`shellypro3em-2cbcbba663cc`), a MAC with or without
 * separators, and an already-normalized cloud id.
 * @param {string} identifier any Shelly identifier
 * @returns {string} the lowercase, separator-free cloud id
 */
export function normalizeCloudId(identifier) {
  const value = String(identifier || '').toLowerCase();
  // Keep the trailing MAC of a local id, then strip every separator.
  const tail = value.includes('-') ? value.slice(value.lastIndexOf('-') + 1) : value;
  return tail.replace(/[^a-f0-9]/g, '');
}

/**
 * Create a Shelly Cloud client.
 * @param {object} options client options
 * @param {() => object} options.getConfig accessor to the current normalized config
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @param {number} [options.timeoutMs] per-call timeout
 * @returns {object} the cloud client
 */
export function createCloudClient({
  getConfig,
  fetchImpl = fetch,
  timeoutMs = CLOUD_TIMEOUT_MS,
  minIntervalMs = CLOUD_MIN_INTERVAL_MS,
  now = Date.now,
}) {
  /** Tail of the call queue, and when the last call started. */
  let queue = Promise.resolve();
  let lastCallAt = 0;
  /** The `all_status` answer shared by the devices of a cycle. */
  let allStatus = null;

  /**
   * Run one call after the previous ones, at least `minIntervalMs` apart.
   * @template T
   * @param {() => Promise<T>} run the call
   * @returns {Promise<T>} its result
   */
  function paced(run) {
    const next = queue.then(async () => {
      const wait = lastCallAt + minIntervalMs - now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      lastCallAt = now();
      return run();
    });
    // A failed call must not jam the queue for the next ones.
    queue = next.catch(() => {});
    return next;
  }

  /**
   * POST one form-encoded request and unwrap the `{ isok, data }` envelope.
   * @param {string} path endpoint path, e.g. `/device/status`
   * @param {Record<string, string>} params body parameters (auth_key added here)
   * @returns {Promise<object>} the `data` payload
   */
  function post(path, params) {
    return paced(() => postNow(path, params));
  }

  /**
   * POST one request right away (see `post`, which paces them).
   * @param {string} path endpoint path
   * @param {Record<string, string>} params body parameters
   * @returns {Promise<object>} the `data` payload
   */
  async function postNow(path, params) {
    const { cloudServer, cloudAuthKey } = getConfig();
    if (!cloudServer || !cloudAuthKey) {
      throw new ShellyCloudAuthError('Shelly Cloud server or authorization key missing');
    }

    const body = new URLSearchParams({ ...params, auth_key: cloudAuthKey });
    let response;
    try {
      response = await fetchImpl(`https://${cloudServer}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ShellyCloudError(`Shelly Cloud unreachable: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShellyCloudAuthError('Shelly Cloud rejected the authorization key');
    }
    if (response.status === 429) {
      throw new ShellyCloudError('Shelly Cloud rate limit reached (HTTP 429)');
    }
    if (!response.ok) {
      throw new ShellyCloudError(`Shelly Cloud HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ShellyCloudError(`Shelly Cloud sent an invalid JSON response (${err.message})`);
    }

    if (payload && payload.isok === false) {
      const message = payload.errors ? JSON.stringify(payload.errors) : 'unknown error';
      // The API answers 200 with `isok: false` for a bad key, so the auth case
      // has to be recognized in the body, not only in the HTTP status.
      if (/auth|token|key/i.test(message)) {
        throw new ShellyCloudAuthError(`Shelly Cloud rejected the request: ${message}`);
      }
      throw new ShellyCloudError(`Shelly Cloud error: ${message}`);
    }
    return payload ? payload.data : undefined;
  }

  /**
   * Fetch the status of every device of the account, in one request.
   * @returns {Promise<Record<string, object>>} statuses keyed by cloud device id
   */
  async function getAllStatus() {
    const data = await post('/device/all_status', {});
    const statuses = data?.devices_status || {};
    return Object.fromEntries(
      Object.entries(statuses).map(([cloudId, status]) => [
        normalizeCloudId(cloudId),
        normalizeCloudStatus(status),
      ]),
    );
  }

  /**
   * The status of one device, served from an `all_status` answer shared by
   * every device asking within `ALL_STATUS_TTL_MS`: N devices on the cloud
   * cost one request per cycle, not N. A device the answer does not list is
   * read on its own.
   * @param {string} identifier any Shelly identifier of the device
   * @returns {Promise<object|undefined>} the component-keyed status
   */
  async function getStatusBatched(identifier) {
    if (!allStatus || now() - allStatus.at >= ALL_STATUS_TTL_MS) {
      const request = getAllStatus();
      allStatus = { at: now(), request };
      // A failed batch is not kept: the next device retries.
      request.catch(() => {
        if (allStatus?.request === request) {
          allStatus = null;
        }
      });
    }
    const statuses = await allStatus.request;
    const status = statuses[normalizeCloudId(identifier)];
    return status !== undefined ? status : getStatus(identifier);
  }

  /**
   * Fetch the status of ONE device.
   * @param {string} identifier any Shelly identifier of the device
   * @returns {Promise<object|undefined>} the device status document
   */
  async function getStatus(identifier) {
    const data = await post('/device/status', { id: normalizeCloudId(identifier) });
    return normalizeCloudStatus(data?.device_status);
  }

  /**
   * Turn a relay channel on or off through the cloud.
   * @param {string} identifier any Shelly identifier of the device
   * @param {number} channel relay channel index
   * @param {boolean} on desired state
   * @returns {Promise<object>} the API response payload
   */
  async function setRelay(identifier, channel, on) {
    return command(identifier, '/device/relay/control', {
      channel: String(channel),
      turn: on ? 'on' : 'off',
    });
  }

  /**
   * Send a control call through the cloud (relay, roller, light).
   * @param {string} identifier any Shelly identifier of the device
   * @param {string} path Cloud Control API path, e.g. `/device/relay/roller/control`
   * @param {object} body form fields besides the device id
   * @returns {Promise<object>} the API response payload
   */
  async function command(identifier, path, body) {
    return post(path, { id: normalizeCloudId(identifier), ...body });
  }

  /**
   * Cheap credentials check used when the user saves the configuration: a
   * successful call is the only way to tell a valid key from a typo.
   * @returns {Promise<number>} the number of devices visible on the account
   */
  async function checkCredentials() {
    const statuses = await getAllStatus();
    return Object.keys(statuses).length;
  }

  return { getAllStatus, getStatus, getStatusBatched, setRelay, command, checkCredentials };
}
