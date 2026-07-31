// -----------------------------------------------------------------------------
// Gen2+ RPC over WebSocket — the real-time channel.
//
// A Shelly Gen2+ device exposes the SAME RPC surface at `ws://<ip>/rpc`, and
// once a client is connected the device PUSHES what changes:
//   - `NotifyStatus`     — a PARTIAL status document, exactly the shape
//                          `Shelly.GetStatus` returns, restricted to what moved;
//   - `NotifyFullStatus` — the complete document (sent on connect and on reboot);
//   - `NotifyEvent`      — discrete events (button pushes, energy periods).
//
// That "same shape" is the whole point: `buildStates()` maps a partial document
// unchanged, so this module is TRANSPORT ONLY — it never learns what a switch
// or an energy meter is.
//
// Authentication differs from the HTTP channel and this is the classic trap:
// the WebSocket carries an `auth` OBJECT INSIDE the JSON request, not an
// `Authorization` header, and its HA2 is the CONSTANT
// sha256("dummy_method:dummy_uri") rather than a hash of the real method.
// Getting that wrong yields an endless 401 loop against a device whose
// password is perfectly correct.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

import { logger } from '@gladysassistant/integration-sdk';
import WebSocket from 'ws';

import { DEFAULT_HTTP_PORT } from './constants.js';

/** Source name the device echoes back as `dst` on our responses. */
const RPC_SRC = 'gladys';

/** Reconnection backoff bounds, in ms. */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;

/** How long we wait for the device to answer a request, in ms. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * The constant HA2 of the Shelly WebSocket digest scheme. The device does NOT
 * hash the real method and URI here — it hashes this literal, on both sides.
 */
const WS_HA2 = createHash('sha256').update('dummy_method:dummy_uri', 'utf8').digest('hex');

/**
 * SHA-256 hex digest.
 * @param {string} value string to hash
 * @returns {string} lowercase hex digest
 */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Build the `auth` object answering a WebSocket digest challenge.
 *
 * Exported for the tests: this is the piece that is easy to get subtly wrong
 * and impossible to debug from the outside (the device just says 401 again).
 *
 * @param {object} params inputs of the digest computation
 * @param {object} params.challenge challenge sent by the device
 * @param {string} params.username device username (`admin` on Gen2+)
 * @param {string} params.password device password
 * @param {number} params.nc request counter for this nonce
 * @param {string} [params.cnonce] client nonce (injectable for the tests)
 * @returns {object} the `auth` object to embed in the request
 */
export function buildWsAuth({ challenge, username, password, nc, cnonce }) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce;
  const clientNonce = cnonce || randomBytes(16).toString('base64');
  const ha1 = sha256(`${username}:${realm}:${password}`);
  const response = sha256(`${ha1}:${nonce}:${nc}:${clientNonce}:auth:${WS_HA2}`);

  return {
    realm,
    username,
    nonce,
    cnonce: clientNonce,
    response,
    algorithm: 'SHA-256',
    nc,
  };
}

/**
 * Read the digest challenge out of a 401 error frame.
 *
 * The device puts a JSON DOCUMENT inside the `message` string of the error —
 * not a structured field — so it has to be parsed out.
 *
 * @param {object} error the `error` object of an RPC response
 * @returns {object|undefined} the parsed challenge, or undefined
 */
