// -----------------------------------------------------------------------------
// Gen1 `/status` -> the component-keyed shape the Gen2+ mapper already consumes.
//
// This module is the whole reason Gen1 support is not a second integration.
// A Gen1 device reports a FLAT, device-specific document:
//
//   { "relays": [{"ison": true}],
//     "emeters": [{"power": -8.4, "voltage": 227.8, "current": 2.76,
//                  "total": 7915525.36, "total_returned": 329811.77}, ...],
//     "total_power": -1050.7 }
//
// Rewriting it into `{"switch:0": {...}, "em:0": {...}, "emdata:0": {...}}`
// means features.js, telemetry.js, the real-time lane and the transport badges
// all work UNCHANGED — and, more importantly for the user, a Gen1 Shelly 3EM
// exposes exactly the same features as a Gen2 Pro 3EM. Same dashboards, same
// scenes, same feature names, whichever hardware is behind the clamp.
//
// Two mappings deserve their justification:
//
//   - the three `emeters[]` become the a_/b_/c_ phases of ONE `em:0`, because
//     that is what the hardware is: a single three-phase meter. Publishing
//     three independent `em1:N` would be truer to the JSON and wronger about
//     the device;
//   - apparent power is not reported by Gen1, so it is computed as U×I. That
//     is the definition of apparent power for a phase, not an estimate — but
//     it is derived, and it is flagged as such here so nobody later mistakes
//     it for a device reading.
// -----------------------------------------------------------------------------

import { COMPONENT, EM_PHASES } from '../constants.js';

/**
 * Whether a value is a usable number.
 * @param {unknown} value candidate
 * @returns {boolean} true when finite
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Assign a key only when the value is a usable number.
 *
 * `buildFeatureSpecs` decides a component's feature set from the keys PRESENT,
 * so writing `undefined` would publish a feature the device cannot feed.
 *
 * @param {object} target component being built
 * @param {string} key key to set
 * @param {unknown} value candidate value
 */
function setNumber(target, key, value) {
  if (isNumber(value)) {
    target[key] = value;
  }
}

/**
 * Normalize the `relays[]` array into `switch:N` components.
 *
 * Metering lives in a SEPARATE array on Gen1 (`meters[]`), positionally
 * matched to the relays — a Shelly 1PM has `relays[0]` and `meters[0]`, a
 * Shelly 1 has `relays[0]` and no meter at all.
 *
 * @param {object} status the raw Gen1 `/status` document
 * @param {object} normalized the document being built
 */
function normalizeRelays(status, normalized) {
  const relays = Array.isArray(status.relays) && status.mode !== 'roller' ? status.relays : [];
  const meters = Array.isArray(status.meters) ? status.meters : [];

  relays.forEach((relay, index) => {
    const component = { id: index, output: Boolean(relay.ison) };
    const meter = meters[index];
    if (meter) {
      setNumber(component, 'apower', meter.power);
      setNumber(component, 'voltage', meter.voltage);
      // Gen1 reports cumulated energy in WATT-MINUTES on `meters[]`, not in
      // watt-hours: `total` is what the Gen2+ mapper expects in Wh, so the
      // conversion happens here rather than silently inflating energy by 60.
      if (isNumber(meter.total)) {
        component.aenergy = { total: meter.total / 60 };
      }
    }
    normalized[`${COMPONENT.SWITCH}:${index}`] = component;
  });
}

/**
 * Normalize the `emeters[]` array into ONE `em:0` plus its `emdata:0`.
 * @param {object} status the raw Gen1 `/status` document
 * @param {object} normalized the document being built
 */
