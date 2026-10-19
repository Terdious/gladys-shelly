// -----------------------------------------------------------------------------
// Diagnostic reports (manifest actions `fleet_diagnostic` and `test_device`).
//
// "My Shelly is missing / slow / stuck on the cloud" used to take several
// round trips with the user: which transport serves it, is its WebSocket
// live, did the circuit breaker park it, does it answer at its address, does
// it refuse the password. The logs carry most of it, spread over hours. These
// reports rebuild the whole picture on demand, from the Configuration screen,
// as plain text the user pastes into a GitHub issue in one gesture.
//
// src/actions.js gathers RAW snapshots; this module formats and redacts them:
//   - secrets (device password, cloud key, broker credentials) are never
//     printed, and the final text is scrubbed of them whatever the options;
//   - identifiers (the MAC inside a Shelly id, local IP addresses and host
//     names) are masked unless the user explicitly asks for them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** Bound of a report, in characters: it is shown under the action button. */
export const MAX_REPORT_LENGTH = 12000;

export const MASKED_HOST = '<local-ip>';
const REDACTED = '<redacted>';

/** Below this Wi-Fi signal (dBm) a device drops pushes and times out. */
export const WEAK_RSSI_DBM = -75;

const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const MDNS_PATTERN = /\b[A-Za-z0-9-]+\.local\b/g;

/** Version of the integration, from package.json (shipped in the image). */
export const INTEGRATION_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/**
 * Mask the MAC part of a Shelly id, keeping the model part that tells devices
 * apart in an issue: `shellypro3em-2cbcbba663cc` -> `shellypro3em-2c…cc`.
 * @param {string|null|undefined} value a Shelly id or a MAC
 * @returns {string} the masked identifier
 */
export function maskIdentifier(value) {
  const text = String(value ?? '');
  if (text === '') {
    return '-';
  }
  const dash = text.lastIndexOf('-');
  const head = dash === -1 ? '' : text.slice(0, dash + 1);
  const tail = dash === -1 ? text : text.slice(dash + 1);
  if (tail.length <= 4) {
    return `${head}${tail.slice(0, 1)}…`;
  }
  return `${head}${tail.slice(0, 2)}…${tail.slice(-2)}`;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The redaction rules of one report.
 * @param {object} options redaction options
 * @param {boolean} options.includeIdentifiers show Shelly ids and addresses in full
 * @param {string[]} [options.secrets] never shown, whatever the options
 * @param {string[]} [options.identifiers] Shelly ids and MACs (masked)
 * @param {string[]} [options.hosts] local addresses and host names (hidden)
 * @returns {{masked: boolean, id: Function, host: Function, scrub: Function}} the redactor
 */
export function createRedactor({ includeIdentifiers, secrets = [], identifiers = [], hosts = [] }) {
  const mask = includeIdentifiers !== true;
  // Longest first: a host name contains the Shelly id, a secret may contain
  // another one.
  const byLength = (values) =>
    [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length >= 4))].sort(
      (a, b) => b.length - a.length,
    );
  const secretList = byLength(secrets);
  const hostList = byLength(hosts);
  const identifierList = byLength(identifiers);
  return {
    masked: mask,
    id: (value) => (mask ? maskIdentifier(value) : String(value ?? '-')),
    host: (value) => {
      if (value === null || value === undefined || value === '') {
        return '-';
      }
      return mask ? MASKED_HOST : String(value);
    },
    /** Final pass over the whole text (defense in depth). */
    scrub: (text) => {
      const replaceAll = (input, value, replacement) =>
        input.replace(new RegExp(escapeRegExp(value), 'gi'), replacement);
      let result = String(text);
      for (const secret of secretList) {
        result = replaceAll(result, secret, REDACTED);
      }
      if (mask) {
        for (const value of hostList) {
          result = replaceAll(result, value, MASKED_HOST);
        }
        for (const value of identifierList) {
          result = replaceAll(result, value, maskIdentifier(value));
        }
        result = result.replace(IPV4_PATTERN, MASKED_HOST).replace(MDNS_PATTERN, MASKED_HOST);
      }
      return result;
    },
  };
}

/**
 * Cut a report at a line boundary when it exceeds the bound, with a note.
 * @param {string} text the report
 * @param {number} [max] bound in characters
 * @returns {string} the report, bounded
 */
export function truncateReport(text, max = MAX_REPORT_LENGTH) {
  if (text.length <= max) {
    return text;
  }
  const noteRoom = 200;
  let cut = text.lastIndexOf('\n', max - noteRoom);
  if (cut <= 0) {
    cut = max - noteRoom;
  }
  return (
    `${text.slice(0, cut)}\n[... report truncated: ${text.length - cut} more character(s). ` +
    'Pick a device in the "Device" field to diagnose one device at a time.]'
  );
}

