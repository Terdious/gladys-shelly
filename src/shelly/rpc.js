// -----------------------------------------------------------------------------
// Gen2+ RPC transport over HTTP, with the digest authentication Shelly uses.
//
// The Shelly RPC surface is a JSON-RPC 2.0 endpoint at `POST http://<host>/rpc`:
//   { "id": 1, "method": "Switch.Set", "params": { "id": 0, "on": true } }
// answered with `{ "id": 1, "result": {...} }` or `{ "id": 1, "error": {...} }`.
//
// When authentication is enabled on the device, the first call gets a `401`
// carrying a digest challenge; we replay it with the Authorization header.
// Shelly Gen2+ only implements SHA-256 digest, and the username is always
// `admin` (the realm is the device id).
//
// This module is deliberately transport-only: it knows nothing about switches
// or energy meters, so it stays testable with a plain fake `fetch`.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

import { DEFAULT_HTTP_PORT, LOCAL_RPC_TIMEOUT_MS } from './constants.js';

/**
 * A call failed in a way that is worth retrying later (device asleep, Wi-Fi
 * hiccup, timeout). Callers use it to decide between "try the cloud" and
 * "this device is misconfigured".
 */
export class ShellyConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellyConnectionError';
    this.transient = true;
  }
}

/** The device is reachable but refused our credentials — retrying will not help. */
export class ShellyAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellyAuthError';
    this.transient = false;
  }
}

/** The device answered a JSON-RPC error (unknown method, bad params, busy…). */
export class ShellyRpcError extends Error {
  constructor(code, message) {
    super(`RPC error ${code}: ${message}`);
    this.name = 'ShellyRpcError';
    this.code = code;
    // 503 means "busy, try again", anything else is a real protocol mistake.
    this.transient = code === 503;
  }
}

/**
 * SHA-256 hex digest of a string — the only hash Shelly digest auth uses.
 * @param {string} value string to hash
 * @returns {string} lowercase hex digest
 */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Parse a `WWW-Authenticate: Digest ...` header into its parameters.
 * Values may or may not be quoted, and Shelly's exact spacing has changed
 * between firmwares, so parse defensively rather than by a strict split.
 * @param {string} header raw header value
 * @returns {Record<string, string>} the challenge parameters
 */
export function parseDigestChallenge(header) {
  const challenge = {};
  if (typeof header !== 'string') {
    return challenge;
  }
  const withoutScheme = header.replace(/^\s*Digest\s+/i, '');
  const pattern = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match = pattern.exec(withoutScheme);
  while (match !== null) {
    challenge[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    match = pattern.exec(withoutScheme);
  }
  return challenge;
}

/**
 * Build the `Authorization` header answering a digest challenge (RFC 7616,
 * SHA-256, `qop=auth`).
 * @param {object} params inputs of the digest computation
 * @param {Record<string, string>} params.challenge parsed challenge
 * @param {string} params.username device username (`admin` on Gen2+)
 * @param {string} params.password device password
 * @param {string} params.method HTTP method of the request being authorized
 * @param {string} params.uri request path, e.g. `/rpc`
 * @param {number} params.nc request counter for this nonce, starting at 1
 * @param {string} [params.cnonce] client nonce (injectable for the tests)
 * @returns {string} the Authorization header value
 */
export function buildDigestHeader({
  challenge,
  username,
  password,
  method,
  uri,
  nc,
  cnonce = randomBytes(16).toString('hex'),
}) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const ha1 = sha256(`${username}:${realm}:${password}`);
  const ha2 = sha256(`${method}:${uri}`);
  const ncValue = String(nc).padStart(8, '0');
  const response = sha256(`${ha1}:${nonce}:${ncValue}:${cnonce}:auth:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    'algorithm=SHA-256',
    'qop=auth',
    `nc=${ncValue}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
  ];
  if (challenge.opaque) {
    parts.push(`opaque="${challenge.opaque}"`);
  }
  return `Digest ${parts.join(', ')}`;
}

/**
 * Create an RPC client bound to ONE device address.
 *
 * The client is intentionally cheap to create and holds only the digest state
 * (challenge + nonce counter): the caller owns the device inventory and can
 * recreate a client whenever a device changes IP.
 *
 * @param {object} options client options
 * @param {string} options.host IP address or hostname of the device
 * @param {number} [options.port] HTTP port
 * @param {string} [options.username] device username
 * @param {string} [options.password] device password
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @param {number} [options.timeoutMs] per-call timeout
 * @returns {{call: (method: string, params?: object) => Promise<object>, host: string}} the client
 */
