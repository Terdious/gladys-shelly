// -----------------------------------------------------------------------------
// Virtual components (`number:N`, `boolean:N`, `enum:N`): the metadata side.
//
// "Powered by Shelly" devices such as the LinkedGo ST1820 thermostat expose
// nothing from the classic vocabulary (`switch`, `em`, `temperature`…). They
// describe themselves through virtual components owned by `service:0`, and the
// status payload only carries the bare `value`. What the value MEANS — its
// name, unit, range, whether it is writable, its semantic role — lives in
// `Shelly.GetComponents`, which is what this module reads.
//
// The metadata refines features, it never decides whether they exist: the set
// of features (and so their external ids) is derived from the status document,
// exactly as for every other family. A device whose metadata could not be read
// keeps the same features and the same values, only with plainer names.
//
// One catch, seen on a real ST1820 (firmware 2.0.1): the components a SERVICE
// owns are left out of `Shelly.GetStatus` entirely. Only `service:0` shows up
// there, and the values live in `Shelly.GetComponents` alone. For such a device
// the status document is completed from `Shelly.GetComponents` before it is
// mapped (`hidesVirtualStatus` + `mergeVirtualStatus`), so the rest of the
// pipeline still sees one component-keyed document.
// -----------------------------------------------------------------------------

import { COMPONENT, GET_COMPONENTS_MAX_PAGES, VIRTUAL_FAMILIES } from './constants.js';

/**
 * Whether a component key belongs to a virtual family (`number:202`).
 * @param {string} componentKey a status / component key
 * @returns {boolean} true for `number:N`, `boolean:N` and `enum:N`
 */
export function isVirtualKey(componentKey) {
  const [family, rawId] = String(componentKey || '').split(':');
  return VIRTUAL_FAMILIES.includes(family) && rawId !== undefined;
}

/**
 * Whether a status payload carries any virtual component — i.e. whether it is
 * worth a `Shelly.GetComponents` round trip at all. A Pro 3EM never pays it.
 * @param {object} status a `Shelly.GetStatus` result
 * @returns {boolean} true when at least one virtual component is reported
 */
export function hasVirtualComponents(status) {
  return Boolean(status) && typeof status === 'object' && Object.keys(status).some(isVirtualKey);
}

/**
 * Whether a status payload comes from a device that runs a service (`service:N`)
 * but reports none of its virtual components, i.e. whose values can only be
 * read through `Shelly.GetComponents` (LinkedGo ST1820).
 * @param {object} status a `Shelly.GetStatus` result
 * @returns {boolean} true when the status must be completed before mapping
 */
export function hidesVirtualStatus(status) {
  if (!status || typeof status !== 'object') {
    return false;
  }
  const keys = Object.keys(status);
  return keys.some((key) => key.startsWith('service:')) && !keys.some(isVirtualKey);
}

/**
 * Add to a status document the virtual components it is missing, with the
 * `status` each one carries in `Shelly.GetComponents`. A component already in
 * the status is left alone: `Shelly.GetStatus` stays the reference.
 * @param {object} status the `Shelly.GetStatus` result
 * @param {Record<string, {status?: object}>} [components] what `fetchVirtualComponents` read
 * @returns {object} the completed status (a new object when anything was added)
 */
export function mergeVirtualStatus(status, components) {
  const missing = Object.entries(components || {}).filter(
    ([key, component]) =>
      !(key in (status || {})) && component?.status && typeof component.status === 'object',
  );
  if (missing.length === 0) {
    return status;
  }
  return {
    ...status,
    ...Object.fromEntries(missing.map(([key, component]) => [key, component.status])),
  };
}

/**
 * Read the metadata of every virtual component of one device.
 *
 * `Shelly.GetComponents` is PAGINATED: an ST1820 reports `total: 15` and
 * answers the first call with 10 entries. Reading one page silently loses a
 * third of the device, so this loops on `offset` until the device has handed
 * everything over.
 *
 * `dynamic_only` is deliberately not used: it filters on how a component was
 * created, and the components a service owns are not guaranteed to count as
 * dynamic — losing the thermostat setpoint to save a few hundred bytes once
 * per scan is a bad trade.
 *
 * Each entry keeps the `status` the device served along with it: for a device
 * that hides its virtual components from `Shelly.GetStatus`, that is the only
 * place the values can be read.
 *
 * @param {(method: string, params?: object) => Promise<object>} call RPC call on the device
 * @returns {Promise<Record<string, {config: object, attrs: object, status?: object}>>} metadata per component key
 */