/**
 * `3 s ago`, `12 min ago`, `2 h ago`, or `never`.
 * @param {number|undefined} at epoch ms
 * @param {number} now epoch ms
 * @returns {string} the age
 */
export function formatAge(at, now) {
  if (!at) {
    return 'never';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 120) {
    return `${seconds} s ago`;
  }
  if (seconds < 2 * 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * `3 d 4 h`, `5 h 12 min`, `42 min`.
 * @param {unknown} seconds a duration in seconds
 * @returns {string} the duration, `-` when unknown
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '-';
  }
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days} d ${hours % 24} h`;
  }
  if (hours > 0) {
    return `${hours} h ${minutes % 60} min`;
  }
  return `${minutes} min`;
}

const yesNo = (value) => (value ? 'yes' : 'no');

function headerLines(title, now, redactor) {
  return [
    title,
    `Generated: ${new Date(now).toISOString()}`,
    `Integration version: ${INTEGRATION_VERSION} (Node ${process.version})`,
    redactor.masked
      ? 'Identifiers: masked (MAC addresses shortened, local addresses hidden). No password nor key.'
      : 'WARNING: this report shows full device ids and local addresses: do not post it publicly. No password nor key.',
  ];
}

/**
 * Health lines read from a status document (Gen2+ shape, or a normalized
 * Gen1 one that keeps its `wifi_sta` / `update` blocks).
 * @param {object|undefined} status the last known status
 * @returns {string[]} the lines, possibly empty
 */
export function statusHealthLines(status) {
  if (!status) {
    return [];
  }
  const lines = [];
  const rssi = status.wifi?.rssi ?? status.wifi_sta?.rssi;
  if (typeof rssi === 'number') {
    const weak = rssi < WEAK_RSSI_DBM;
    lines.push(
      `Wi-Fi signal: ${rssi} dBm${weak ? ' — WEAK: expect dropped pushes and timeouts, move the access point or use Ethernet' : ''}`,
    );
  }
  const uptime = status.sys?.uptime ?? status.uptime;
  if (typeof uptime === 'number') {
    lines.push(`Uptime: ${formatDuration(uptime)}`);
  }
  const update = status.sys?.available_updates?.stable?.version;
  if (update) {
    lines.push(`Firmware update available: ${update}`);
  } else if (status.update?.has_update) {
    lines.push(`Firmware update available: ${status.update.new_version || 'yes'}`);
  }
  if (status.sys?.restart_required) {
    lines.push('Restart required (a setting waits for a reboot)');
  }
  if (typeof status.cloud?.connected === 'boolean') {
    lines.push(`Device connected to the Shelly Cloud: ${yesNo(status.cloud.connected)}`);
  }
  if (typeof status.mqtt?.connected === 'boolean') {
    lines.push(`Device connected to its MQTT broker: ${yesNo(status.mqtt.connected)}`);
  }
  return lines;
}

/** One-line summary of the user-facing components of a status. */
export function componentSummary(status) {
  if (!status) {
    return '-';
  }
  const families = new Map();
  Object.keys(status).forEach((key) => {
    const [family, id] = key.split(':');
    if (id === undefined) {
      return;
    }
    families.set(family, (families.get(family) || 0) + 1);
  });
  return families.size === 0
    ? '-'
    : [...families.entries()].map(([family, count]) => `${family} x${count}`).join(', ');
}

/** Values of the controllable components, so "it does not move" can be read. */
function controlLines(status) {
  if (!status) {
    return [];
  }
  return Object.entries(status)
    .map(([key, value]) => {
      const family = key.split(':')[0];
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      if (
        family === 'switch' ||
        family === 'light' ||
        family === 'rgb' ||
        family === 'rgbw' ||
        family === 'cct'
      ) {
        const brightness = typeof value.brightness === 'number' ? `, ${value.brightness} %` : '';
        const power = typeof value.apower === 'number' ? `, ${value.apower} W` : '';
        return `${key}: ${value.output ? 'on' : 'off'}${brightness}${power}`;
      }
      if (family === 'cover') {
        const pos =
          typeof value.current_pos === 'number'
            ? `, position ${value.current_pos} %`
            : ', not calibrated';
        return `${key}: ${value.state ?? '-'}${pos}`;
      }
      if (family === 'input') {
        const mode =
          value.state === null
            ? 'button'
            : typeof value.state === 'boolean'
              ? value.state
                ? 'on'
                : 'off'
              : 'other mode';
        return `${key}: ${mode}`;
      }
      return undefined;
    })
    .filter(Boolean);
}

/**
 * Plain-text report of the whole installation.
 * @param {object} snapshot gathered by src/actions.js
 * @param {object} options report options
 * @param {boolean} options.includeIdentifiers show ids and addresses in full
 * @param {number} [options.now] clock (tests)
 * @returns {string} the report
 */
export function buildFleetDiagnostic(snapshot, { includeIdentifiers, now = Date.now() }) {
  const { config, budget, devices, filter, secrets } = snapshot;
  const redactor = createRedactor({
    includeIdentifiers,
    secrets,
    identifiers: devices.map((device) => device.shellyId),
    hosts: [...devices.map((device) => device.host), ...config.manualHosts, config.mqttServer],
  });
  const lines = [...headerLines('Shelly integration — diagnostic', now, redactor), ''];

  lines.push('[Configuration]');
  lines.push(
    `Prefer local: ${yesNo(config.preferLocal)} · refresh every ${config.refreshSeconds} s · ` +
      `real-time lane ${config.realtimeSeconds ? `every ${config.realtimeSeconds} s` : 'disabled'} · ` +
      `feature names: ${config.featureNames}`,
  );
  lines.push(
    `Additional addresses: ${config.manualHosts.length} · device username: ${config.deviceUsername} · ` +
      `device password: ${config.devicePassword ? 'set' : 'not set'}`,
  );
  lines.push(
    `Shelly Cloud: ${config.cloudEnabled ? `enabled (server ${config.cloudServer || 'missing'}, key ${config.cloudAuthKey ? 'set' : 'missing'})` : 'disabled'}`,
  );
  lines.push(
    `MQTT: ${config.mqttEnabled ? `enabled (broker ${redactor.host(config.mqttServer)}, user ${config.mqttUsername ? 'set' : 'none'})` : 'disabled'}`,
  );
  lines.push('');

  lines.push('[Real-time and budget]');
  lines.push(
    `WebSocket: ${budget.webSocketLive}/${budget.webSocketConnections} connection(s) live · ` +
      `MQTT broker: ${config.mqttEnabled ? (budget.mqttConnected ? 'connected' : 'NOT connected') : 'off'}, ` +
      `${budget.mqttDevices} device(s) seen, ${budget.mqttSeeded} read in full`,
  );
  const lane =
    budget.configuredRealtimeSeconds &&
    budget.effectiveRealtimeSeconds > budget.configuredRealtimeSeconds
      ? ` — slowed to ${budget.effectiveRealtimeSeconds} s by the budget`
      : '';
  lines.push(
    `States published in the last minute: ${budget.statesLastMinute}/${budget.limitPerMinute}${lane}`,
  );
  if (budget.lastRateLimitedAt) {
    lines.push(
      `Last refusal by Gladys (too many states): ${formatAge(budget.lastRateLimitedAt, now)}`,
    );
  }
  lines.push('');

  lines.push(`[Devices] ${devices.length} ${filter ? 'matching the filter' : 'created in Gladys'}`);
  if (devices.length === 0) {
    lines.push(
      filter
        ? 'No created device matches. Use "Test a device" for a device not created in Gladys.'
        : 'None yet: run a scan in the Discover tab.',
    );
  }
  for (const device of devices) {
    const runtime = device.runtime || {};
    const transport = runtime.transport;
    lines.push('');
    lines.push(`- ${device.name} [${redactor.id(device.shellyId)}]`);
    lines.push(
      `  Model: ${device.model || '-'} · Gen ${device.gen} · address ${redactor.host(device.host)} · ${device.featureCount} feature(s)`,
    );
    const channel = runtime.webSocketLive
      ? 'WebSocket live'
      : runtime.mqttSeeded
        ? 'MQTT live'
        : runtime.mqttKnown
          ? 'seen on MQTT, polled'
          : 'polled';
    lines.push(
      `  Transport: ${transport?.transport ?? 'not read yet'} (${channel})` +
        `${transport?.degraded ? ` — DEGRADED: ${transport.message?.en ?? ''}` : ''}`,
    );
    lines.push(
      `  Last data: ${formatAge(runtime.lastSeenAt, now)} · last full read: ${formatAge(runtime.lastPolledAt, now)}`,
    );
    if (device.localHealth?.failures > 0 || device.localHealth?.until > now) {
      lines.push(
        `  Local circuit breaker: ${device.localHealth.failures} failure(s) in a row` +
          `${device.localHealth.until > now ? `, parked until ${new Date(device.localHealth.until).toISOString()}` : ''}`,
      );
    }
    lines.push(`  Components: ${componentSummary(runtime.status)}`);
    statusHealthLines(runtime.status).forEach((line) => lines.push(`  ${line}`));
    controlLines(runtime.status).forEach((line) => lines.push(`  ${line}`));
  }

  return truncateReport(redactor.scrub(lines.join('\n')));
}

/** What to try for each failure of the device test. */
const HINTS = {
  'no-address':
    'No address is known for this device. Run a scan, or add its IP in "Additional device addresses".',
  'no-answer':
    'Nothing answered at this address: device off, wrong IP (DHCP lease changed?), or another VLAN the Gladys host cannot reach. Run a scan to refresh the address.',
  'not-a-shelly':
    'Something answered, but it is not a Shelly: the address belongs to another device now. Run a scan.',
  auth: 'The device refused the password: set the same password on every Shelly, or fix "Device password" in the configuration.',
  status: 'The device answered its identity but not its status: reboot it, then test again.',
};

/**
 * Plain-text report of one live device test.
 * @param {object} outcome gathered by src/actions.js
 * @param {object} options report options
 * @param {boolean} options.includeIdentifiers show ids and addresses in full
 * @param {number} [options.now] clock (tests)
 * @returns {string} the report
 */
export function buildDeviceTestReport(outcome, { includeIdentifiers, now = Date.now() }) {
  const redactor = createRedactor({
    includeIdentifiers,
    secrets: outcome.secrets,
    identifiers: [outcome.shellyId, outcome.info?.id, outcome.info?.mac].filter(Boolean),
    hosts: [outcome.host],
  });
  const lines = [...headerLines('Shelly integration — device test', now, redactor), ''];
  lines.push(
    `Device: ${outcome.name ?? '(not created in Gladys)'} [${redactor.id(outcome.shellyId ?? outcome.info?.id)}]`,
  );
  lines.push(`Address: ${redactor.host(outcome.host)} (${outcome.hostOrigin ?? 'unknown origin'})`);

  if (outcome.failure === 'no-address') {
    lines.push('', `Result: FAILED — ${HINTS['no-address']}`);
    return truncateReport(redactor.scrub(lines.join('\n')));
  }

  lines.push('');
  lines.push('[1] GET /shelly (identity, no password needed)');
  if (outcome.infoError) {
    lines.push(`  FAILED after ${outcome.infoMs} ms: ${outcome.infoError}`);
    lines.push('', `Result: FAILED — ${HINTS[outcome.failure] ?? HINTS['no-answer']}`);
    return truncateReport(redactor.scrub(lines.join('\n')));
  }
  const info = outcome.info || {};
  lines.push(`  Answered in ${outcome.infoMs} ms`);
  lines.push(
    `  Model ${info.model ?? info.type ?? '-'} · Gen ${outcome.gen} · firmware ${info.ver ?? info.fw ?? '-'} · ` +
      `authentication ${(info.auth_en ?? info.auth) ? 'ENABLED' : 'disabled'}`,
  );
  if (outcome.failure === 'not-a-shelly') {
    lines.push('', `Result: FAILED — ${HINTS['not-a-shelly']}`);
    return truncateReport(redactor.scrub(lines.join('\n')));
  }

  lines.push('');
  lines.push(outcome.gen >= 2 ? '[2] Shelly.GetStatus (RPC)' : '[2] GET /status (Gen1 REST)');
  if (outcome.statusError) {
    lines.push(`  FAILED after ${outcome.statusMs} ms: ${outcome.statusError}`);
    lines.push('', `Result: FAILED — ${HINTS[outcome.failure] ?? HINTS.status}`);
    return truncateReport(redactor.scrub(lines.join('\n')));
  }
  lines.push(
    `  Answered in ${outcome.statusMs} ms${outcome.authenticated ? ' (password accepted)' : ''}`,
  );
  lines.push(`  Components: ${componentSummary(outcome.status)}`);
  lines.push(`  Features the integration maps: ${outcome.featureCount}`);
  statusHealthLines(outcome.rawStatus ?? outcome.status).forEach((line) => lines.push(`  ${line}`));
  controlLines(outcome.status).forEach((line) => lines.push(`  ${line}`));

  if (outcome.runtime) {
    lines.push('');
    lines.push('[3] Integration side');
    const runtime = outcome.runtime;
    lines.push(
      `  Real-time: ${runtime.webSocketLive ? 'WebSocket live' : outcome.gen >= 2 ? 'WebSocket NOT live' : 'none (Gen1 is polled)'}` +
        `${runtime.mqttSeeded ? ' · MQTT live' : runtime.mqttKnown ? ' · seen on MQTT' : ''}`,
    );
    lines.push(
      `  Last transport: ${runtime.transport?.transport ?? 'not read yet'}` +
        `${runtime.transport?.degraded ? ' (degraded)' : ''} · last data ${formatAge(runtime.lastSeenAt, now)}`,
    );
    if (outcome.gen >= 2 && !runtime.webSocketLive) {
      lines.push(
        '  Hint: the device answers but does not push. Check that no other client holds its outbound WebSocket, and that it is not in "Prefer the cloud" mode.',
      );
    }
  }

  lines.push('', 'Result: OK — the device answers locally. Nothing was written to it.');
  return truncateReport(redactor.scrub(lines.join('\n')));
}
