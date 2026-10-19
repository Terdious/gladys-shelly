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

/**
 * Generic service Gen1 devices announce on. They do NOT use `_shelly._tcp`, so
 * a Gen1 fleet is invisible to a browse that only declares the Shelly service.
 */
export const MDNS_GEN1_SERVICE = '_http._tcp';

/**
 * `_http._tcp` is shared with every printer and NAS on the LAN, so a Gen1
 * record is only recognizable by this name prefix (`shellyem3-483fdac37e3f`).
 */
export const GEN1_MDNS_NAME_PREFIX = 'shelly';

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
  /** Dimmer output: on/off and brightness. */
  LIGHT: 'light',
  /** Colour outputs (Plus RGBW PM, Pro RGBWW PM): `rgb` array, brightness. */
  RGB: 'rgb',
  RGBW: 'rgbw',
  /** Tunable-white output: brightness and colour temperature `ct` in kelvin. */
  CCT: 'cct',
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
  'S3SW-001X16EU': 'Shelly 1 Gen3',
  'S3SW-002P16EU': 'Shelly 2PM Gen3',
  'S3PL-00112EU': 'Shelly Plug S Gen3',
  'SNSN-0024X': 'Shelly Plus i4',
  'S3SN-0024X': 'Shelly i4 Gen3',
  'SNDC-0D4P10WW': 'Shelly Plus RGBW PM',
  'SNDM-00100WW': 'Shelly Plus 0-10V Dimmer',
  'SPSH-002PE16EU': 'Shelly Pro Dual Cover PM',
  'S3EM-003CXCEU63': 'Shelly 3EM Gen3',
};

/** Messages shown on the Configuration screen, in the four Gladys languages. */
export const CONNECTION_MESSAGES = {
  LOCAL_ONLY: {
    en: 'Connected — local network only (Shelly Cloud fallback disabled).',
    fr: 'Connecté — réseau local uniquement (secours Shelly Cloud désactivé).',
    de: 'Verbunden — nur lokales Netzwerk (Shelly-Cloud-Ausweichlösung deaktiviert).',
    es: 'Conectado — solo red local (respaldo de Shelly Cloud desactivado).',
  },
  LOCAL_AND_CLOUD: {
    en: 'Connected — local network, with the Shelly Cloud as a fallback.',
    fr: 'Connecté — réseau local, avec le Shelly Cloud en secours.',
    de: 'Verbunden — lokales Netzwerk, mit der Shelly Cloud als Ausweichlösung.',
    es: 'Conectado — red local, con la Shelly Cloud como respaldo.',
  },
  CLOUD_INCOMPLETE: {
    en: 'Shelly Cloud enabled but incomplete: fill in the server address and the authorization key.',
    fr: "Shelly Cloud activé mais incomplet : renseignez l'adresse du serveur et la clé d'autorisation.",
    de: 'Shelly Cloud aktiviert, aber unvollständig: Gib die Serveradresse und den Autorisierungsschlüssel ein.',
    es: 'Shelly Cloud activada pero incompleta: indique la dirección del servidor y la clave de autorización.',
  },
  CLOUD_REJECTED: {
    en: 'The Shelly Cloud rejected the authorization key. Copy it again from the Shelly app.',
    fr: "Le Shelly Cloud a refusé la clé d'autorisation. Recopiez-la depuis l'application Shelly.",
    de: 'Die Shelly Cloud hat den Autorisierungsschlüssel abgelehnt. Kopiere ihn erneut aus der Shelly-App.',
    es: 'La Shelly Cloud rechazó la clave de autorización. Cópiela de nuevo desde la app Shelly.',
  },
  NO_DEVICE_YET: {
    en: 'Connected — no Shelly device found yet. Run a scan from the Discovery screen.',
    fr: 'Connecté — aucun appareil Shelly trouvé pour le moment. Lancez un scan depuis la page Découverte.',
    de: 'Verbunden — noch kein Shelly-Gerät gefunden. Starte einen Scan auf der Seite Erkennung.',
    es: 'Conectado — aún no se ha encontrado ningún Shelly. Lance un escaneo desde la página Descubrimiento.',
  },
};

/** Reasons shown in the tooltip of a degraded transport badge. */
export const TRANSPORT_MESSAGES = {
  CLOUD_FALLBACK: {
    en: 'Device unreachable on the local network, falling back to the Shelly Cloud.',
    fr: 'Appareil injoignable sur le réseau local, bascule sur le Shelly Cloud.',
    de: 'Gerät im lokalen Netzwerk nicht erreichbar, Ausweichen auf die Shelly Cloud.',
    es: 'Dispositivo inaccesible en la red local, se recurre a la Shelly Cloud.',
  },
  MQTT_FALLBACK: {
    en: 'Device unreachable on the local network, served through your MQTT broker.',
    fr: 'Appareil injoignable sur le réseau local, servi via votre broker MQTT.',
    de: 'Gerät im lokalen Netzwerk nicht erreichbar, bedient über deinen MQTT-Broker.',
    es: 'Dispositivo inaccesible en la red local, servido a través de su broker MQTT.',
  },
  AUTH_FAILED: {
    en: 'The device refused the password. Check it in the integration configuration.',
    fr: "L'appareil a refusé le mot de passe. Vérifiez-le dans la configuration de l'intégration.",
    de: 'Das Gerät hat das Passwort abgelehnt. Prüfe es in der Konfiguration der Integration.',
    es: 'El dispositivo rechazó la contraseña. Compruébela en la configuración de la integración.',
  },
};
