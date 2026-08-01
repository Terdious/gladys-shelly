// -----------------------------------------------------------------------------
// Shelly constants shared by the whole integration.
//
// Naming rule for everything in this file: the keys mirror the Shelly RPC
// vocabulary verbatim (`switch:0`, `em:0`, `a_act_power`…) so a reader can move
// between the Shelly API documentation and this codebase without a decoder
// ring.
// -----------------------------------------------------------------------------

/** Device type used in the external ids: `ext:shelly:device:<shelly id>`. */
export const DEVICE_TYPE = 'device';

/** mDNS service Shelly devices announce themselves on. */
export const MDNS_SERVICE = '_shelly._tcp';

/** The service part of `_shelly._tcp`, used to tell a Shelly record from another service. */
export const MDNS_SERVICE_NAME = 'shelly';

/** Default HTTP port of a Shelly device. */
export const DEFAULT_HTTP_PORT = 80;

/** Timeout of a single local RPC call, in ms — a LAN device answers in tens of ms. */
export const LOCAL_RPC_TIMEOUT_MS = 5000;

/** Timeout of a single Shelly Cloud call, in ms — a WAN round trip, be generous. */
export const CLOUD_TIMEOUT_MS = 15000;

/** Maximum number of devices polled concurrently (kind to small LANs and to the core). */
export const POLL_CONCURRENCY = 4;

/** Duration of ONE mDNS browse round, in seconds. */
export const MDNS_ROUND_TIMEOUT_SECONDS = 12;

/** Number of mDNS browse rounds merged into one scan — a single snapshot comes back short. */
export const MDNS_ROUNDS = 2;

/**
 * Why a candidate address produced no device. Every value is surfaced at INFO
 * level at the end of a scan: "my Shelly is missing" must be diagnosable from
 * the integration log alone, without turning on debug logging.
 */
export const SKIP_REASON = {
  /** Nothing answered `GET /shelly` — wrong address, device off, other VLAN. */
  NO_ANSWER: 'no-answer',
  /** Something answered, but it is not a Shelly (no `id` in the document). */
  NOT_A_SHELLY: 'not-a-shelly',
  /** A Gen1 Shelly: answers `/shelly`, but speaks a completely different API. */
  GEN1: 'gen1',
  /** A Gen2+ Shelly that refused `Shelly.GetStatus` without credentials. */
  NEEDS_PASSWORD: 'needs-password',
  /** A Gen2+ Shelly that failed `Shelly.GetStatus` for any other reason. */
  NO_STATUS: 'no-status',
};

/**
 * Republish an unchanged value at least this often (ms), so a device that never
 * moves does not look dead on the Gladys charts. Between two keep-alives only
 * real changes are published — the host API rate-limits states at 300/minute.
 */
export const STATE_KEEP_ALIVE_MS = 30 * 60 * 1000;

/** Device params used to remember how to reach a device between restarts. */
export const PARAM_IP_ADDRESS = 'IP_ADDRESS';
export const PARAM_SHELLY_ID = 'SHELLY_ID';
export const PARAM_SHELLY_MODEL = 'SHELLY_MODEL';
export const PARAM_SHELLY_GEN = 'SHELLY_GEN';

/**
 * Component families of the Gen2+ status payload we map to Gladys features.
 * A Shelly status key is `<family>:<id>`, e.g. `switch:0`, `em:0`,
 * `temperature:100`.
 */
export const COMPONENT = {
  SWITCH: 'switch',
  COVER: 'cover',
  LIGHT: 'light',
  INPUT: 'input',
  /** Three-phase energy meter (Pro 3EM): instantaneous values. */
  EM: 'em',
  /** Three-phase energy meter: cumulated energy counters. */
  EMDATA: 'emdata',
  /** Single-phase energy meter (Pro EM, 1PM Mini Gen3): instantaneous values. */
  EM1: 'em1',
  /** Single-phase energy meter: cumulated energy counters. */
  EM1DATA: 'em1data',
  /** Standalone power meter (PM Mini). */
  PM1: 'pm1',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  DEVICEPOWER: 'devicepower',
};

