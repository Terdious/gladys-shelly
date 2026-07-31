// -----------------------------------------------------------------------------
// Configuration normalization.
//
// The configuration comes from the Gladys form generated from the manifest
// `config_schema`, so every value arrives as the user typed it: strings for
// `select` fields, `undefined` for a field never saved, whitespace around a
// pasted secret. Normalizing ONCE here means the rest of the codebase can
// assume clean, typed values and never re-parse anything.
// -----------------------------------------------------------------------------

/** Refresh interval floor/ceiling, in seconds (the manifest select stays inside). */
const MIN_REFRESH_SECONDS = 5;
const MAX_REFRESH_SECONDS = 3600;
const DEFAULT_REFRESH_SECONDS = 30;

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
 * Normalize the raw configuration object into typed, defaulted values.
 * @param {object} [rawConfig] configuration as received from Gladys
 * @returns {object} the normalized configuration
 */
export function normalizeConfig(rawConfig = {}) {
  const config = rawConfig || {};

  const refreshSeconds = Number.parseInt(config.refresh_interval, 10);

  return {
    manualHosts: parseHosts(config.manual_hosts),
    deviceUsername:
      typeof config.device_username === 'string' && config.device_username.trim() !== ''
        ? config.device_username.trim()
        : DEFAULT_DEVICE_USERNAME,
    // Never trim a password: a trailing space can be part of it. Only reject
    // a non-string (never saved).
    devicePassword: typeof config.device_password === 'string' ? config.device_password : '',
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
    refreshSeconds: Number.isFinite(refreshSeconds)
      ? Math.min(Math.max(refreshSeconds, MIN_REFRESH_SECONDS), MAX_REFRESH_SECONDS)
      : DEFAULT_REFRESH_SECONDS,
    // Reserved key written by the core when the manifest declares both
    // transports. Read-only for us, and a wish rather than an order: we honour
    // it when we can and report the real outcome through publishTransports.
    preferLocal: config.GLADYS_PREFER_LOCAL !== false,
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
