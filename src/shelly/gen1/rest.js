// -----------------------------------------------------------------------------
// Gen1 transport: a plain REST API, nothing like the Gen2+ JSON-RPC surface.
//
//   GET /status          -> the whole device state, in a FLAT device-specific
//                           document (`relays[]`, `emeters[]`, `meters[]`…)
//   GET /relay/N?turn=on -> flip a relay
//   GET /settings        -> the names the user set in the Shelly app
//
// Two differences with Gen2+ decide the shape of this file:
//   - authentication is HTTP **Basic**, not digest. There is no challenge round
//     trip, so credentials go out on the first request;
//   - the device does NOT self-describe. `/status` is the only capability
//     evidence there is, which is why normalize.js derives components from the
//     arrays actually present rather than from a model table.
//
// Everything above `normalize.js` stays generation-agnostic: this module and
// its sibling are the only two places that know Gen1 exists.
// -----------------------------------------------------------------------------

import { DEFAULT_HTTP_PORT, LOCAL_RPC_TIMEOUT_MS } from '../constants.js';
import { ShellyAuthError, ShellyConnectionError } from '../rpc.js';

/**
 * Build the base URL of a Gen1 device.
 * @param {string} host IP address or hostname
 * @param {number} port HTTP port
 * @returns {string} the base URL
 */
function baseUrlOf(host, port) {
  return `http://${host}${port === DEFAULT_HTTP_PORT ? '' : `:${port}`}`;
}

/**
 * Perform one authenticated GET against a Gen1 device.
 *
 * @param {object} options request options
 * @param {string} options.host IP address or hostname
 * @param {string} options.path path to request, e.g. `/status`
 * @param {number} [options.port] HTTP port
 * @param {string} [options.username] device username
 * @param {string} [options.password] device password
 * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests)
 * @param {number} [options.timeoutMs] request timeout
 * @returns {Promise<object>} the parsed JSON body
 */
export async function gen1Get({
  host,
  path,
  port = DEFAULT_HTTP_PORT,
  username = 'admin',
  password = '',
  fetchImpl = fetch,
  timeoutMs = LOCAL_RPC_TIMEOUT_MS,
}) {
  const headers = {};
  if (password) {
    // Basic, not digest. Gen1 firmware never implemented digest, so sending a
    // digest header here yields a 401 loop against a perfectly good password.
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  }

  let response;
  try {
    response = await fetchImpl(`${baseUrlOf(host, port)}${path}`, {
      method: 'GET',
      headers,
      // Without this a silently dropped TCP connection stalls the whole poll
      // cycle until the OS gives up, minutes later.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ShellyConnectionError(`${host}: ${err.message}`);
  }

  if (response.status === 401) {
    throw new ShellyAuthError(
      password
        ? `${host}: wrong device password`
        : `${host}: authentication required but no password configured`,
    );
  }
  if (!response.ok) {
    throw new ShellyConnectionError(`${host}: HTTP ${response.status} on ${path}`);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new ShellyConnectionError(`${host}: invalid ${path} payload (${err.message})`);
  }
}

/**
 * Read the full state of a Gen1 device.
 * @param {object} options request options
 * @returns {Promise<object>} the raw `/status` document
 */
export function getGen1Status(options) {
  return gen1Get({ ...options, path: '/status' });
}

/**
 * Read the user-set names of a Gen1 device.
 *
 * Failing here costs nice labels, never the device — callers are expected to
 * treat it as optional.
 *
 * @param {object} options request options
 * @returns {Promise<object>} the raw `/settings` document
 */
export function getGen1Settings(options) {
  return gen1Get({ ...options, path: '/settings' });
}

/**
 * Turn a Gen1 relay channel on or off.
 * @param {object} options request options
 * @param {number} channel relay channel index
 * @param {boolean} on desired state
 * @returns {Promise<object>} the device answer
 */
export function setGen1Relay(options, channel, on) {
  return gen1Get({ ...options, path: `/relay/${channel}?turn=${on ? 'on' : 'off'}` });
}
