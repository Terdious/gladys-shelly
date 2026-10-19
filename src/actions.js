// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the integration Configuration screen.
//
// Each key is declared in the manifest `actions` field and registered by
// index.js with `gladys.onAction(key, ...)`. Both are read-only diagnostics:
// they observe the installation and read the device, never write to it nor
// change its transport. The report is returned under the button with a short
// intro in the user's language, and logged at INFO in its masked form.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { buildDeviceTestReport, buildFleetDiagnostic } from './diagnostic.js';
import { readGeneration, readHost, readShellyId } from './shelly/deviceMapping.js';
import { buildFeatureSpecs } from './shelly/features.js';
import { getGen1Status } from './shelly/gen1/rest.js';
import { normalizeGen1Status, normalizeGen1Info } from './shelly/gen1/normalize.js';
import { createRpcClient, getShellyInfo, ShellyAuthError } from './shelly/rpc.js';

const logger = createLogger({ name: 'diagnostic' });

/** Intro of a report, in every Gladys language: what to do with it. */
export const REPORT_INTROS = {
  masked: {
    en: 'Report below (also in the integration logs). Copy it as is into a GitHub issue: MAC addresses are shortened, local addresses hidden, and it never contains a password nor the cloud key.',
    fr: "Rapport ci-dessous (aussi dans les journaux de l'intégration). Copiez-le tel quel dans une issue GitHub : les adresses MAC sont raccourcies, les adresses locales masquées, et il ne contient jamais de mot de passe ni la clé cloud.",
    de: 'Bericht unten (auch in den Protokollen der Integration). Kopiere ihn unverändert in ein GitHub-Issue: MAC-Adressen sind gekürzt, lokale Adressen verborgen, und er enthält nie ein Passwort oder den Cloud-Schlüssel.',
    es: 'Informe a continuación (también en los registros de la integración). Cópielo tal cual en una issue de GitHub: las direcciones MAC están acortadas, las direcciones locales ocultas, y nunca contiene contraseñas ni la clave de la nube.',
  },
  full: {
    en: 'Report below, WITH the full device ids and local addresses: do not post it publicly (the logs only keep the masked version). It never contains a password nor the cloud key.',
    fr: "Rapport ci-dessous, AVEC les identifiants et adresses locales complets : ne le publiez pas (les journaux n'en gardent que la version masquée). Il ne contient jamais de mot de passe ni la clé cloud.",
    de: 'Bericht unten, MIT vollständigen Geräte-IDs und lokalen Adressen: nicht öffentlich posten (die Protokolle behalten nur die maskierte Fassung). Er enthält nie ein Passwort oder den Cloud-Schlüssel.',
    es: 'Informe a continuación, CON los identificadores y direcciones locales completos: no lo publique (los registros solo guardan la versión ocultada). Nunca contiene contraseñas ni la clave de la nube.',
  },
};

export const DEVICE_REQUIRED_MESSAGE = {
  en: 'Pick a device in the list, or type the IP address, the Shelly id or the name of a device.',
  fr: "Choisissez un appareil dans la liste, ou saisissez l'adresse IP, l'identifiant Shelly ou le nom d'un appareil.",
  de: 'Wähle ein Gerät in der Liste, oder gib die IP-Adresse, die Shelly-ID oder den Namen eines Geräts ein.',
  es: 'Elija un dispositivo en la lista, o escriba la dirección IP, el identificador Shelly o el nombre de un dispositivo.',
};