export async function fetchVirtualComponents(call) {
  const components = {};
  let offset = 0;
  for (let page = 0; page < GET_COMPONENTS_MAX_PAGES; page += 1) {
    const result = await call('Shelly.GetComponents', {
      offset,
      include: ['config', 'status'],
    });
    const list = Array.isArray(result?.components) ? result.components : [];
    list.forEach((component) => {
      if (isVirtualKey(component?.key)) {
        components[component.key] = {
          config: component.config || {},
          attrs: component.attrs || {},
          ...(component.status ? { status: component.status } : {}),
        };
      }
    });

    // Trust the offset the device says it served over our own counter: it is
    // what `total` is measured against.
    const servedFrom = Number.isFinite(result?.offset) ? result.offset : offset;
    offset = servedFrom + list.length;
    const total = Number(result?.total);
    if (list.length === 0 || !Number.isFinite(total) || offset >= total) {
      break;
    }
  }
  return components;
}

/**
 * Merge the two sources of virtual-component metadata into one map.
 *
 * `Shelly.GetComponents` is the complete one (it alone carries `attrs.role`);
 * `Shelly.GetConfig` carries the same `config` objects without the role, and is
 * read at every discovery anyway. Falling back to it keeps names, ranges and
 * access when the paginated read failed.
 *
 * @param {object} status the `Shelly.GetStatus` result
 * @param {Record<string, object>} [components] metadata from `Shelly.GetComponents`
 * @param {object} [deviceConfig] the `Shelly.GetConfig` result
 * @returns {Record<string, {config: object, attrs: object}>} metadata per virtual key
 */
export function mergeVirtualMetadata(status, components, deviceConfig) {
  const merged = {};
  Object.keys(status || {})
    .filter(isVirtualKey)
    .forEach((key) => {
      if (components?.[key]) {
        merged[key] = components[key];
      } else if (deviceConfig?.[key] && typeof deviceConfig[key] === 'object') {
        merged[key] = { config: deviceConfig[key], attrs: {} };
      }
    });
  return merged;
}

/**
 * Whether a virtual component accepts writes, from its declared `access`
 * (`"crw"` on the ST1820 setpoint). Unknown access is treated as read-only: a
 * control the device then refuses is worse than a value shown without one.
 * @param {object} [config] the component config
 * @returns {boolean} true when `access` contains `w`
 */
export function isWritableConfig(config) {
  return typeof config?.access === 'string' && config.access.includes('w');
}

/**
 * Number of decimals of a step (`0.5` -> 1), so a rounded value does not come
 * out as 21.500000000000004.
 * @param {number} step the step
 * @returns {number} the decimals to keep
 */
function stepDecimals(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Turn a value requested from Gladys into the one sent to `Number.Set`:
 * clamped to the declared range and snapped to the declared step. A slider in
 * Gladys does not know the device only takes half degrees, and a device
 * answering an out-of-range value with an RPC error would leave the setpoint
 * wherever it was, with no clue for the user.
 *
 * @param {number} value requested value
 * @param {object} limits the limits to apply
 * @param {number} [limits.min] lowest accepted value
 * @param {number} [limits.max] highest accepted value
 * @param {number} [limits.step] value granularity
 * @returns {number} the value to send
 */
export function prepareNumberValue(value, { min, max, step } = {}) {
  const clamp = (candidate) => {
    let result = candidate;
    if (Number.isFinite(min)) {
      result = Math.max(min, result);
    }
    if (Number.isFinite(max)) {
      result = Math.min(max, result);
    }
    return result;
  };

  let result = clamp(value);
  if (Number.isFinite(step) && step > 0) {
    result = Number((Math.round(result / step) * step).toFixed(stepDecimals(step)));
    // A range whose bounds are off the step grid could be overshot by the
    // rounding: the range wins, it is what the device enforces.
    result = clamp(result);
  }
  return result;
}

/** RPC method that writes each writable virtual family. */
export const VIRTUAL_SET_METHOD = {
  [COMPONENT.NUMBER]: 'Number.Set',
  [COMPONENT.BOOLEAN]: 'Boolean.Set',
};
