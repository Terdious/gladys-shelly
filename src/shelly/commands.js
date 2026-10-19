// -----------------------------------------------------------------------------
// Gladys value -> Shelly command, for every writable feature.
//
// One function turns a feature coordinate (`cover:0:position`) and a Gladys
// value into the same command spelled for each transport:
//   - `rpc`:   the Gen2+ JSON-RPC call, sent over HTTP, the WebSocket or MQTT;
//   - `gen1`:  the Gen1 REST path;
//   - `cloud`: the Shelly Cloud Control API call (documented, not yet verified
//              on a real account, see issue #6).
// plus the state to publish back as optimistic feedback. Keeping the three
// spellings side by side is what stops a family from working locally and
// silently not through the fallback.
// -----------------------------------------------------------------------------

import { COMPONENT } from './constants.js';
import { CCT_MAX_KELVIN, CCT_MIN_KELVIN, intToRgb, miredToKelvin, rgbToInt } from './features.js';

/** RPC namespace of each light family. */
const LIGHT_METHODS = {
  [COMPONENT.LIGHT]: 'Light',
  [COMPONENT.RGB]: 'RGB',
  [COMPONENT.RGBW]: 'RGBW',
  [COMPONENT.CCT]: 'CCT',
};

/**
 * Clamp a number into a range, rounding it.
 * @param {unknown} value raw value
 * @param {number} min lower bound
 * @param {number} max upper bound
 * @returns {number} the clamped integer
 */
function clamp(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid value: ${value}`);
  }
  return Math.min(Math.max(number, min), max);
}

/**
 * Build the command for a value set on a writable feature.
 * @param {{family: string, index: number, suffix: string}} coordinates parsed feature key
 * @param {number} value the Gladys value
 * @returns {{rpc: {method: string, params: object}, gen1?: string, cloud?: {path: string, body: object}, state: number, label: string}|undefined} the command, or undefined when the feature is not writable
 */
export function buildCommand({ family, index, suffix }, value) {
  const id = index;

  if (family === COMPONENT.SWITCH && suffix === 'binary') {
    const on = Number(value) === 1;
    return {
      rpc: { method: 'Switch.Set', params: { id, on } },
      gen1: `/relay/${id}?turn=${on ? 'on' : 'off'}`,
      cloud: {
        path: '/device/relay/control',
        body: { channel: String(id), turn: on ? 'on' : 'off' },
      },
      state: on ? 1 : 0,
      label: on ? 'on' : 'off',
    };
  }

  if (family === COMPONENT.COVER && suffix === 'state') {
    const direction = Math.sign(Number(value));
    if (!Number.isFinite(direction)) {
      throw new Error(`Invalid shutter value: ${value}`);
    }
    const action = direction > 0 ? 'open' : direction < 0 ? 'close' : 'stop';
    const method = { open: 'Cover.Open', close: 'Cover.Close', stop: 'Cover.Stop' }[action];
    return {
      rpc: { method, params: { id } },
      gen1: `/roller/${id}?go=${action}`,
      cloud: {
        path: '/device/relay/roller/control',
        body: { channel: String(id), direction: action },
      },
      state: direction,
      label: action,
    };
  }

  if (family === COMPONENT.COVER && suffix === 'position') {
    const pos = clamp(value, 0, 100);
    return {
      rpc: { method: 'Cover.GoToPosition', params: { id, pos } },
      gen1: `/roller/${id}?go=to_pos&roller_pos=${pos}`,
      cloud: {
        path: '/device/relay/roller/settings/topos',
        body: { channel: String(id), pos: String(pos) },
      },
      state: pos,
      label: `position ${pos}`,
    };
  }

  const lightMethod = LIGHT_METHODS[family];
  if (!lightMethod) {
    return undefined;
  }
  // Gen1 drives a colour light on `/color/N` and every other light on `/light/N`.
  const gen1Base = family === COMPONENT.RGBW ? `/color/${id}` : `/light/${id}`;
  const cloudLight = (fields) => ({
    path: '/device/light/control',
    body: { channel: String(id), ...fields },
  });

  if (suffix === 'binary') {
    const on = Number(value) === 1;
    return {
      rpc: { method: `${lightMethod}.Set`, params: { id, on } },
      gen1: `${gen1Base}?turn=${on ? 'on' : 'off'}`,
      cloud: cloudLight({ turn: on ? 'on' : 'off' }),
      state: on ? 1 : 0,
      label: on ? 'on' : 'off',
    };
  }

  if (suffix === 'brightness') {
    // `Light.Set` with a brightness and no `on` changes the level without
    // touching the on/off state, which is what a slider means.
    const brightness = clamp(value, 0, 100);
    const gen1Field = family === COMPONENT.RGBW ? 'gain' : 'brightness';
    return {
      rpc: { method: `${lightMethod}.Set`, params: { id, brightness } },
      gen1: `${gen1Base}?${gen1Field}=${brightness}`,
      cloud: cloudLight({ brightness: String(brightness) }),
      state: brightness,
      label: `brightness ${brightness}`,
    };
  }

  if (suffix === 'color' && (family === COMPONENT.RGB || family === COMPONENT.RGBW)) {
    const rgb = intToRgb(value);
    const [red, green, blue] = rgb;
    return {
      rpc: { method: `${lightMethod}.Set`, params: { id, rgb } },
      gen1: `${gen1Base}?red=${red}&green=${green}&blue=${blue}`,
      cloud: cloudLight({ red: String(red), green: String(green), blue: String(blue) }),
      state: rgbToInt(rgb),
      label: `color #${rgbToInt(rgb).toString(16).padStart(6, '0')}`,
    };
  }

  if (suffix === 'white' && family === COMPONENT.RGBW) {
    const percent = clamp(value, 0, 100);
    const white = Math.round(percent * 2.55);
    return {
      rpc: { method: 'RGBW.Set', params: { id, white } },
      gen1: `${gen1Base}?white=${white}`,
      cloud: cloudLight({ white: String(white) }),
      state: percent,
      label: `white ${percent} %`,
    };
  }

  if (suffix === 'temperature' && family === COMPONENT.CCT) {
    const ct = clamp(miredToKelvin(Number(value)), CCT_MIN_KELVIN, CCT_MAX_KELVIN);
    return {
      rpc: { method: 'CCT.Set', params: { id, ct } },
      gen1: `${gen1Base}?temp=${ct}`,
      cloud: cloudLight({ temp: String(ct) }),
      state: clamp(value, 0, 1000),
      label: `${ct} K`,
    };
  }

  return undefined;
}
