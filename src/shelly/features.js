// -----------------------------------------------------------------------------
// Shelly component -> Gladys feature mapping.
//
// ONE table drives BOTH sides of the integration:
//   - discovery, which turns a spec into a Gladys feature descriptor;
//   - telemetry, which calls the spec `read()` on a fresh status payload.
// Keeping them in a single place is what stops the classic drift where a
// feature is published but never fed (or fed under a suffix nobody declared).
//
// The feature suffixes are part of the contract with Gladys: a feature is
// matched by its `external_id`, so renaming a suffix RE-CREATES the feature on
// every existing install and orphans its history. Suffixes below are FROZEN.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import { COMPONENT, EM_PHASES } from './constants.js';
import { featureName } from './featureNames.js';
import { buildFeatureSelector } from './selector.js';

/**
 * Round a number to a fixed number of decimals, passing through anything that
 * is not a finite number (Shelly sends `null` for an unmeasured channel, e.g.
 * `n_current` on a meter without a neutral clamp).
 * @param {unknown} value raw value
 * @param {number} decimals number of decimals to keep
 * @returns {number|undefined} the rounded value, or undefined when unusable
 */
function round(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Read a nested property without throwing on a missing intermediate object.
 * @param {object} source object to read from
 * @param {string[]} path property path
 * @returns {unknown} the value, or undefined
 */
function get(source, path) {
  return path.reduce((current, key) => (current == null ? undefined : current[key]), source);
}

/** Watt-hours -> kilowatt-hours, the unit Gladys energy features use. */
function toKilowattHours(wattHours) {
  return round(typeof wattHours === 'number' ? wattHours / 1000 : undefined, 3);
}

/**
 * Build the feature specs of a `switch:N` component (relays and smart plugs).
 * Power/energy metering is optional on the hardware (a Pro 1 has none, a
 * Pro 1PM has all of it), so the caller filters the specs against the keys the
 * device actually reports.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function switchSpecs(id) {
  const prefix = `${COMPONENT.SWITCH}:${id}`;
  return [
    {
      key: `${prefix}:binary`,
      nameKey: 'on_off',
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      // `output` is the only field guaranteed on every switch: it is what
      // decides whether the component exists at all.
      required: 'output',
      read: (status) => (status.output ? 1 : 0),
    },
    {
      key: `${prefix}:power`,
      // Real-time lane: the value a control scene reacts to (battery steering,
      // load shedding). See STATE_RATE_LIMIT_PER_MINUTE in telemetry.js.
      realtime: true,
      nameKey: 'power',
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: -30000,
      max: 30000,
      required: 'apower',
      read: (status) => round(status.apower, 1),
    },
    {
      key: `${prefix}:voltage`,
      nameKey: 'voltage',
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      max: 500,
      required: 'voltage',
      read: (status) => round(status.voltage, 1),
    },
    {
      key: `${prefix}:current`,
      nameKey: 'current',
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 100,
      required: 'current',
      read: (status) => round(status.current, 3),
    },
    {
      key: `${prefix}:energy`,
      nameKey: 'total_energy',
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 1000000,
      required: 'aenergy',
      read: (status) => toKilowattHours(get(status, ['aenergy', 'total'])),
    },
    {
      key: `${prefix}:temperature`,
      nameKey: 'internal_temperature',
      category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: -30,
      max: 150,
      required: 'temperature',
      read: (status) => round(get(status, ['temperature', 'tC']), 1),
    },
  ];
}

/**
 * Build the feature specs of an `em:N` component: the instantaneous values of
 * a three-phase energy meter (Shelly Pro 3EM).
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function emSpecs(id) {
  const prefix = `${COMPONENT.EM}:${id}`;
  const perPhase = EM_PHASES.flatMap(({ prefix: p, label }) => [
    {
      key: `${prefix}:${label}_active_power`,
      // Real-time lane: on a three-phase meter the per-phase power is what a
      // human actually watches, and what a per-phase load-shedding scene reacts
      // to. Leaving it on the 30 s cycle while the total refreshes every 5 s is
      // what made the same device look fast and slow at the same time.
      realtime: true,
      nameKey: 'active_power',
      phase: label.toUpperCase(),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: -30000,
      max: 30000,
      required: `${p}_act_power`,
      read: (status) => round(status[`${p}_act_power`], 1),
    },
    {
      key: `${prefix}:${label}_apparent_power`,
      nameKey: 'apparent_power',
      phase: label.toUpperCase(),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.VOLT_AMPERE,
      min: 0,
      max: 30000,
      required: `${p}_aprt_power`,
      read: (status) => round(status[`${p}_aprt_power`], 1),
    },
    {
      key: `${prefix}:${label}_voltage`,
      nameKey: 'voltage',
      phase: label.toUpperCase(),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      max: 500,
      required: `${p}_voltage`,
      read: (status) => round(status[`${p}_voltage`], 1),
    },
    {
      key: `${prefix}:${label}_current`,
      nameKey: 'current',
      phase: label.toUpperCase(),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 1000,
      required: `${p}_current`,
      read: (status) => round(status[`${p}_current`], 3),
    },
  ]);

  return [
    ...perPhase,
    {
      key: `${prefix}:total_active_power`,
      // Real-time lane: the value a control scene reacts to (battery steering,
      // load shedding). See STATE_RATE_LIMIT_PER_MINUTE in telemetry.js.
      realtime: true,
      nameKey: 'total_active_power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: -90000,
      max: 90000,
      required: 'total_act_power',
      read: (status) => round(status.total_act_power, 1),
    },
    {
      key: `${prefix}:total_apparent_power`,
      nameKey: 'total_apparent_power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.VOLT_AMPERE,
      min: 0,
      max: 90000,
      required: 'total_aprt_power',
      read: (status) => round(status.total_aprt_power, 1),
    },
    {
      key: `${prefix}:total_current`,
      nameKey: 'total_current',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 3000,
      required: 'total_current',
      read: (status) => round(status.total_current, 3),
    },
    {
      key: `${prefix}:neutral_current`,
      nameKey: 'neutral_current',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 1000,
      // Present in the payload but `null` unless a neutral clamp is wired:
      // `requiredNonNull` keeps the feature out of the device entirely rather
      // than publishing a permanently empty chart.
      required: 'n_current',
      requiredNonNull: true,
      read: (status) => round(status.n_current, 3),
    },
  ];
}

/**
 * Build the feature specs of an `emdata:N` component: the cumulated energy
 * counters of a three-phase meter.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function emDataSpecs(id) {
  const prefix = `${COMPONENT.EMDATA}:${id}`;
  const perPhase = EM_PHASES.flatMap(({ prefix: p, label }) => [
    {
      key: `${prefix}:${label}_total_energy`,
      nameKey: 'total_energy',
      phase: label.toUpperCase(),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: `${p}_total_act_energy`,
      read: (status) => toKilowattHours(status[`${p}_total_act_energy`]),
    },
    {
      key: `${prefix}:${label}_total_returned_energy`,
      nameKey: 'total_returned_energy',
      phase: label.toUpperCase(),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: `${p}_total_act_ret_energy`,
      read: (status) => toKilowattHours(status[`${p}_total_act_ret_energy`]),
    },
  ]);

  return [
    ...perPhase,
    {
      key: `${prefix}:total_energy`,
      nameKey: 'total_energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: 'total_act',
      read: (status) => toKilowattHours(status.total_act),
    },
    {
      key: `${prefix}:total_returned_energy`,
      nameKey: 'total_returned_energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: 'total_act_ret',
      read: (status) => toKilowattHours(status.total_act_ret),
    },
  ];
}

/**
 * Build the feature specs of an `em1:N` component: one phase of a single-phase
 * energy meter (Shelly Pro EM, 1PM Mini Gen3…).
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function em1Specs(id) {
  const prefix = `${COMPONENT.EM1}:${id}`;
  return [
    {
      key: `${prefix}:active_power`,
      // Real-time lane: the value a control scene reacts to (battery steering,
      // load shedding). See STATE_RATE_LIMIT_PER_MINUTE in telemetry.js.
      realtime: true,
      nameKey: 'active_power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: -30000,
      max: 30000,
      required: 'act_power',
      read: (status) => round(status.act_power, 1),
    },
    {
      key: `${prefix}:apparent_power`,
      nameKey: 'apparent_power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.VOLT_AMPERE,
      min: 0,
      max: 30000,
      required: 'aprt_power',
      read: (status) => round(status.aprt_power, 1),
    },
    {
      key: `${prefix}:voltage`,
      nameKey: 'voltage',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      max: 500,
      required: 'voltage',
      read: (status) => round(status.voltage, 1),
    },
    {
      key: `${prefix}:current`,
      nameKey: 'current',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 1000,
      required: 'current',
      read: (status) => round(status.current, 3),
    },
  ];
}

/**
 * Build the feature specs of an `em1data:N` component: the cumulated counters
 * of one phase of a single-phase meter.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function em1DataSpecs(id) {
  const prefix = `${COMPONENT.EM1DATA}:${id}`;
  return [
    {
      key: `${prefix}:total_energy`,
      nameKey: 'total_energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: 'total_act_energy',
      read: (status) => toKilowattHours(status.total_act_energy),
    },
    {
      key: `${prefix}:total_returned_energy`,
      nameKey: 'total_returned_energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: 'total_act_ret_energy',
      read: (status) => toKilowattHours(status.total_act_ret_energy),
    },
  ];
}

/**
 * Build the feature specs of a `pm1:N` component: a standalone power meter
 * (Shelly PM Mini), which reports both instantaneous values and counters.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function pm1Specs(id) {
  const prefix = `${COMPONENT.PM1}:${id}`;
  return [
    {
      key: `${prefix}:active_power`,
      // Real-time lane: the value a control scene reacts to (battery steering,
      // load shedding). See STATE_RATE_LIMIT_PER_MINUTE in telemetry.js.
      realtime: true,
      nameKey: 'active_power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: -30000,
      max: 30000,
      required: 'apower',
      read: (status) => round(status.apower, 1),
    },
    {
      key: `${prefix}:voltage`,
      nameKey: 'voltage',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      max: 500,
      required: 'voltage',
      read: (status) => round(status.voltage, 1),
    },
    {
      key: `${prefix}:current`,
      nameKey: 'current',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 1000,
      required: 'current',
      read: (status) => round(status.current, 3),
    },
    {
      key: `${prefix}:energy`,
      nameKey: 'total_energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100000000,
      required: 'aenergy',
      read: (status) => toKilowattHours(get(status, ['aenergy', 'total'])),
    },
  ];
}

/**
 * Build the feature spec of a `temperature:N` sensor component.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function temperatureSpecs(id) {
  return [
    {
      key: `${COMPONENT.TEMPERATURE}:${id}:temperature`,
      nameKey: 'temperature',
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: -50,
      max: 150,
      required: 'tC',
      requiredNonNull: true,
      read: (status) => round(status.tC, 1),
    },
  ];
}

/**
 * Build the feature spec of a `humidity:N` sensor component.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function humiditySpecs(id) {
  return [
    {
      key: `${COMPONENT.HUMIDITY}:${id}:humidity`,
      nameKey: 'humidity',
      category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      required: 'rh',
      requiredNonNull: true,
      read: (status) => round(status.rh, 1),
    },
  ];
}

/**
 * Build the feature spec of a `devicepower:N` component: the battery level of
 * a battery-powered device.
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function devicePowerSpecs(id) {
  return [
    {
      key: `${COMPONENT.DEVICEPOWER}:${id}:battery`,
      nameKey: 'battery',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      required: 'battery',
      read: (status) => round(get(status, ['battery', 'percent']), 0),
    },
  ];
}

/**
 * Metering specs shared by the cover and light components, which report the
 * same `apower` / `voltage` / `current` / `aenergy` / `temperature` fields as a
 * `switch:N`. They sit in neutral measurement categories: a shutter has no
 * power type of its own in Gladys, and a light keeps only its `power` there.
 * @param {string} prefix component key, e.g. `cover:0`
 * @param {object} [options] mapping options
 * @param {boolean} [options.lightPower] map the power to `light` / `power`
 * @returns {object[]} the feature specs
 */
function meteringSpecs(prefix, { lightPower = false } = {}) {
  return [
    {
      key: `${prefix}:power`,
      realtime: true,
      nameKey: 'power',
      category: lightPower
        ? DEVICE_FEATURE_CATEGORIES.LIGHT
        : DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: lightPower
        ? DEVICE_FEATURE_TYPES.LIGHT.POWER
        : DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: 30000,
      required: 'apower',
      read: (status) => round(status.apower, 1),
    },
    {
      key: `${prefix}:voltage`,
      nameKey: 'voltage',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      max: 500,
      required: 'voltage',
      read: (status) => round(status.voltage, 1),
    },
    {
      key: `${prefix}:current`,
      nameKey: 'current',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 100,
      required: 'current',
      read: (status) => round(status.current, 3),
    },
    {
      key: `${prefix}:energy`,
      nameKey: 'total_energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 1000000,
      required: 'aenergy',
      read: (status) => toKilowattHours(get(status, ['aenergy', 'total'])),
    },
    {
      key: `${prefix}:temperature`,
      nameKey: 'internal_temperature',
      category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: -30,
      max: 150,
      required: 'temperature',
      read: (status) => round(get(status, ['temperature', 'tC']), 1),
    },
  ];
}

/**
 * Shelly cover state -> Gladys shutter state (COVER_STATE: 1 open, -1 close,
 * 0 stop). A moving cover reports its direction, which is what the Gladys
 * shutter control highlights; `calibrating` has no Gladys equivalent and is
 * left unpublished rather than guessed.
 */
export const COVER_STATE_VALUES = {
  open: 1,
  opening: 1,
  closed: -1,
  closing: -1,
  stopped: 0,
};

/**
 * Build the feature specs of a `cover:N` component (roller shutters, Plus/Pro
 * 2PM in cover mode, Gen1 2.5 in roller mode).
 *
 * The position only exists on a CALIBRATED cover: `pos_control: false` or a
 * missing `current_pos` drops it, as no command could ever drive it. Shelly
 * and Gladys agree on the direction (100 = fully open), pinned by a test.
 *
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function coverSpecs(id) {
  const prefix = `${COMPONENT.COVER}:${id}`;
  return [
    {
      key: `${prefix}:state`,
      nameKey: 'shutter',
      category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
      type: DEVICE_FEATURE_TYPES.SHUTTER.STATE,
      min: -1,
      max: 1,
      read_only: false,
      has_feedback: true,
      required: 'state',
      read: (status) => COVER_STATE_VALUES[status.state],
    },
    {
      key: `${prefix}:position`,
      nameKey: 'position',
      category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
      type: DEVICE_FEATURE_TYPES.SHUTTER.POSITION,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      required: 'current_pos',
      present: (status) => status.pos_control !== false && typeof status.current_pos === 'number',
      read: (status) => round(status.current_pos, 0),
    },
    ...meteringSpecs(prefix),
  ];
}

/** Colour temperature range of the Shelly CCT outputs, in kelvin. */
export const CCT_MIN_KELVIN = 2700;
export const CCT_MAX_KELVIN = 6500;

/**
 * Kelvin <-> mired. Gladys light temperatures are mireds (the zigbee2mqtt and
 * Hue convention, 153 = cold, 500 = warm); Shelly speaks kelvin.
 * @param {number} value a temperature in one unit
 * @returns {number|undefined} the temperature in the other unit
 */
export function kelvinToMired(value) {
  return typeof value === 'number' && value > 0 ? Math.round(1000000 / value) : undefined;
}
export const miredToKelvin = kelvinToMired;

/**
 * `[r, g, b]` (0-255 each) -> the integer Gladys stores for a colour
 * (`0xRRGGBB`), and back.
 * @param {unknown} rgb the Shelly colour array
 * @returns {number|undefined} the integer colour
 */
export function rgbToInt(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3 || rgb.some((c) => typeof c !== 'number')) {
    return undefined;
  }
  const [r, g, b] = rgb.map((c) => Math.min(Math.max(Math.round(c), 0), 255));
  return r * 65536 + g * 256 + b;
}

