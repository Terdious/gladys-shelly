// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
//   - `turn_on_for`: switch a relay or a light on, and let the DEVICE switch it
//     back off after the duration (`toggle_after` on Gen2+, `timer` on Gen1).
//     The timer lives in the Shelly, so a Gladys restart, a scene cancelled or
//     a network drop in between never leaves the pump or the heater running;
//   - `reboot`: restart a device (`Shelly.Reboot`, Gen1 `/reboot`), the usual
//     cure for a Shelly that stopped pushing after a Wi-Fi change.
//
// index.js registers each handler with `gladys.onSceneAction(key, ...)`. The
// fields arrive resolved and validated by the core; throwing fails this action
// only, the scene goes on. Keys and outputs are stored in the users' scenes:
// never rename them.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

import { COMPONENT } from './shelly/constants.js';
import { readGeneration, readHost, readShellyId } from './shelly/deviceMapping.js';
import { parseFeatureKey } from './shelly/setValue.js';

/** Bounds of the `turn_on_for` duration, in seconds (one day at most). */
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 86400;

/**
 * Find a created device by the external id a scene field carries.
 * @param {object} gladys the SDK instance
 * @param {string} externalId the device external id
 * @returns {Promise<object>} the device
 */
async function deviceOf(gladys, externalId) {
  const device = ((await gladys.getDevices()) || []).find(
    (candidate) => candidate.external_id === externalId,
  );
  if (!device || !readShellyId(device)) {
    throw new Error(`Unknown Shelly device: ${externalId}`);
  }
  return device;
}

/**
 * The on/off output of a device at a channel: a relay if it has one there,
 * else a light (a dimmer has no `switch:N`).
 * @param {object} device a Gladys device
 * @param {number} channel the output index
 * @returns {{family: string, feature: object}|undefined} the output
 */
export function outputOf(device, channel) {
  const outputs = (device.features || [])
    .map((feature) => ({ feature, key: parseFeatureKey(feature.external_id) }))
    .filter(({ key }) => key && key.suffix === 'binary' && key.index === channel);
  const order = [COMPONENT.SWITCH, COMPONENT.LIGHT, COMPONENT.RGB, COMPONENT.RGBW, COMPONENT.CCT];
  for (const family of order) {
    const match = outputs.find(({ key }) => key.family === family);
    if (match) {
      return { family, feature: match.feature };
    }
  }
  return undefined;
}

/** RPC namespace of each on/off family. */
const SET_METHODS = {
  [COMPONENT.SWITCH]: 'Switch.Set',
  [COMPONENT.LIGHT]: 'Light.Set',
  [COMPONENT.RGB]: 'RGB.Set',
  [COMPONENT.RGBW]: 'RGBW.Set',
  [COMPONENT.CCT]: 'CCT.Set',
};

/**
 * Build the scene action handlers.
 * @param {object} deps runtime modules ({ gladys, client })
 * @returns {Record<string, (fields: object) => Promise<object>>} handlers by action key
 */
export function createSceneActions({ gladys, client }) {
  return {
    async turn_on_for(fields = {}) {
      const device = await deviceOf(gladys, String(fields.device || ''));
      const channel = Math.max(0, Math.round(Number(fields.channel ?? 0)) || 0);
      const seconds = Math.round(Number(fields.duration));
      if (
        !Number.isFinite(seconds) ||
        seconds < MIN_DURATION_SECONDS ||
        seconds > MAX_DURATION_SECONDS
      ) {
        throw new Error(
          `Duration must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} s`,
        );
      }
      const output = outputOf(device, channel);
      if (!output) {
        throw new Error(`${device.name} has no on/off output ${channel}`);
      }
      const gen1Base =
        output.family === COMPONENT.SWITCH
          ? `/relay/${channel}`
          : output.family === COMPONENT.RGBW
            ? `/color/${channel}`
            : `/light/${channel}`;
      const command = {
        rpc: {
          method: SET_METHODS[output.family],
          params: { id: channel, on: true, toggle_after: seconds },
        },
        gen1: `${gen1Base}?turn=on&timer=${seconds}`,
        // No cloud spelling: the Cloud Control API has no timer, and a plain
        // "on" without the device-side timer is exactly what this action avoids.
        state: 1,
        label: `on for ${seconds} s`,
      };
      const transport = await client.sendCommand(
        { shellyId: readShellyId(device), host: readHost(device), gen: readGeneration(device) },
        command,
      );
      logger.info(
        `Scene: ${readShellyId(device)} ${output.family}:${channel} on for ${seconds} s (over ${transport})`,
      );
      await gladys.publishState(output.feature.external_id, 1).catch(() => {});
      return { transport };
    },

    async reboot(fields = {}) {
      const device = await deviceOf(gladys, String(fields.device || ''));
      const transport = await client.sendCommand(
        { shellyId: readShellyId(device), host: readHost(device), gen: readGeneration(device) },
        {
          rpc: { method: 'Shelly.Reboot', params: {} },
          gen1: '/reboot',
          state: 0,
          label: 'reboot',
        },
      );
      logger.info(`Scene: ${readShellyId(device)} rebooting (over ${transport})`);
      return { transport };
    },
  };
}
