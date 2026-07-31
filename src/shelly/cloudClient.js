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
// of the integration parse both channels with one mapper.
// -----------------------------------------------------------------------------

import { CLOUD_TIMEOUT_MS } from './constants.js';

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
export function createCloudClient({ getConfig, fetchImpl = fetch, timeoutMs = CLOUD_TIMEOUT_MS }) {
  /**
   * POST one form-encoded request and unwrap the `{ isok, data }` envelope.
   * @param {string} path endpoint path, e.g. `/device/status`
   * @param {Record<string, string>} params body parameters (auth_key added here)
   * @returns {Promise<object>} the `data` payload
   */
  async function post(path, params) {
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
      Object.entries(statuses).map(([cloudId, status]) => [normalizeCloudId(cloudId), status]),
    );
  }

  /**
   * Fetch the status of ONE device.
   * @param {string} identifier any Shelly identifier of the device
   * @returns {Promise<object|undefined>} the device status document
   */
  async function getStatus(identifier) {
    const data = await post('/device/status', { id: normalizeCloudId(identifier) });
    return data?.device_status;
  }

  /**
   * Turn a relay channel on or off through the cloud.
   * @param {string} identifier any Shelly identifier of the device
   * @param {number} channel relay channel index
   * @param {boolean} on desired state
   * @returns {Promise<object>} the API response payload
   */
  async function setRelay(identifier, channel, on) {
    return post('/device/relay/control', {
      id: normalizeCloudId(identifier),
      channel: String(channel),
      turn: on ? 'on' : 'off',
    });
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

  return { getAllStatus, getStatus, setRelay, checkCredentials };
}