/** Phases of a three-phase meter: Shelly prefix -> label used in feature ids. */
export const EM_PHASES = [
  { prefix: 'a', label: 'l1' },
  { prefix: 'b', label: 'l2' },
  { prefix: 'c', label: 'l3' },
];

/**
 * Human-readable names for the models the integration has been designed
 * against. Unknown models are NOT a failure: the device name falls back to the
 * raw model id, and the feature set is derived from the components the device
 * actually reports — so a Shelly released tomorrow still works.
 */
export const MODEL_NAMES = {
  'SNPL-00112EU': 'Shelly Plus Plug S',
  'SNPL-10112EU': 'Shelly Plus Plug S',
  'SNSW-001X16EU': 'Shelly Plus 1',
  'SNSW-001P16EU': 'Shelly Plus 1PM',
  'SNSW-002P16EU': 'Shelly Plus 2PM',
  'SPSW-001XE16EU': 'Shelly Pro 1',
  'SPSW-001PE16EU': 'Shelly Pro 1PM',
  'SPSW-002XE16EU': 'Shelly Pro 2',
  'SPSW-002PE16EU': 'Shelly Pro 2PM',
  'SPSW-003XE16EU': 'Shelly Pro 3',
  'SPSW-004PE16EU': 'Shelly Pro 4PM',
  'SPSW-104PE16EU': 'Shelly Pro 4PM',
  'SPSW-204PE16EU': 'Shelly Pro 4PM',
  'SPEM-002CEBEU50': 'Shelly Pro EM',
  'SPEM-003CEBEU': 'Shelly Pro 3EM',
  'SPEM-003CEBEU63': 'Shelly Pro 3EM',
  'SPEM-003CEBEU120': 'Shelly Pro 3EM',
  'SPEM-003CEBEU400': 'Shelly Pro 3EM',
  'S3SW-001P16EU': 'Shelly 1PM Gen3',
  'S3EM-003CXCEU63': 'Shelly 3EM Gen3',
};

/** Messages shown on the Configuration screen (multi-language, `en` mandatory). */
export const CONNECTION_MESSAGES = {
  LOCAL_ONLY: {
    en: 'Connected — local network only (Shelly Cloud fallback disabled).',
    fr: 'Connecté — réseau local uniquement (secours Shelly Cloud désactivé).',
  },
  LOCAL_AND_CLOUD: {
    en: 'Connected — local network, with the Shelly Cloud as a fallback.',
    fr: 'Connecté — réseau local, avec le Shelly Cloud en secours.',
  },
  CLOUD_INCOMPLETE: {
    en: 'Shelly Cloud enabled but incomplete: fill in the server address and the authorization key.',
    fr: "Shelly Cloud activé mais incomplet : renseignez l'adresse du serveur et la clé d'autorisation.",
  },
  CLOUD_REJECTED: {
    en: 'The Shelly Cloud rejected the authorization key. Copy it again from the Shelly app.',
    fr: "Le Shelly Cloud a refusé la clé d'autorisation. Recopiez-la depuis l'application Shelly.",
  },
  NO_DEVICE_YET: {
    en: 'Connected — no Shelly device found yet. Run a scan from the Discovery screen.',
    fr: 'Connecté — aucun appareil Shelly trouvé pour le moment. Lancez un scan depuis la page Découverte.',
  },
};

/** Reasons shown in the tooltip of a degraded transport badge. */
export const TRANSPORT_MESSAGES = {
  CLOUD_FALLBACK: {
    en: 'Device unreachable on the local network, falling back to the Shelly Cloud.',
    fr: 'Appareil injoignable sur le réseau local, bascule sur le Shelly Cloud.',
  },
  AUTH_FAILED: {
    en: 'The device refused the password. Check it in the integration configuration.',
    fr: "L'appareil a refusé le mot de passe. Vérifiez-le dans la configuration de l'intégration.",
  },
};
