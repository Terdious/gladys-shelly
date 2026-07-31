// -----------------------------------------------------------------------------
// The set of real-time WebSocket connections, one per device.
//
// The hub is declarative: `sync(targets)` is given the devices that SHOULD be
// connected right now, and it opens, keeps or closes connections to match.
// Everything else in the codebase already computes that list (the poll loop
// builds it from the Gladys devices), so there is no second inventory to keep
// in step.
//
// It also owns the answer to "is this device live-pushing right now?", which
// telemetry uses to decide whether a device still needs polling.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

import { createWsConnection } from './wsRpc.js';

/**
 * Create the WebSocket hub.
 * @param {object} options hub options
 * @param {() => object} options.getConfig accessor to the current normalized config
 * @param {(shellyId: string, status: object) => void} options.onStatus pushed-status handler
 * @param {(shellyId: string, connected: boolean) => void} [options.onConnectionChange] liveness hook
 * @param {object} [options.WebSocketImpl] WebSocket implementation (tests)
 * @returns {object} the hub
 */
export function createWsHub({ getConfig, onStatus, onConnectionChange = () => {}, WebSocketImpl }) {
  /** @type {Map<string, {connection: object, host: string}>} */
  const connections = new Map();
  /** Devices currently pushing, so telemetry can skip polling them. */
  const live = new Set();

  /**
   * Open, keep or close connections so they match the given targets.
   *
   * Called after every discovery and every refresh cycle: a device that lost
   * its address, was deleted in Gladys, or moved to a new IP is handled by the
   * same code path as a brand-new one.
   *
   * @param {Array<{shellyId: string, host?: string}>} targets devices that should be connected
   */
  function sync(targets) {
    const config = getConfig();
    // Real-time push is a LOCAL capability: when the user asked to prefer the
    // cloud there is nothing to connect to, and holding sockets open would be
    // pure waste.
    const wanted = new Map(
      config.preferLocal
        ? (targets || []).filter((target) => target.host).map((t) => [t.shellyId, t.host])
        : [],
    );

    // Close what is no longer wanted, or what moved to another address.
    connections.forEach((entry, shellyId) => {
      if (wanted.get(shellyId) !== entry.host) {
        entry.connection.close();
        connections.delete(shellyId);
        live.delete(shellyId);
      }
    });

    // Open what is missing.
    wanted.forEach((host, shellyId) => {
      if (connections.has(shellyId)) {
        return;
      }
      const connection = createWsConnection({
        shellyId,
        host,
        getCredentials: () => {
          const { deviceUsername, devicePassword } = getConfig();
          return { username: deviceUsername, password: devicePassword };
        },
        onStatus: (status) => {
          try {
            onStatus(shellyId, status);
          } catch (err) {
            logger.warn(`${shellyId}: failed to apply a pushed status: ${err.message}`);
          }
        },
        onConnectionChange: (connected) => {
          if (connected) {
            live.add(shellyId);
          } else {
            live.delete(shellyId);
          }
          onConnectionChange(shellyId, connected);
        },
        ...(WebSocketImpl ? { WebSocketImpl } : {}),
      });
      connections.set(shellyId, { connection, host });
    });
  }

  /**
   * Whether a device is currently pushing its changes to us.
   * @param {string} shellyId the Shelly device id
   * @returns {boolean} true when the WebSocket is up
   */
  function isLive(shellyId) {
    return live.has(shellyId);
  }

  /** Close every connection and stop reconnecting. */
  function stop() {
    connections.forEach((entry) => entry.connection.close());
    connections.clear();
    live.clear();
  }

  return { sync, isLive, stop, size: () => connections.size, liveCount: () => live.size };
}
