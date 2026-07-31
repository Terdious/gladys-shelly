// -----------------------------------------------------------------------------
// Command routing: the user actions a feature in Gladys -> the device moves.
//
// The feature external id carries everything needed to route the command —
// `ext:shelly:device:<shelly id>:switch:0:binary` — so no lookup table has to
// be kept in sync with discovery. `parseFeatureKey` is the single parser, and
// the tests pin its behaviour.
//
// The Gladys contract: resolving acks the command as a success, throwing acks
// it as a failure. So a command that could not be delivered MUST throw — a
// silently swallowed error would leave a switch showing the wrong state.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

import { readHost, readShellyId } from './deviceMapping.js';
import { COMPONENT } from './constants.js';

/**
 * Parse the component coordinates out of a feature external id.
 *
 * The id is `ext:<selector>:device:<shelly id>:<family>:<index>:<suffix>`, and
 * the Shelly id itself never contains a colon — so the LAST three segments are
 * always the component family, its index and the feature suffix.
 *
 * @param {string} externalId the feature external id
 * @returns {{family: string, index: number, suffix: string}|undefined} the coordinates
 */
export function parseFeatureKey(externalId) {
  const parts = String(externalId || '').split(':');
  if (parts.length < 3) {
    return undefined;
  }
  const [family, rawIndex, suffix] = parts.slice(-3);
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isFinite(index) || !family || !suffix) {
    return undefined;
  }
  return { family, index, suffix };
}

/**
 * Apply a value the user set on a feature.
 * @param {object} deps injected dependencies
 * @param {object} deps.gladys the SDK instance
 * @param {object} deps.client the transport router
 * @param {object} command the command
 * @param {object} command.device the Gladys device
 * @param {object} command.feature the Gladys device feature
 * @param {number} command.value the requested value
 * @returns {Promise<void>} resolves once the device acknowledged the command
 */
export async function setDeviceValue({ gladys, client }, { device, feature, value }) {
  const shellyId = readShellyId(device);
  if (!shellyId) {
    throw new Error(`Cannot resolve the Shelly id of device ${device?.external_id}`);
  }

  const parsed = parseFeatureKey(feature?.external_id);
  if (!parsed) {
    throw new Error(`Unsupported feature external id: ${feature?.external_id}`);
  }

  const { family, index, suffix } = parsed;
  if (family !== COMPONENT.SWITCH || suffix !== 'binary') {
    // Everything else discovered today is a read-only measurement; a writable
    // family added later gets its branch here.
    throw new Error(`Feature ${feature.external_id} is not controllable`);
  }

  const target = { shellyId, host: readHost(device) };
  const on = Number(value) === 1;
  const transport = await client.setSwitch(target, index, on);
  logger.info(`${shellyId} switch:${index} -> ${on ? 'on' : 'off'} (over ${transport})`);

  // Optimistic feedback: the poll loop confirms the real state on the next
  // cycle, but the user must see the switch move NOW, not in 30 seconds.
  await gladys.publishState(feature.external_id, on ? 1 : 0);
}
