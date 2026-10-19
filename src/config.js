// -----------------------------------------------------------------------------
// Configuration normalization.
//
// The configuration comes from the Gladys form generated from the manifest
// `config_schema`, so every value arrives as the user typed it: strings for
// `select` fields, `undefined` for a field never saved, whitespace around a
// pasted secret. Normalizing ONCE here means the rest of the codebase can
// assume clean, typed values and never re-parse anything.
// -----------------------------------------------------------------------------

import { normalizeLanguage } from './shelly/featureNames.js';

/**
 * Defaults of the configuration form, mirroring the manifest `config_schema`
 * (`test/manifest.test.js` keeps the two in step). Every other field has no
 * default: an empty form is a complete, local-only setup.
 */
export const DEFAULT_CONFIG = {
  device_username: 'admin',
  cloud_enabled: false,
  mqtt_enabled: false,
  feature_names: 'en',
  refresh_interval: '30',
  realtime_interval: '5',
};

/** Refresh interval floor/ceiling, in seconds (the manifest select stays inside). */
const MIN_REFRESH_SECONDS = 5;
const MAX_REFRESH_SECONDS = 3600;
const DEFAULT_REFRESH_SECONDS = 30;

/** Real-time lane cadence bounds, in seconds. */
const MIN_REALTIME_SECONDS = 1;
const MAX_REALTIME_SECONDS = 60;
const DEFAULT_REALTIME_SECONDS = 5;

/** Gen2+ devices only accept this username; the form defaults to it. */
const DEFAULT_DEVICE_USERNAME = 'admin';

/**
 * Read a boolean the way the Gladys form stores it: a real boolean, or the
 * string 'true'/'false' when it went through a select.
 * @param {unknown} value raw config value
 * @param {boolean} fallback value used when nothing is stored
 * @returns {boolean} the normalized boolean
 */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return String(value).toLowerCase() === 'true';
}

/**
 * Parse the comma-separated list of manual hosts.
 * Tolerant on purpose: users paste lists with spaces, newlines, semicolons and
 * trailing commas, and a typo in one entry must not drop the whole list.
 * @param {unknown} value raw config value
 * @returns {string[]} deduplicated, trimmed host list
 */
function parseHosts(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  const hosts = value
    .split(/[,;\s]+/)
    .map((host) => host.trim())
    .filter((host) => host !== '')
    // A pasted `http://10.5.0.171/` is what the user sees in their browser:
    // accept it and keep only the host part.
    .map((host) => host.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  return [...new Set(hosts)];
}

/**
 * Parse the per-device passwords: `<device>=<password>` entries separated by
 * `;` or new lines, `<device>` being a Shelly id, a MAC address or an IP
 * address / host name.
 *
 * A password may itself contain `;` or `=`: an entry only ends where the next
 * `<device>=` begins (see DEVICE_KEY), and only the FIRST `=` of an entry
 * separates the device from its password. Spaces around the separators are
 * ignored, so a password listed here cannot end with a space (the shared
 * password field above can).
 *
 * @param {unknown} value raw config value
 * @returns {Array<{key: string, password: string}>} entries, keys normalized
 */
export function parseDevicePasswords(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  return value
    .split(ENTRY_SEPARATOR)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator <= 0) {
        return undefined;
      }
      const key = normalizeDeviceKey(entry.slice(0, separator));
      const password = entry.slice(separator + 1).replace(/\s+$/, '');
      return key && password !== '' ? { key, password } : undefined;
    })
    .filter(Boolean);
}

/**
 * What can start an entry of the per-device passwords: a Shelly id
 * (`shellyplus1-a8032ab12345`), a MAC, an IPv4 address or a dotted host name,
 * then `=`. Splitting only in front of one of those keeps a `;` or a `word=`
 * inside a password where it belongs.
 */
const DEVICE_KEY =
  '(?:[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6,12}|(?:[0-9a-f]{2}[:-]?){5}[0-9a-f]{2}|\\d{1,3}(?:\\.\\d{1,3}){3}|[\\w-]+(?:\\.[\\w-]+)+)(?::\\d+)?';
const ENTRY_SEPARATOR = new RegExp(`\\s*(?:;|\\r?\\n)\\s*(?=${DEVICE_KEY}=)`, 'i');

/**
 * Normalize anything identifying a device into one comparable form: lower
 * case, scheme and port dropped from an address, separators dropped from a
 * MAC (`AA:BB:CC:DD:EE:FF` and `aabbccddeeff` are the same device).
 * @param {unknown} value a Shelly id, a MAC, an IP address or a host name
 * @returns {string} the normalized key, '' when empty
 */
export function normalizeDeviceKey(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(text)) {
    return text.replace(/[:-]/g, '');
  }
  // An IPv4 address or a host name may carry a port: it is not part of the key.
  return text.replace(/:(\d+)$/, '');
}