/** A form boolean: true, or "true" / "1" / "yes" / "on". */
function isChecked(value) {
  return value === true || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * The device an action designates: the one picked in the list (`device`, the
 * external id of a device created in Gladys) wins over the free text
 * (`device_ref`: IP address, Shelly id or name).
 * @param {object} fields action fields
 * @returns {string} the reference, '' when none
 */
export function referenceOf(fields) {
  const picked = String(fields.device ?? '').trim();
  return picked !== '' ? picked : String(fields.device_ref ?? '').trim();
}

/** Every secret of the configuration, scrubbed from the reports. */
function secretsOf(config) {
  return [config.devicePassword, config.cloudAuthKey, config.mqttPassword].filter(Boolean);
}

/**
 * Find the created device a reference designates.
 * @param {object[]} devices the devices created in Gladys
 * @param {string} reference external id, Shelly id, name or address
 * @returns {object|undefined} the device
 */
export function findDevice(devices, reference) {
  const wanted = reference.toLowerCase();
  return (
    devices.find((device) => device.external_id === reference) ||
    devices.find((device) => String(readShellyId(device) || '').toLowerCase() === wanted) ||
    devices.find((device) => String(device.name || '').toLowerCase() === wanted) ||
    devices.find((device) => String(readHost(device) || '').toLowerCase() === wanted)
  );
}

/** The action result: the localized intro, then the (English) report. */
function withIntro(report, includeIdentifiers) {
  const intro = REPORT_INTROS[includeIdentifiers ? 'full' : 'masked'];
  return Object.fromEntries(
    Object.entries(intro).map(([language, text]) => [language, `${text}\n\n${report}`]),
  );
}

/** Whether the devices list is about this integration's Shelly devices. */
function shellyDevices(devices) {
  return (devices || []).filter((device) => readShellyId(device));
}

/**
 * Gather the raw snapshot of the fleet diagnostic.
 * @param {object} deps runtime modules
 * @param {object} options gathering options
 * @param {string} [options.filter] one device only
 * @returns {Promise<object>} the snapshot
 */
export async function gatherFleet({ gladys, client, telemetry, getConfig }, { filter } = {}) {
  const config = getConfig();
  let devices = [];
  try {
    devices = shellyDevices(await gladys.getDevices());
  } catch (err) {
    logger.warn(`Diagnostic: could not list the devices (${err.message})`);
  }
  if (filter) {
    const match = findDevice(devices, filter);
    devices = match ? [match] : [];
  }
  return {
    config,
    filter,
    secrets: secretsOf(config),
    budget: telemetry.describeBudget(),
    devices: devices.map((device) => {
      const shellyId = readShellyId(device);
      return {
        name: device.name,
        shellyId,
        host: readHost(device),
        gen: readGeneration(device),
        model: device.params?.find((param) => param.name === 'SHELLY_MODEL')?.value,
        featureCount: (device.features || []).length,
        runtime: telemetry.describeDevice(shellyId),
        localHealth: client.localHealth?.(shellyId),
      };
    }),
  };
}

/**
 * Read one device now, at the address the integration uses, and time it.
 * Read-only: `/shelly`, then `Shelly.GetStatus` or Gen1 `/status`.
 * @param {object} deps runtime modules
 * @param {string} reference external id, Shelly id, name or IP address
 * @returns {Promise<object>} the outcome
 */
export async function testDevice({ gladys, telemetry, getConfig, fetchImpl = fetch }, reference) {
  const config = getConfig();
  let devices = [];
  try {
    devices = shellyDevices(await gladys.getDevices());
  } catch (err) {
    logger.debug(`Device test: could not list the devices (${err.message})`);
  }
  const device = findDevice(devices, reference);
  const outcome = { secrets: secretsOf(config) };
  if (device) {
    outcome.name = device.name;
    outcome.shellyId = readShellyId(device);
    outcome.host = readHost(device);
    outcome.hostOrigin = 'last address found by the discovery';
  } else if (/^[\w.-]+(:\d+)?$/.test(reference) && /[.\d]/.test(reference)) {
    outcome.host = reference;
    outcome.hostOrigin = 'typed in the form';
  }
  if (!outcome.host) {
    outcome.failure = 'no-address';
    return outcome;
  }

  const started = Date.now();
  try {
    outcome.info = await getShellyInfo({ host: outcome.host, fetchImpl });
    outcome.infoMs = Date.now() - started;
  } catch (err) {
    outcome.infoMs = Date.now() - started;
    outcome.infoError = err.message;
    outcome.failure = 'no-answer';
    return outcome;
  }

  const generation = Number(outcome.info?.gen);
  outcome.gen = Number.isFinite(generation) && generation >= 2 ? generation : 1;
  if (outcome.gen === 1) {
    if (!outcome.info?.type || !outcome.info?.mac) {
      outcome.failure = 'not-a-shelly';
      return outcome;
    }
    outcome.info = normalizeGen1Info(outcome.info);
  } else if (!outcome.info?.id) {
    outcome.failure = 'not-a-shelly';
    return outcome;
  }
  outcome.shellyId = outcome.shellyId || outcome.info.id;

  const statusStarted = Date.now();
  try {
    if (outcome.gen >= 2) {
      // A fresh client: the test must not reuse, nor disturb, the digest
      // state the telemetry holds for this device.
      const rpc = createRpcClient({
        host: outcome.host,
        username: config.deviceUsername,
        password: config.devicePassword,
        fetchImpl,
      });
      outcome.status = await rpc.call('Shelly.GetStatus');
    } else {
      outcome.rawStatus = await getGen1Status({
        host: outcome.host,
        username: config.deviceUsername,
        password: config.devicePassword,
        fetchImpl,
      });
      outcome.status = normalizeGen1Status(outcome.rawStatus);
    }
    outcome.statusMs = Date.now() - statusStarted;
    outcome.authenticated = Boolean(
      (outcome.info.auth_en || outcome.info.auth) && config.devicePassword,
    );
    outcome.featureCount = buildFeatureSpecs(outcome.status).length;
  } catch (err) {
    outcome.statusMs = Date.now() - statusStarted;
    outcome.statusError = err.message;
    outcome.failure = err instanceof ShellyAuthError ? 'auth' : 'status';
    return outcome;
  }

  outcome.runtime = telemetry.describeDevice(outcome.shellyId);
  return outcome;
}

/**
 * Build the action handlers.
 * @param {object} deps runtime modules ({ gladys, client, telemetry, getConfig, fetchImpl })
 * @returns {Record<string, (fields: object) => Promise<object>>} handlers by action key
 */
export function createActions(deps) {
  return {
    async fleet_diagnostic(fields = {}) {
      const includeIdentifiers = isChecked(fields.include_identifiers);
      const filter = referenceOf(fields);
      logger.info(
        `Action fleet_diagnostic <- ${filter ? 'one device' : 'every device'}, ` +
          `identifiers ${includeIdentifiers ? 'shown' : 'masked'}`,
      );
      const snapshot = await gatherFleet(deps, { filter });
      const now = Date.now();
      const masked = buildFleetDiagnostic(snapshot, { includeIdentifiers: false, now });
      // The logs keep the masked version only: they get shared too.
      logger.info(`[diagnostic]\n${masked}`);
      const report = includeIdentifiers
        ? buildFleetDiagnostic(snapshot, { includeIdentifiers: true, now })
        : masked;
      return withIntro(report, includeIdentifiers);
    },

    async test_device(fields = {}) {
      const reference = referenceOf(fields);
      if (reference === '') {
        throw new Error(DEVICE_REQUIRED_MESSAGE.en);
      }
      const includeIdentifiers = isChecked(fields.include_identifiers);
      logger.info(`Action test_device <- identifiers ${includeIdentifiers ? 'shown' : 'masked'}`);
      const outcome = await testDevice(deps, reference);
      const now = Date.now();
      const masked = buildDeviceTestReport(outcome, { includeIdentifiers: false, now });
      logger.info(`[diagnostic]\n${masked}`);
      const report = includeIdentifiers
        ? buildDeviceTestReport(outcome, { includeIdentifiers: true, now })
        : masked;
      return withIntro(report, includeIdentifiers);
    },
  };
}