function normalizeEnergyMeters(status, normalized) {
  const emeters = Array.isArray(status.emeters) ? status.emeters : [];
  if (emeters.length === 0) {
    return;
  }

  const em = { id: 0 };
  const emdata = { id: 0 };
  let totalCurrent = 0;
  let totalApparent = 0;
  let totalEnergy = 0;
  let totalReturned = 0;
  let haveCurrent = false;
  let haveEnergy = false;

  emeters.slice(0, EM_PHASES.length).forEach((meter, index) => {
    const { prefix } = EM_PHASES[index];
    setNumber(em, `${prefix}_act_power`, meter.power);
    setNumber(em, `${prefix}_voltage`, meter.voltage);
    setNumber(em, `${prefix}_current`, meter.current);
    setNumber(em, `${prefix}_pf`, meter.pf);

    // Apparent power: S = U x I. Exact for a phase, but DERIVED — Gen1 does
    // not report it.
    if (isNumber(meter.voltage) && isNumber(meter.current)) {
      const apparent = meter.voltage * meter.current;
      em[`${prefix}_aprt_power`] = apparent;
      totalApparent += apparent;
    }
    if (isNumber(meter.current)) {
      totalCurrent += meter.current;
      haveCurrent = true;
    }
    if (isNumber(meter.total)) {
      emdata[`${prefix}_total_act_energy`] = meter.total;
      totalEnergy += meter.total;
      haveEnergy = true;
    }
    if (isNumber(meter.total_returned)) {
      emdata[`${prefix}_total_act_ret_energy`] = meter.total_returned;
      totalReturned += meter.total_returned;
    }
  });

  // `total_power` is reported by the device; prefer it over a sum of phases,
  // which would differ in the last decimal and look like a rounding bug.
  setNumber(em, 'total_act_power', status.total_power);
  if (totalApparent > 0) {
    em.total_aprt_power = totalApparent;
  }
  if (haveCurrent) {
    em.total_current = totalCurrent;
  }

  normalized[`${COMPONENT.EM}:0`] = em;
  if (haveEnergy) {
    emdata.total_act = totalEnergy;
    emdata.total_act_ret = totalReturned;
    normalized[`${COMPONENT.EMDATA}:0`] = emdata;
  }
}

/** Gen1 roller `state` (the direction of the last move) -> Gen2+ cover state. */
const GEN1_ROLLER_STATES = { open: 'open', close: 'closed', stop: 'stopped' };

/**
 * Normalize the `rollers[]` array (Shelly 2.5 in roller mode) into `cover:N`.
 *
 * A Gen1 roller reports its position only once calibrated (`positioning`), the
 * same rule `pos_control` carries on Gen2+, so it maps to it.
 *
 * A 2.5 reports either `relays[]` or `rollers[]` according to its mode; should
 * a firmware report both, the rollers win only when the document says the
 * device is in roller mode, so an existing relay install never changes shape.
 *
 * @param {object} status the raw Gen1 `/status` document
 * @param {object} normalized the document being built
 */
function normalizeRollers(status, normalized) {
  const rollers = Array.isArray(status.rollers) ? status.rollers : [];
  if (rollers.length === 0 || (Array.isArray(status.relays) && status.mode !== 'roller')) {
    return;
  }
  rollers.forEach((roller, index) => {
    const component = {
      id: index,
      state: GEN1_ROLLER_STATES[roller?.state] ?? null,
      pos_control: roller?.positioning === true,
    };
    if (roller?.positioning === true) {
      setNumber(component, 'current_pos', roller.current_pos);
    }
    setNumber(component, 'apower', roller?.power);
    normalized[`${COMPONENT.COVER}:${index}`] = component;
  });
}

/**
 * Normalize the `lights[]` array (Dimmer, Bulb, Duo, RGBW2 in colour mode).
 *
 * A light in colour mode (`mode: "color"`) becomes an `rgbw:N` whose
 * brightness is the Gen1 `gain`; a light reporting a colour temperature
 * (`temp`, Duo) becomes a `cct:N`; anything else is a dimmer, `light:N`.
 *
 * @param {object} status the raw Gen1 `/status` document
 * @param {object} normalized the document being built
 */
function normalizeLights(status, normalized) {
  const lights = Array.isArray(status.lights) ? status.lights : [];
  const meters = Array.isArray(status.meters) ? status.meters : [];
  lights.forEach((light, index) => {
    const component = { id: index, output: Boolean(light?.ison) };
    let family = COMPONENT.LIGHT;
    if (light?.mode === 'color') {
      family = COMPONENT.RGBW;
      if ([light.red, light.green, light.blue].every(isNumber)) {
        component.rgb = [light.red, light.green, light.blue];
      }
      setNumber(component, 'brightness', light.gain);
      setNumber(component, 'white', light.white);
    } else {
      setNumber(component, 'brightness', light?.brightness);
      if (isNumber(light?.temp)) {
        family = COMPONENT.CCT;
        component.ct = light.temp;
      }
    }
    setNumber(component, 'apower', meters[index]?.power);
    normalized[`${family}:${index}`] = component;
  });
}

/**
 * Normalize the `inputs[]` array (Shelly i3, the SW inputs of a 1/2.5) into
 * switch-mode `input:N` components.
 * @param {object} status the raw Gen1 `/status` document
 * @param {object} normalized the document being built
 */
function normalizeInputs(status, normalized) {
  const inputs = Array.isArray(status.inputs) ? status.inputs : [];
  inputs.forEach((input, index) => {
    if (input && (input.input === 0 || input.input === 1)) {
      const component = { id: index, state: input.input === 1 };
      // A momentary input counts its presses: telemetry turns an increase of
      // `event_cnt` into a button event (`event` is the last press type).
      if (isNumber(input.event_cnt)) {
        component.event_cnt = input.event_cnt;
        component.event = typeof input.event === 'string' ? input.event : '';
      }
      normalized[`${COMPONENT.INPUT}:${index}`] = component;
    }
  });
}