/**
 * The credentials to use for ONE device: its own password when the
 * configuration lists one for its Shelly id, its MAC (the tail of a Shelly
 * id) or its address, the shared password otherwise.
 * @param {object} config normalized configuration
 * @param {object} device what is known of the device
 * @param {string} [device.shellyId] the Shelly id
 * @param {string} [device.host] its address
 * @param {string} [device.mac] its MAC address
 * @returns {{username: string, password: string, perDevice: boolean}} the credentials
 */
export function credentialsFor(config, { shellyId, host, mac } = {}) {
  const candidates = new Set(
    [
      shellyId,
      // `shellypro3em-2cbcbba663cc` -> `2cbcbba663cc`, the MAC a user reads on the label.
      shellyId && String(shellyId).includes('-') ? String(shellyId).split('-').pop() : undefined,
      mac,
      host,
    ]
      .map(normalizeDeviceKey)
      .filter(Boolean),
  );
  const match = (config?.devicePasswords || []).find((entry) => candidates.has(entry.key));
  return {
    username: config?.deviceUsername || DEFAULT_DEVICE_USERNAME,
    password: match ? match.password : config?.devicePassword || '',
    perDevice: Boolean(match),
  };
}

/**
 * Normalize the raw configuration object into typed, defaulted values.
 * @param {object} [rawConfig] configuration as received from Gladys
 * @returns {object} the normalized configuration
 */
export function normalizeConfig(rawConfig = {}) {
  const config = rawConfig || {};

  const refreshSeconds = Number.parseInt(config.refresh_interval, 10);
  const realtimeSeconds = Number.parseInt(config.realtime_interval, 10);

  return {
    manualHosts: parseHosts(config.manual_hosts),
    deviceUsername:
      typeof config.device_username === 'string' && config.device_username.trim() !== ''
        ? config.device_username.trim()
        : DEFAULT_DEVICE_USERNAME,
    // Never trim a password: a trailing space can be part of it. Only reject
    // a non-string (never saved).
    devicePassword: typeof config.device_password === 'string' ? config.device_password : '',
    // Passwords of the devices that do not share the one above (issue #9).
    devicePasswords: parseDevicePasswords(config.device_passwords),
    cloudEnabled: toBoolean(config.cloud_enabled, false),
    // A pasted server address often carries the scheme and a trailing slash.
    cloudServer:
      typeof config.cloud_server === 'string'
        ? config.cloud_server
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/, '')
        : '',
    cloudAuthKey: typeof config.cloud_auth_key === 'string' ? config.cloud_auth_key.trim() : '',
    // MQTT: a third transport, and on a large fleet the only reliable
    // inventory — a device that publishes announces itself continuously, with
    // no discovery window to miss.
    mqttEnabled: toBoolean(config.mqtt_enabled, false),
    // Accepts `10.5.0.50:1883`, `mqtt://10.5.0.50` or a bare host: users paste
    // whatever the Shelly UI showed them.
    mqttServer:
      typeof config.mqtt_server === 'string'
        ? config.mqtt_server
            .trim()
            .replace(/^mqtts?:\/\//i, '')
            .replace(/\/+$/, '')
        : '',
    mqttUsername: typeof config.mqtt_username === 'string' ? config.mqtt_username.trim() : '',
    // Never trim a password: a trailing space can be part of it.
    mqttPassword: typeof config.mqtt_password === 'string' ? config.mqtt_password : '',
    refreshSeconds: Number.isFinite(refreshSeconds)
      ? Math.min(Math.max(refreshSeconds, MIN_REFRESH_SECONDS), MAX_REFRESH_SECONDS)
      : DEFAULT_REFRESH_SECONDS,
    // Cadence of the real-time lane: the handful of values a control scene
    // reacts to (total power, per-relay power, on/off). 0 disables the lane,
    // in which case those values simply ride the normal refresh interval.
    realtimeSeconds: Number.isFinite(realtimeSeconds)
      ? realtimeSeconds === 0
        ? 0
        : Math.min(Math.max(realtimeSeconds, MIN_REALTIME_SECONDS), MAX_REALTIME_SECONDS)
      : DEFAULT_REALTIME_SECONDS,
    // Reserved key written by the core when the manifest declares both
    // transports. Read-only for us, and a wish rather than an order: we honour
    // it when we can and report the real outcome through publishTransports.
    preferLocal: config.GLADYS_PREFER_LOCAL !== false,
    // Language of the feature names of newly discovered devices.
    featureNames: normalizeLanguage(config.feature_names),
  };
}

/**
 * Whether the Shelly Cloud fallback is usable: enabled AND fully configured.
 * Enabling the toggle without a key is a half-finished setup, not an error —
 * the integration stays local-only and says so in the logs.
 * @param {object} config normalized configuration
 * @returns {boolean} true when cloud calls can be attempted
 */
export function isCloudConfigured(config) {
  return Boolean(config.cloudEnabled && config.cloudServer && config.cloudAuthKey);
}