export function createRpcClient({
  host,
  port = DEFAULT_HTTP_PORT,
  username = 'admin',
  password = '',
  fetchImpl = fetch,
  timeoutMs = LOCAL_RPC_TIMEOUT_MS,
}) {
  const baseUrl = `http://${host}${port === DEFAULT_HTTP_PORT ? '' : `:${port}`}`;
  const uri = '/rpc';

  // Digest state, reused across calls so the common case is a single round trip.
  let challenge = null;
  let nonceCount = 0;
  let requestId = 0;

  /**
   * Perform one HTTP POST on /rpc, optionally authenticated.
   * @param {string} body serialized JSON-RPC request
   * @param {boolean} withAuth whether to attach the Authorization header
   * @returns {Promise<Response>} the raw response
   */
  async function post(body, withAuth) {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuth && challenge) {
      nonceCount += 1;
      headers.Authorization = buildDigestHeader({
        challenge,
        username,
        password,
        method: 'POST',
        uri,
        nc: nonceCount,
      });
    }
    // AbortSignal.timeout keeps a dead device from stalling the whole poll
    // cycle: without it a silently dropped TCP connection hangs until the OS
    // gives up, minutes later.
    return fetchImpl(`${baseUrl}${uri}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /**
   * Call one RPC method on the device.
   * @param {string} method RPC method name, e.g. `Shelly.GetStatus`
   * @param {object} [params] method parameters
   * @returns {Promise<object>} the `result` payload
   */
  async function call(method, params = undefined) {
    requestId += 1;
    const body = JSON.stringify({
      id: requestId,
      src: 'gladys',
      method,
      ...(params ? { params } : {}),
    });

    let response;
    try {
      // Reuse a challenge we already hold: authenticated devices answer the
      // very first call with a 401, and every later call in one round trip.
      response = await post(body, challenge !== null);
    } catch (err) {
      throw new ShellyConnectionError(`${host}: ${err.message}`);
    }

    if (response.status === 401) {
      if (!password) {
        throw new ShellyAuthError(`${host}: authentication required but no password configured`);
      }
      const newChallenge = parseDigestChallenge(
        response.headers.get('www-authenticate') || response.headers.get('WWW-Authenticate'),
      );
      if (!newChallenge.nonce) {
        throw new ShellyAuthError(`${host}: unreadable authentication challenge`);
      }
      // A fresh nonce restarts the counter: reusing the old one makes the
      // device reject the replay as a stale request.
      const isNewNonce = !challenge || challenge.nonce !== newChallenge.nonce;
      challenge = newChallenge;
      if (isNewNonce) {
        nonceCount = 0;
      }
      try {
        response = await post(body, true);
      } catch (err) {
        throw new ShellyConnectionError(`${host}: ${err.message}`);
      }
      if (response.status === 401) {
        // The credentials themselves are wrong: drop the challenge so a later
        // call after a password fix starts from a clean slate.
        challenge = null;
        throw new ShellyAuthError(`${host}: wrong device password`);
      }
    }

    if (!response.ok) {
      throw new ShellyConnectionError(`${host}: HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ShellyConnectionError(`${host}: invalid JSON response (${err.message})`);
    }

    if (payload && payload.error) {
      throw new ShellyRpcError(payload.error.code, payload.error.message);
    }
    return payload ? payload.result : undefined;
  }

  return { call, host };
}

/**
 * Read the unauthenticated `GET /shelly` identity endpoint.
 *
 * This is the one endpoint every generation answers without credentials, so it
 * is how we tell a Gen2+ device (which has a `gen` field) from a Gen1 one, and
 * how discovery learns the device id and model before any RPC call.
 *
 * @param {object} options request options
 * @param {string} options.host IP address or hostname
 * @param {number} [options.port] HTTP port
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @param {number} [options.timeoutMs] request timeout
 * @returns {Promise<object>} the identity payload
 */
export async function getShellyInfo({
  host,
  port = DEFAULT_HTTP_PORT,
  fetchImpl = fetch,
  timeoutMs = LOCAL_RPC_TIMEOUT_MS,
}) {
  const baseUrl = `http://${host}${port === DEFAULT_HTTP_PORT ? '' : `:${port}`}`;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/shelly`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ShellyConnectionError(`${host}: ${err.message}`);
  }
  if (!response.ok) {
    throw new ShellyConnectionError(`${host}: HTTP ${response.status} on /shelly`);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new ShellyConnectionError(`${host}: invalid /shelly payload (${err.message})`);
  }
}
