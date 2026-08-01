// -----------------------------------------------------------------------------
// Shelly device -> Gladys device model, and status payload -> feature states.
//
// One PHYSICAL Shelly becomes ONE Gladys device carrying every channel as
// features (a Pro 4PM is one device with four On/Off features, not four
// devices): the Shelly id identifies the hardware, so this is the mapping that
// keeps external ids stable when a user renames a channel or swaps a relay.
// -----------------------------------------------------------------------------

import {
  DEVICE_TYPE,
  MODEL_NAMES,
  PARAM_IP_ADDRESS,
  PARAM_SHELLY_GEN,
  PARAM_SHELLY_ID,
  PARAM_SHELLY_MODEL,
} from './constants.js';
import { buildFeatureSpecs, toGladysFeature } from './features.js';
import { buildDeviceSelector } from './selector.js';

/**
 * Friendly name of a device, in decreasing order of usefulness: the name the
 * user set in the Shelly app, then the commercial model name, then the raw
 * model id, then the Shelly id (always present).
 * @param {object} params naming inputs
 * @param {object} params.info the `/shelly` identity payload
 * @param {object} [params.config] the `Shelly.GetConfig` result
 * @returns {string} the device name
 */
export function buildDeviceName({ info, config }) {
  const userName = config?.sys?.device?.name || info?.name;
  if (typeof userName === 'string' && userName.trim() !== '') {
    return userName.trim();
  }
  return MODEL_NAMES[info?.model] || info?.model || info?.id || 'Shelly';
}

/**
 * Name of ONE feature, prefixed with the channel name when the user named it.
 *
 * On a multi-channel device this is the difference between four features all
 * called "On/Off" and four features called "Bathroom light On/Off": the prefix
 * is the only thing telling them apart in the Gladys UI.
 *
 * @param {object} spec the feature spec
 * @param {object} [config] the `Shelly.GetConfig` result
 * @param {number} channelCount number of channels of the spec family
 * @returns {string} the feature name
 */
function buildFeatureName(spec, config, channelCount) {
  const componentConfig = config?.[spec.componentKey];
  const channelName =
    typeof componentConfig?.name === 'string' && componentConfig.name.trim() !== ''
      ? componentConfig.name.trim()
      : undefined;
  if (channelName) {
    return `${channelName} — ${spec.name}`;
  }
  // No user-set name: only disambiguate when there is something to
  // disambiguate, so a single-channel plug keeps a clean "On/Off".
  if (channelCount > 1) {
    const [family, id] = spec.componentKey.split(':');
    return `${spec.name} (${family} ${id})`;
  }
  return spec.name;
}

/**
 * Build the Gladys device published at discovery.
 * @param {object} params device inputs
 * @param {object} params.info the `/shelly` identity payload
 * @param {object} params.status the `Shelly.GetStatus` result
 * @param {object} [params.config] the `Shelly.GetConfig` result
 * @param {string} [params.host] IP address or hostname the device answered on
 * @param {object} params.externalIds external id factory of this device
 * @returns {object} the Gladys device
 */
export function buildDevice({ info, status, config, host, externalIds }) {
  const specs = buildFeatureSpecs(status);

  // Count the channels per component family so single-channel devices keep
  // unsuffixed feature names.
  const channelsByFamily = new Map();
  specs.forEach((spec) => {
    const family = spec.componentKey.split(':')[0];
    const known = channelsByFamily.get(family) || new Set();
    known.add(spec.componentKey);
    channelsByFamily.set(family, known);
  });

  const name = buildDeviceName({ info, config });
  // Anchored on the Shelly id (which carries the MAC), so it is unique across
  // the installation AND reproduced identically on every re-discovery.
  const selector = buildDeviceSelector(name, info?.id);

  const features = specs.map((spec) => {
    const channelCount = channelsByFamily.get(spec.componentKey.split(':')[0])?.size || 1;
    return toGladysFeature(
      { ...spec, name: buildFeatureName(spec, config, channelCount) },
      externalIds.feature,
      selector,
    );
  });

  return {
    name,
    selector,
    external_id: externalIds.device,
    features,
    params: [
      // The IP is how the next poll reaches the device without re-running a
      // full mDNS scan; it is refreshed on every discovery, so a DHCP lease
      // change is healed by a re-scan.
      ...(host ? [{ name: PARAM_IP_ADDRESS, value: String(host) }] : []),
      { name: PARAM_SHELLY_ID, value: String(info?.id || '') },
      { name: PARAM_SHELLY_MODEL, value: String(info?.model || '') },
      { name: PARAM_SHELLY_GEN, value: String(info?.gen ?? '') },
    ],
  };
}

/**
 * Extract the feature states of one device from a fresh status payload.
 *
 * Values that cannot be read (component gone, field null on this hardware) are
 * dropped rather than published as 0: a missing measurement and a measurement
 * of zero mean very different things on an energy chart.
 *
 * @param {object} params extraction inputs
 * @param {object} params.status the `Shelly.GetStatus` result
 * @param {object} params.externalIds external id factory of this device
 * @returns {Array<{device_feature_external_id: string, state: number}>} the states
 */
export function buildStates({ status, externalIds }) {
  return buildFeatureSpecs(status)
    .map((spec) => {
      const componentStatus = status[spec.componentKey];
      const value = componentStatus == null ? undefined : spec.read(componentStatus);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
      }
      return { device_feature_external_id: externalIds.feature(spec.key), state: value };
    })
    .filter((state) => state !== undefined);
}

/**
 * Read the external ids of a device the user created in Gladys, back into the
 * platform id we need to reach it.
 * @param {object} device a Gladys device
 * @returns {string|undefined} the Shelly id, or undefined when unreadable
 */
export function readShellyId(device) {
  const fromParam = device?.params?.find((param) => param.name === PARAM_SHELLY_ID)?.value;
  if (fromParam) {
    return fromParam;
  }
  // Fallback for a device created before the param existed: the external id is
  // `ext:<selector>:device:<shelly id>`, and the Shelly id is its last segment.
  const parts = String(device?.external_id || '').split(':');
  return parts.length >= 4 && parts[2] === DEVICE_TYPE ? parts.slice(3).join(':') : undefined;
}

/**
 * Read the last known IP address of a device created in Gladys.
 * @param {object} device a Gladys device
 * @returns {string|undefined} the IP address, or undefined
 */
export function readHost(device) {
  return device?.params?.find((param) => param.name === PARAM_IP_ADDRESS)?.value || undefined;
}

/**
 * Read the hardware generation of a device created in Gladys.
 *
 * This is what routes a device to the right transport: Gen1 speaks REST with
 * Basic auth and has no WebSocket, Gen2+ speaks JSON-RPC with digest. Devices
 * created before the param existed are Gen2+ by construction — Gen1 was not
 * supported then — so that is the safe default.
 *
 * @param {object} device a Gladys device
 * @returns {number} the generation
 */
export function readGeneration(device) {
  const raw = device?.params?.find((param) => param.name === PARAM_SHELLY_GEN)?.value;
  const generation = Number.parseInt(raw, 10);
  return Number.isFinite(generation) && generation > 0 ? generation : 2;
}