/**
 * Normalize the sensors a Gen1 device may expose.
 *
 * Gen1 spells temperature three different ways depending on the model and the
 * firmware (`tmp.tC`, `tmp.value`, a bare `temperature`), so all three are
 * accepted rather than picking one and silently losing the others.
 *
 * @param {object} status the raw Gen1 `/status` document
 * @param {object} normalized the document being built
 */
function normalizeSensors(status, normalized) {
  const celsius = [status.tmp?.tC, status.tmp?.value, status.temperature].find(isNumber);
  if (isNumber(celsius)) {
    normalized[`${COMPONENT.TEMPERATURE}:0`] = { id: 0, tC: celsius };
  }
  if (isNumber(status.hum?.value)) {
    normalized[`${COMPONENT.HUMIDITY}:0`] = { id: 0, rh: status.hum.value };
  }
  // Flood (SHWT-1) and Smoke (SHSM-01): a top-level boolean.
  if (typeof status.flood === 'boolean') {
    normalized[`${COMPONENT.FLOOD}:0`] = { id: 0, alarm: status.flood };
  }
  if (typeof status.smoke === 'boolean') {
    normalized[`${COMPONENT.SMOKE}:0`] = { id: 0, alarm: status.smoke };
  }
  // Door/Window 1 and 2: `sensor.state` is "open" / "close", meaningless
  // while `is_valid` is false (just woken up, not calibrated).
  const contactState = status.sensor?.state;
  if ((contactState === 'open' || contactState === 'close') && status.sensor?.is_valid !== false) {
    normalized[`${COMPONENT.CONTACT}:0`] = { id: 0, open: contactState === 'open' };
  }
  if (isNumber(status.lux?.value)) {
    normalized[`${COMPONENT.ILLUMINANCE}:0`] = { id: 0, lux: status.lux.value };
  }
  if (isNumber(status.bat?.value)) {
    normalized[`${COMPONENT.DEVICEPOWER}:0`] = {
      id: 0,
      battery: { percent: status.bat.value },
    };
  }
}

/**
 * Rewrite a Gen1 `/status` document into the Gen2+ component-keyed shape.
 * @param {object} status the raw Gen1 `/status` document
 * @returns {object} the normalized, component-keyed document
 */
export function normalizeGen1Status(status) {
  const normalized = {};
  if (!status || typeof status !== 'object') {
    return normalized;
  }
  normalizeRelays(status, normalized);
  normalizeRollers(status, normalized);
  normalizeLights(status, normalized);
  normalizeInputs(status, normalized);
  normalizeEnergyMeters(status, normalized);
  normalizeSensors(status, normalized);
  return normalized;
}

/**
 * Rewrite a Gen1 `/settings` document into the Gen2+ config shape, so the same
 * naming code applies to both generations.
 * @param {object} settings the raw Gen1 `/settings` document
 * @returns {object} the normalized config document
 */
export function normalizeGen1Settings(settings) {
  const normalized = { sys: { device: { name: settings?.name ?? null } } };
  const relays = Array.isArray(settings?.relays) ? settings.relays : [];
  relays.forEach((relay, index) => {
    if (relay && typeof relay.name === 'string' && relay.name !== '') {
      normalized[`${COMPONENT.SWITCH}:${index}`] = { name: relay.name };
    }
  });
  const rollers = Array.isArray(settings?.rollers) ? settings.rollers : [];
  rollers.forEach((roller, index) => {
    if (roller && typeof roller.name === 'string' && roller.name !== '') {
      normalized[`${COMPONENT.COVER}:${index}`] = { name: roller.name };
    }
  });
  return normalized;
}

/**
 * Build the Gen2+-style identity document of a Gen1 device.
 *
 * The rest of the codebase keys everything on a device `id`, which Gen1 does
 * not have. Deriving it the way Shelly itself does — `<model in lower case>-<mac>`,
 * the exact form the device uses as its mDNS name — keeps external ids and
 * selectors stable and reconstructible, and matches what the user sees in the
 * Shelly app.
 *
 * @param {object} info the raw Gen1 `/shelly` identity document
 * @returns {object} an identity document carrying an `id`, a `model` and `gen: 1`
 */
export function normalizeGen1Info(info) {
  const mac = `${info?.mac || ''}`.toLowerCase();
  const model = `${info?.type || ''}`;
  const slug = model.toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    ...info,
    id: info?.id || (slug && mac ? `${slug}-${mac}` : mac || undefined),
    model,
    gen: 1,
  };
}