/**
 * @param {number} value the integer colour (`0xRRGGBB`)
 * @returns {number[]} the Shelly `[r, g, b]` array
 */
export function intToRgb(value) {
  const color = Math.min(Math.max(Math.round(Number(value) || 0), 0), 0xffffff);
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

/**
 * Build the feature specs of a light output: `light:N` (dimmers), `rgb:N`,
 * `rgbw:N` (colour) and `cct:N` (tunable white). They share on/off, brightness
 * and metering; colour and colour temperature only exist on their family.
 * @param {string} family component family
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function lightSpecs(family, id) {
  const prefix = `${family}:${id}`;
  const specs = [
    {
      key: `${prefix}:binary`,
      nameKey: 'on_off',
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      required: 'output',
      read: (status) => (status.output ? 1 : 0),
    },
    {
      key: `${prefix}:brightness`,
      nameKey: 'brightness',
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BRIGHTNESS,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      required: 'brightness',
      requiredNonNull: true,
      read: (status) => round(status.brightness, 0),
    },
  ];
  if (family === COMPONENT.RGB || family === COMPONENT.RGBW) {
    specs.push({
      key: `${prefix}:color`,
      nameKey: 'color',
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.COLOR,
      min: 0,
      max: 16777215,
      read_only: false,
      has_feedback: true,
      required: 'rgb',
      requiredNonNull: true,
      read: (status) => rgbToInt(status.rgb),
    });
  }
  if (family === COMPONENT.CCT) {
    specs.push({
      key: `${prefix}:temperature`,
      nameKey: 'color_temperature',
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.TEMPERATURE,
      min: kelvinToMired(CCT_MAX_KELVIN),
      max: kelvinToMired(CCT_MIN_KELVIN),
      read_only: false,
      has_feedback: true,
      required: 'ct',
      requiredNonNull: true,
      read: (status) => kelvinToMired(status.ct),
    });
  }
  return [...specs, ...meteringSpecs(prefix, { lightPower: true })];
}

/**
 * Button events of an `input:N` in button mode -> Gladys BUTTON_STATUS
 * values (click 1, double click 2, long click 6, triple 18).
 */
export const BUTTON_EVENT_VALUES = {
  single_push: 1,
  double_push: 2,
  long_push: 6,
  triple_push: 18,
};

/**
 * Build the feature specs of an `input:N` component.
 *
 * Its shape depends on the input mode (Shelly.GetConfig), and the status alone
 * tells them apart, so no config read is needed:
 *   - switch mode: `state` is a boolean -> a read-only binary input;
 *   - button mode: `state` is null and the presses arrive as `NotifyEvent`
 *     -> a button feature, fed by the push channel only (a poll never sees a
 *     press), plus the `input_event` scene trigger;
 *   - count mode: `counts.total` -> a counter.
 * Analog inputs (`percent`) have no matching Gladys category yet and are left
 * out rather than misfiled.
 *
 * @param {number} id component index
 * @returns {object[]} the feature specs
 */
function inputSpecs(id) {
  const prefix = `${COMPONENT.INPUT}:${id}`;
  return [
    {
      key: `${prefix}:binary`,
      realtime: true,
      nameKey: 'input',
      category: DEVICE_FEATURE_CATEGORIES.INPUT,
      type: DEVICE_FEATURE_TYPES.INPUT.BINARY,
      min: 0,
      max: 1,
      required: 'state',
      present: (status) => typeof status.state === 'boolean',
      read: (status) => (typeof status.state === 'boolean' ? (status.state ? 1 : 0) : undefined),
    },
    {
      key: `${prefix}:button`,
      nameKey: 'button',
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.CLICK,
      min: 0,
      max: 25,
      required: 'state',
      present: (status) => status.state === null,
      // A press is an event, never a status field.
      read: () => undefined,
    },
    {
      key: `${prefix}:counter`,
      nameKey: 'counter',
      category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: 1000000000,
      required: 'counts',
      present: (status) => typeof get(status, ['counts', 'total']) === 'number',
      read: (status) => round(get(status, ['counts', 'total']), 0),
    },
  ];
}

/** Component family -> spec builder. An unlisted family is simply ignored. */
const SPEC_BUILDERS = {
  [COMPONENT.SWITCH]: switchSpecs,
  [COMPONENT.EM]: emSpecs,
  [COMPONENT.EMDATA]: emDataSpecs,
  [COMPONENT.EM1]: em1Specs,
  [COMPONENT.EM1DATA]: em1DataSpecs,
  [COMPONENT.PM1]: pm1Specs,
  [COMPONENT.TEMPERATURE]: temperatureSpecs,
  [COMPONENT.HUMIDITY]: humiditySpecs,
  [COMPONENT.DEVICEPOWER]: devicePowerSpecs,
  [COMPONENT.COVER]: coverSpecs,
  [COMPONENT.LIGHT]: (id) => lightSpecs(COMPONENT.LIGHT, id),
  [COMPONENT.RGB]: (id) => lightSpecs(COMPONENT.RGB, id),
  [COMPONENT.RGBW]: (id) => lightSpecs(COMPONENT.RGBW, id),
  [COMPONENT.CCT]: (id) => lightSpecs(COMPONENT.CCT, id),
  [COMPONENT.INPUT]: inputSpecs,
};

/**
 * Build every feature spec a device supports, from ONE `Shelly.GetStatus`
 * payload.
 *
 * Capabilities are derived from what the device actually reports, never from a
 * model table: a Pro 1PM exposes `apower` and a Pro 1 does not, and a Shelly
 * released after this code was written still maps correctly as long as it
 * speaks the documented component vocabulary.
 *
 * @param {object} status the `Shelly.GetStatus` result
 * @returns {object[]} the specs supported by this device
 */
export function buildFeatureSpecs(status) {
  if (!status || typeof status !== 'object') {
    return [];
  }

  return Object.entries(status)
    .flatMap(([componentKey, componentStatus]) => {
      const [family, rawId] = componentKey.split(':');
      const builder = SPEC_BUILDERS[family];
      if (!builder || rawId === undefined || componentStatus == null) {
        // `sys`, `wifi`, `cloud`, `ble`, `mqtt`… carry no user-facing value,
        // and an unknown family is a device newer than this code: skip both
        // rather than inventing a mapping.
        return [];
      }
      const id = Number.parseInt(rawId, 10);
      if (!Number.isFinite(id)) {
        return [];
      }
      return builder(id)
        .filter((spec) => {
          if (!(spec.required in componentStatus)) {
            return false;
          }
          // A shape that depends on the component's mode (an input in button
          // or switch mode, an uncalibrated cover) says so with `present`.
          if (spec.present && !spec.present(componentStatus)) {
            return false;
          }
          // Some fields are always present but null when the hardware is not
          // wired for them (a neutral clamp, an unplugged probe).
          return !spec.requiredNonNull || componentStatus[spec.required] != null;
        })
        .map((spec) => ({ ...spec, name: featureName(spec), componentKey }));
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Turn a feature spec into the Gladys feature descriptor sent at discovery.
 * @param {object} spec a feature spec
 * @param {(featureKey: string) => string} featureExternalId external id factory
 * @param {string} [deviceSelector] owning device selector, to scope the feature selector
 * @returns {object} the Gladys device feature
 */
export function toGladysFeature(spec, featureExternalId, deviceSelector) {
  return {
    name: spec.name,
    external_id: featureExternalId(spec.key),
    // Explicit, derived selector. Left to the core it would come from the
    // display name, and two devices with an unnamed relay would both claim
    // `on-off-switch-0` — the second one rejected with a 409.
    ...(deviceSelector ? { selector: buildFeatureSelector(deviceSelector, spec.key) } : {}),
    category: spec.category,
    type: spec.type,
    ...(spec.unit ? { unit: spec.unit } : {}),
    min: spec.min,
    max: spec.max,
    read_only: spec.read_only !== false,
    has_feedback: spec.has_feedback === true,
    keep_history: true,
  };
}