export function parseWsChallenge(error) {
  if (!error || error.code !== 401 || typeof error.message !== 'string') {
    return undefined;
  }
  try {
    const challenge = JSON.parse(error.message);
    return challenge && challenge.nonce !== undefined ? challenge : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open and maintain ONE WebSocket connection to a device.
 *
 * The connection owns its own reconnection loop for life: a device rebooting,
 * a Wi-Fi drop or a router restart must heal without anything else noticing.
 * `close()` is the only thing that stops it.
 *
 * @param {object} options connection options
 * @param {string} options.shellyId the Shelly device id (logs and callbacks)
 * @param {string} options.host IP address or hostname
 * @param {number} [options.port] HTTP port of the device
 * @param {() => {username: string, password: string}} options.getCredentials credentials accessor
 * @param {(status: object) => void} options.onStatus called with each pushed status document
 * @param {(connected: boolean) => void} [options.onConnectionChange] connection state hook
 * @param {typeof WebSocket} [options.WebSocketImpl] WebSocket implementation (tests)
 * @returns {{close: () => void, isConnected: () => boolean, request: (method: string, params?: object) => Promise<object>}} the connection
 */
export function createWsConnection({
  shellyId,
  host,
  port = DEFAULT_HTTP_PORT,
  getCredentials,
  onStatus,
  onConnectionChange = () => {},
  WebSocketImpl = WebSocket,
}) {
  const url = `ws://${host}${port === DEFAULT_HTTP_PORT ? '' : `:${port}`}/rpc`;

  let socket = null;
  let closed = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let requestId = 0;
  let challenge = null;
  let nonceCount = 0;

  /** @type {Map<number, {resolve: Function, reject: Function, frame: object, retried: boolean, timer: NodeJS.Timeout}>} */
  const pending = new Map();

  /**
   * Settle and forget one in-flight request.
   * @param {number} id request id
   * @returns {object|undefined} the pending entry
   */
  function takePending(id) {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    return entry;
  }

  /** Reject every in-flight request (the socket went away under them). */
  function failPending(reason) {
    pending.forEach((entry, id) => {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(`${shellyId}: ${reason}`));
    });
  }

  /**
   * Send a frame, attaching the auth object when we hold a challenge.
   * @param {object} frame the JSON-RPC frame
   */
  function send(frame) {
    const { username, password } = getCredentials();
    const payload = { ...frame };
    if (challenge && password) {
      nonceCount += 1;
      payload.auth = buildWsAuth({ challenge, username, password, nc: nonceCount });
    }
    socket.send(JSON.stringify(payload));
  }

  /**
   * Handle one frame received from the device.
   * @param {object} message the parsed frame
   */
  function handleMessage(message) {
    // A pushed status: partial (NotifyStatus) or complete (NotifyFullStatus).
    // Both carry the component-keyed shape the mapper already understands; the
    // `ts` key rides along and is ignored by the mapper.
    if (message.method === 'NotifyStatus' || message.method === 'NotifyFullStatus') {
      if (message.params) {
        onStatus(message.params);
      }
      return;
    }
    // NotifyEvent (button pushes, energy periods) is deliberately not handled
    // yet — it is what issue #5 needs, and inventing a mapping now would mean
    // guessing at semantics.
    if (message.method === 'NotifyEvent') {
      return;
    }

    if (message.id === undefined) {
      return;
    }
    const entry = takePending(message.id);
    if (!entry) {
      return;
    }

    const newChallenge = parseWsChallenge(message.error);
    if (newChallenge) {
      const { password } = getCredentials();
      if (!password) {
        entry.reject(new Error(`${shellyId}: authentication required but no password configured`));
        return;
      }
      if (entry.retried) {
        // We already replayed this request WITH the auth object and the device
        // still refuses: the password is wrong, not the handshake.
        challenge = null;
        entry.reject(new Error(`${shellyId}: wrong device password`));
        return;
      }
      // A fresh nonce restarts the counter — replaying the old one is rejected
      // as a stale request.
      if (!challenge || challenge.nonce !== newChallenge.nonce) {
        nonceCount = Number.isFinite(Number(newChallenge.nc)) ? Number(newChallenge.nc) - 1 : 0;
      }
      challenge = newChallenge;
      // Replay under a NEW id: the device tracks ids per connection.
      requestId += 1;
      const replayId = requestId;
      const replayFrame = { ...entry.frame, id: replayId };
      const replayTimer = setTimeout(() => {
        takePending(replayId);
        entry.reject(new Error(`${shellyId}: RPC timeout`));
      }, REQUEST_TIMEOUT_MS);
      if (typeof replayTimer.unref === 'function') {
        replayTimer.unref();
      }
      pending.set(replayId, {
        resolve: entry.resolve,
        reject: entry.reject,
        frame: replayFrame,
        retried: true,
        timer: replayTimer,
      });
      send(replayFrame);
      return;
    }

    if (message.error) {
      entry.reject(
        new Error(`${shellyId}: RPC error ${message.error.code}: ${message.error.message}`),
      );
      return;
    }
    entry.resolve(message.result);
  }

  /** Schedule the next reconnection with exponential backoff. */
  function scheduleReconnect() {
    if (closed || reconnectTimer) {
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref();
    }
  }

  /** Open the socket and wire its lifecycle. */
  function connect() {
    if (closed) {
      return;
    }
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      logger.debug(`${shellyId}: WebSocket could not be created (${err.message})`);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.on('open', () => {
      reconnectAttempts = 0;
      // A brand-new connection means a brand-new nonce space.
      challenge = null;
      nonceCount = 0;
      logger.info(`${shellyId}: real-time WebSocket connected`);
      onConnectionChange(true);
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        logger.debug(`${shellyId}: unreadable WebSocket frame`);
        return;
      }
      try {
        handleMessage(message);
      } catch (err) {
        // A bad frame must never take the connection (or the process) down.
        logger.warn(`${shellyId}: failed to handle a WebSocket frame: ${err.message}`);
      }
    });

    ws.on('close', () => {
      if (socket === ws) {
        socket = null;
      }
      failPending('WebSocket closed');
      onConnectionChange(false);
      if (!closed) {
        logger.debug(`${shellyId}: WebSocket closed, reconnecting`);
        scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      // 'error' is always followed by 'close', which owns the reconnection:
      // reconnecting here too would open two sockets per failure.
      logger.debug(`${shellyId}: WebSocket error (${err.message})`);
    });
  }

  /**
   * Send an RPC request over the WebSocket.
   * @param {string} method RPC method name
   * @param {object} [params] method parameters
   * @returns {Promise<object>} the `result` payload
   */
  function request(method, params = undefined) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(new Error(`${shellyId}: WebSocket not connected`));
        return;
      }
      requestId += 1;
      const id = requestId;
      const frame = { id, src: RPC_SRC, method, ...(params ? { params } : {}) };
      const timer = setTimeout(() => {
        takePending(id);
        reject(new Error(`${shellyId}: RPC timeout`));
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      pending.set(id, { resolve, reject, frame, retried: false, timer });
      try {
        send(frame);
      } catch (err) {
        takePending(id);
        reject(err);
      }
    });
  }

  connect();

  return {
    request,
    isConnected: () => Boolean(socket && socket.readyState === 1),
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failPending('connection closed');
      if (socket) {
        try {
          socket.close();
        } catch {
          // Already closing or never opened: nothing to do.
        }
        socket = null;
      }
    },
  };
}
