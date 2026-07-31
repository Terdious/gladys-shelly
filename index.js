// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the Shelly modules (src/shelly/). It holds
// NO Shelly logic — the RPC protocol lives in src/shelly/rpc.js, the transport
// policy in src/shelly/client.js, the device model in src/shelly/features.js.
// This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. reports the connection status on the Configuration screen.
//
// The wiring is exported as `setupIntegration(gladys, deps)` so the e2e test
// exercises the REAL wiring instead of duplicating it; the singleton bootstrap
// below only runs when the file is the process entry point (the container).
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { isCloudConfigured, normalizeConfig } from './src/config.js';
import { createCloudClient, ShellyCloudAuthError } from './src/shelly/cloudClient.js';
import { createShellyClient } from './src/shelly/client.js';
import { createTelemetry } from './src/shelly/telemetry.js';
import { setDeviceValue } from './src/shelly/setValue.js';
import { CONNECTION_MESSAGES } from './src/shelly/constants.js';

/**
 * Report the application-level connection status of the integration.
 * Defensive: an older Gladys core without the endpoint must never crash the
 * integration, so failures are only logged.
 * @param {object} gladys the SDK instance
 * @param {boolean} connected whether the integration considers itself working
 * @param {object} [message] multi-language message shown to the user
 */
async function reportConnectionStatus(gladys, connected, message) {
  try {
    await gladys.setConnectionStatus(connected, message);
  } catch (err) {
    logger.debug(`setConnectionStatus skipped (older Gladys core?): ${err.message}`);
  }
}

/**
 * Wire every SDK handler on the given instance.
 * @param {GladysIntegration} gladys SDK instance
 * @param {object} [deps] injectable dependencies (tests)
 * @param {typeof fetch} [deps.fetchImpl] fetch used for Shelly devices and cloud
 * @returns {{client: object, cloud: object, telemetry: object, getConfig: () => object}} the wired modules
 */
export function setupIntegration(gladys, { fetchImpl = fetch } = {}) {
  // Current configuration (hot-reloaded via onConfigUpdated).
  let config = normalizeConfig();

  const cloud = createCloudClient({ getConfig: () => config, fetchImpl });
  const client = createShellyClient({ getConfig: () => config, cloud, fetchImpl });
  const telemetry = createTelemetry({
    gladys,
    client,
    getConfig: () => config,
    fetchImpl,
  });

  /**
   * Reflect the real state of the integration on the Configuration screen and
   * make sure the refresh loop matches the current configuration.
   *
   * A Shelly setup has no "log in" step: a purely local install is fully
   * functional with an EMPTY form. So the status here answers a different
   * question than in a cloud integration — not "are you authenticated" but
   * "which channels are actually usable right now".
   */
  async function syncConnection() {
    telemetry.start();

    if (!config.cloudEnabled) {
      await reportConnectionStatus(gladys, true, CONNECTION_MESSAGES.LOCAL_ONLY);
      return;
    }

    if (!isCloudConfigured(config)) {
      // Enabling the toggle without the credentials is a half-finished setup:
      // local still works, so stay "connected" but say what is missing.
      logger.warn('Shelly Cloud enabled but the server or the authorization key is missing');
      await reportConnectionStatus(gladys, true, CONNECTION_MESSAGES.CLOUD_INCOMPLETE);
      return;
    }

    try {
      const deviceCount = await cloud.checkCredentials();
      logger.info(`Shelly Cloud reachable: ${deviceCount} device(s) visible on the account`);
      await reportConnectionStatus(gladys, true, CONNECTION_MESSAGES.LOCAL_AND_CLOUD);
    } catch (err) {
      if (err instanceof ShellyCloudAuthError) {
        logger.error(`Shelly Cloud rejected the authorization key: ${err.message}`);
        await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.CLOUD_REJECTED);
        return;
      }
      // The cloud being down does not break a local install: keep going, the
      // per-device badges will show what is actually reachable.
      logger.warn(`Shelly Cloud unreachable (${err.message}) — local transport still active`);
      await reportConnectionStatus(gladys, true, CONNECTION_MESSAGES.LOCAL_ONLY);
    }
  }

  // --- Discovery: Gladys asks for the list of devices ------------------------
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> scanning the network for Shelly devices');
    const devices = await telemetry.syncDiscovery();
    if (devices.length === 0) {
      await reportConnectionStatus(gladys, true, CONNECTION_MESSAGES.NO_DEVICE_YET);
    }
  });

  // --- Command: the user acts on a controllable feature ----------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await setDeviceValue({ gladys, client }, { device, feature, value });
  });

  // --- Poll: the Gladys scheduler asks to refresh one device -----------------
  // The integration runs its own global loop, so a poll request is just an
  // invitation to refresh sooner; refreshing everything is cheaper than
  // building a one-device path that would duplicate the dedup bookkeeping.
  gladys.onPoll(async () => {
    await telemetry.refreshValues();
  });

  // --- Configuration updated by the user -------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    const previous = config;
    config = normalizeConfig(newConfig);

    // Credentials or addresses changed: the cached RPC clients hold a stale
    // digest challenge and a stale password, so drop them.
    if (
      previous.deviceUsername !== config.deviceUsername ||
      previous.devicePassword !== config.devicePassword
    ) {
      client.reset();
    }

    await syncConnection();

    // Adding an address by hand is the user saying "find this device": run the
    // discovery for them instead of making them click Scan afterwards.
    const hostsChanged = previous.manualHosts.join(',') !== config.manualHosts.join(',');
    if (hostsChanged) {
      logger.info('Manual addresses changed -> re-running the discovery');
      await telemetry.syncDiscovery();
    }
  });

  // --- Connection lifecycle --------------------------------------------------
  gladys.on('connected', async () => {
    logger.info('WebSocket connected to Gladys');
    try {
      config = normalizeConfig(await gladys.getConfig());
      await syncConnection();
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
    }
  });

  gladys.on('disconnected', () => {
    logger.warn('WebSocket disconnected - the SDK will try to reconnect');
    telemetry.stop();
  });

  return { client, cloud, telemetry, getConfig: () => config };
}

// --- Startup (container entry point only) ------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const gladys = new GladysIntegration();
  const { telemetry } = setupIntegration(gladys);

  // The SDK disconnects cleanly and exits with code 0 when the supervisor
  // stops the container (SIGTERM/SIGINT).
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    telemetry.stop();
  });

  logger.info('Starting the Shelly integration...');
  gladys.connect().catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
}
