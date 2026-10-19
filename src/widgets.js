// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+).
//
//   - `energy_meter`: one metering Shelly (Pro 3EM, Pro EM, PM Mini, a plug or
//     a relay with metering) — live power gauge and phase tiles bound to the
//     device features, the power chart, and the voltages, currents and
//     returned energy of the last reading;
//   - `switches`: a set of relays and lights (empty = all), on/off and power
//     per channel, the total, and "all on" / "all off" buttons;
//   - `shutters`: a set of covers (empty = all), state and position per cover,
//     and open / stop / close / go-to-position buttons for the whole set;
//   - `network`: the health of the Shelly fleet — how many devices push in
//     real time, fall back, or are unreachable, the weak Wi-Fi signals and
//     the firmware updates, and the share of the Gladys state budget used.
//
// The manifest allows at most 5 widgets and their keys are stored in the
// users' dashboards: never rename one. index.js registers `get` with
// onWidgetGet and `action` with onWidgetAction. The content budget of the
// core (8 components, 6 tiles, 1 status of 10 rows, 4 buttons) decides what
// each widget shows. Texts are multi-language objects: the core picks the
// user's language.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { WEAK_RSSI_DBM } from './diagnostic.js';
import { readShellyId } from './shelly/deviceMapping.js';
import { parseFeatureKey, setDeviceValue } from './shelly/setValue.js';

const logger = createLogger({ name: 'widgets' });

export const ENERGY_METER_WIDGET = 'energy_meter';
export const SWITCHES_WIDGET = 'switches';
export const SHUTTERS_WIDGET = 'shutters';
export const NETWORK_WIDGET = 'network';

/** Keys of the button actions, stored in the widget contents only. */
export const WIDGET_ACTIONS = {
  ALL_ON: 'all_on',
  ALL_OFF: 'all_off',
  OPEN: 'open',
  STOP: 'stop',
  CLOSE: 'close',
  POSITION: 'position',
};

/** Rows of a status component, and components of a content, the core keeps. */
const MAX_STATUS_ROWS = 10;
const MAX_COMPONENTS = 8;

/** Chart windows offered by the energy meter widget (the core enum). */
export const CHART_INTERVALS = ['last-hour', 'last-twelve-hours', 'last-day', 'last-week'];

const T = (en, fr, de, es) => ({ en, fr, de, es });

const TEXT = {
  chooseDevice: T(
    'Choose a device in the settings of this widget.',
    'Choisissez un appareil dans les réglages de ce widget.',
    'Wähle in den Einstellungen dieses Widgets ein Gerät.',
    'Elija un dispositivo en los ajustes de este widget.',
  ),
  noMeter: T(
    'This device reports no power measurement.',
    'Cet appareil ne remonte aucune mesure de puissance.',
    'Dieses Gerät meldet keine Leistungsmessung.',
    'Este dispositivo no informa ninguna medida de potencia.',
  ),
  noSwitch: T(
    'No relay nor light among the selected devices.',
    'Aucun relais ni lumière parmi les appareils choisis.',
    'Kein Relais und kein Licht unter den gewählten Geräten.',
    'Ningún relé ni luz entre los dispositivos elegidos.',
  ),
  noCover: T(
    'No shutter among the selected devices.',
    'Aucun volet parmi les appareils choisis.',
    'Kein Rollladen unter den gewählten Geräten.',
    'Ninguna persiana entre los dispositivos elegidos.',
  ),
  noDevice: T(
    'No Shelly device created yet: run a scan in the Discover tab.',
    "Aucun appareil Shelly créé : lancez un scan dans l'onglet Découverte.",
    'Noch kein Shelly-Gerät angelegt: Starte einen Scan im Reiter Erkennung.',
    'Ningún dispositivo Shelly creado: lance un escaneo en la pestaña Descubrimiento.',
  ),
  power: T('Power', 'Puissance', 'Leistung', 'Potencia'),
  totalEnergy: T('Energy', 'Énergie', 'Energie', 'Energía'),
  returned: T('Returned', 'Réinjectée', 'Eingespeist', 'Devuelta'),
  voltage: T('Voltage', 'Tension', 'Spannung', 'Tensión'),
  current: T('Current', 'Intensité', 'Strom', 'Corriente'),
  neutral: T('Neutral current', 'Courant de neutre', 'Neutralleiterstrom', 'Corriente del neutro'),
  apparent: T('Apparent power', 'Puissance apparente', 'Scheinleistung', 'Potencia aparente'),
  powerFactor: T('Power factor', 'Facteur de puissance', 'Leistungsfaktor', 'Factor de potencia'),
  frequency: T('Frequency', 'Fréquence', 'Frequenz', 'Frecuencia'),
  source: T('Source', 'Source', 'Quelle', 'Fuente'),
  lastData: T('Last data', 'Dernière donnée', 'Letzte Daten', 'Último dato'),
  on: T('On', 'Allumé', 'An', 'Encendido'),
  off: T('Off', 'Éteint', 'Aus', 'Apagado'),
  switchedOn: T('On', 'Allumés', 'An', 'Encendidos'),
  allOn: T('All on', 'Tout allumer', 'Alle an', 'Encender todo'),
  allOff: T('All off', 'Tout éteindre', 'Alle aus', 'Apagar todo'),
  open: T('Open', 'Ouvrir', 'Öffnen', 'Abrir'),
  stop: T('Stop', 'Stop', 'Stopp', 'Parar'),
  close: T('Close', 'Fermer', 'Schließen', 'Cerrar'),
  positionButton: T('Position', 'Position', 'Position', 'Posición'),
  positionField: T('Position (%)', 'Position (%)', 'Position (%)', 'Posición (%)'),
  averagePosition: T('Average position', 'Position moyenne', 'Mittlere Position', 'Posición media'),
  opened: T('Open', 'Ouvert', 'Offen', 'Abierta'),
  closed: T('Closed', 'Fermé', 'Geschlossen', 'Cerrada'),
  opening: T('Opening', 'En ouverture', 'Öffnet', 'Abriendo'),
  closing: T('Closing', 'En fermeture', 'Schließt', 'Cerrando'),
  stopped: T('Stopped', 'Arrêté', 'Gestoppt', 'Parada'),
  calibrating: T('Calibrating', 'Calibrage', 'Kalibrierung', 'Calibrando'),
  unreachable: T('Unreachable', 'Injoignable', 'Nicht erreichbar', 'Inaccesible'),
  devices: T('Devices', 'Appareils', 'Geräte', 'Dispositivos'),
  realtime: T('Real time', 'Temps réel', 'Echtzeit', 'Tiempo real'),
  fallback: T('Fallback', 'Secours', 'Ausweich', 'Respaldo'),
  degraded: T(
    'Fallback (degraded)',
    'Secours (dégradé)',
    'Ausweich (eingeschränkt)',
    'Respaldo (degradado)',
  ),
  weakWifi: T('Weak Wi-Fi', 'Wi-Fi faible', 'Schwaches WLAN', 'Wi-Fi débil'),
  update: T(
    'Firmware update',
    'Mise à jour firmware',
    'Firmware-Update',
    'Actualización de firmware',
  ),
  allOk: T(
    'Every device answers normally',
    'Tous les appareils répondent normalement',
    'Alle Geräte antworten normal',
    'Todos los dispositivos responden con normalidad',
  ),
  everyDevice: T('Every device', 'Tous les appareils', 'Alle Geräte', 'Todos los dispositivos'),
};

/** Join a multi-language label and a plain value: `{en: 'L1 2.1 kW', ...}`. */
const withValue = (label, value) =>
  Object.fromEntries(
    Object.entries(label).map(([language, text]) => [language, `${text} ${value}`.trim()]),
  );

/** `1 234 W` or `12.3 kW`, short enough for a tile or a status value. */
export function formatPower(watts) {
  if (typeof watts !== 'number' || !Number.isFinite(watts)) {
    return '-';
  }
  return Math.abs(watts) >= 10000 ? `${(watts / 1000).toFixed(1)} kW` : `${Math.round(watts)} W`;
}

/** `5 s`, `3 min`, `2 h`. */
function formatAge(at, now) {
  if (!at) {
    return '-';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 120) {
    return `${seconds} s`;
  }
  return seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
}

/** Normalize a multi_select setting (array, comma string, or empty = all). */
export function selectedIds(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * The Shelly devices created in Gladys, restricted to a selection.
 * @param {object} gladys the SDK instance
 * @param {string[]} ids selected device external ids, empty = all
 * @returns {Promise<object[]>} the devices
 */
async function devicesOf(gladys, ids) {
  const devices = ((await gladys.getDevices()) || []).filter((device) => readShellyId(device));
  return ids.length === 0 ? devices : devices.filter((device) => ids.includes(device.external_id));
}

/** The feature of a device whose external id ends with a component key suffix. */
function featureOf(device, key) {
  return (device.features || []).find((feature) => feature.external_id.endsWith(`:${key}`));
}

/** `{family, index, suffix}` of every feature matching a predicate. */
function featuresWhere(device, predicate) {
  return (device.features || [])
    .map((feature) => ({ feature, key: parseFeatureKey(feature.external_id) }))
    .filter(({ key }) => key && predicate(key));
}

/** Source row: local / cloud / unreachable, with the age of the last data. */
function sourceText(runtime, now) {
  const transport = runtime?.transport?.transport;
  if (transport === 'unreachable') {
    return { value: TEXT.unreachable, color: WIDGET_COLORS.DANGER };
  }
  const channel = runtime?.webSocketLive ? 'WebSocket' : runtime?.mqttSeeded ? 'MQTT' : transport;
  return {
    value: `${channel ?? '-'} · ${formatAge(runtime?.lastSeenAt, now)}`,
    color: runtime?.transport?.degraded ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  };
}

/** A content made of one message (empty states). */
const messageContent = (text) => ({ ttl_seconds: 60, components: [{ type: 'text', text }] });

/**
 * The metering layout of a device: the main power feature and the per-phase
 * ones, whatever the hardware (Pro 3EM, Pro EM, PM Mini, a plug...).
 * @param {object} device a Gladys device
 * @returns {object|undefined} the layout, undefined without any power
 */
export function meterLayout(device) {
  const em = featureOf(device, 'em:0:total_active_power');
  if (em) {
    return {
      kind: 'three-phase',
      main: em,
      phases: ['l1', 'l2', 'l3']
        .map((phase) => ({ phase, feature: featureOf(device, `em:0:${phase}_active_power`) }))
        .filter(({ feature }) => feature),
      energy: featureOf(device, 'emdata:0:total_energy'),
      returned: featureOf(device, 'emdata:0:total_returned_energy'),
      component: 'em:0',
    };
  }
  for (const family of ['em1', 'pm1', 'switch', 'light', 'cover']) {
    const powers = featuresWhere(
      device,
      (key) => key.family === family && (key.suffix === 'active_power' || key.suffix === 'power'),
    );
    if (powers.length > 0) {
      const index = powers[0].key.index;
      return {
        kind: 'single',
        main: powers[0].feature,
        // A multi-channel device (Pro EM, Pro 4PM): the other channels as tiles.
        phases: powers
          .slice(1, 4)
          .map(({ feature, key }) => ({ phase: `${key.family} ${key.index}`, feature })),
        energy: featureOf(
          device,
          `${family === 'em1' ? 'em1data' : family}:${index}:${family === 'em1' ? 'total_energy' : 'energy'}`,
        ),
        returned:
          family === 'em1'
            ? featureOf(device, `em1data:${index}:total_returned_energy`)
            : undefined,
        component: `${family}:${index}`,
      };
    }
  }
  return undefined;
}

/**
 * Status rows of a meter, from the last reading.
 * @param {object} layout the meter layout
 * @param {object|undefined} status the last known status
 * @returns {object[]} the rows
 */
function meterRows(layout, status) {
  const rows = [];
  const component = status?.[layout.component];
  if (!component) {
    return rows;
  }
  const number = (value, unit, decimals = 1) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${value.toFixed(decimals)} ${unit}`
      : undefined;
  if (layout.kind === 'three-phase') {
    const voltages = ['a', 'b', 'c']
      .map((p) => number(component[`${p}_voltage`], 'V', 0))
      .filter(Boolean);
    if (voltages.length > 0) {
      rows.push({ label: TEXT.voltage, value: voltages.join(' · ') });
    }
    const currents = ['a', 'b', 'c']
      .map((p) => number(component[`${p}_current`], 'A'))
      .filter(Boolean);
    if (currents.length > 0) {
      rows.push({ label: TEXT.current, value: currents.join(' · ') });
    }
    const neutral = number(component.n_current, 'A', 2);
    if (neutral) {
      rows.push({ label: TEXT.neutral, value: neutral });
    }
    const apparent = component.total_aprt_power;
    if (typeof apparent === 'number') {
      rows.push({ label: TEXT.apparent, value: `${Math.round(apparent)} VA` });
    }
    const pfs = ['a', 'b', 'c']
      .map((p) => component[`${p}_pf`])
      .filter((v) => typeof v === 'number');
    if (pfs.length > 0) {
      rows.push({ label: TEXT.powerFactor, value: pfs.map((v) => v.toFixed(2)).join(' · ') });
    }
    const freq = component.a_freq ?? component.b_freq;
    if (typeof freq === 'number') {
      rows.push({ label: TEXT.frequency, value: `${freq.toFixed(1)} Hz` });
    }
    return rows;
  }
  const voltage = number(component.voltage, 'V', 0);
  if (voltage) {
    rows.push({ label: TEXT.voltage, value: voltage });
  }
  const current = number(component.current, 'A', 2);
  if (current) {
    rows.push({ label: TEXT.current, value: current });
  }
  if (typeof component.aprt_power === 'number') {
    rows.push({ label: TEXT.apparent, value: `${Math.round(component.aprt_power)} VA` });
  }
  if (typeof component.pf === 'number') {
    rows.push({ label: TEXT.powerFactor, value: component.pf.toFixed(2) });
  }
  if (typeof component.freq === 'number') {
    rows.push({ label: TEXT.frequency, value: `${component.freq.toFixed(1)} Hz` });
  }
  return rows;
}

/**
 * Build the widgets, bound to the runtime modules.
 * @param {object} deps runtime modules ({ gladys, client, telemetry })
 * @param {object} [options] options
 * @param {() => number} [options.now] clock (tests)
 * @returns {Record<string, {get: Function, action?: Function}>} widgets by key
 */
export function createWidgets({ gladys, client, telemetry }, { now = Date.now } = {}) {
  const runtimeOf = (device) => telemetry.describeDevice(readShellyId(device));

  /** Every controllable on/off channel of the selected devices. */
  async function switchChannels(settings) {
    const devices = await devicesOf(gladys, selectedIds(settings?.devices));
    return devices.flatMap((device) =>
      featuresWhere(
        device,
        (key) =>
          key.suffix === 'binary' && ['switch', 'light', 'rgb', 'rgbw', 'cct'].includes(key.family),
      ).map(({ feature, key }) => ({ device, feature, key })),
    );
  }

  /** Every cover of the selected devices. */
  async function covers(settings) {
    const devices = await devicesOf(gladys, selectedIds(settings?.devices));
    return devices.flatMap((device) =>
      featuresWhere(device, (key) => key.family === 'cover' && key.suffix === 'state').map(
        ({ feature, key }) => ({
          device,
          feature,
          key,
          position: featureOf(device, `cover:${key.index}:position`),
        }),
      ),
    );
  }

  /**
   * Run one command per channel, in sequence (a fleet of relays on one
   * breaker must not all switch in the same millisecond).
   * @returns {Promise<{done: number, failed: number}>} the outcome
   */
  async function applyAll(targets, value) {
    let done = 0;
    let failed = 0;
    for (const { device, feature } of targets) {
      try {
        await setDeviceValue({ gladys, client }, { device, feature, value });
        done += 1;
      } catch (err) {
        failed += 1;
        logger.warn(`Widget command on ${feature.external_id} failed: ${err.message}`);
      }
    }
    return { done, failed };
  }

  /** Toast of a widget action. */
  const toast = ({ done, failed }) =>
    failed === 0
      ? T(
          `${done} channel(s) done`,
          `${done} voie(s) traitée(s)`,
          `${done} Kanal/Kanäle erledigt`,
          `${done} canal(es) hecho(s)`,
        )
      : T(
          `${done} done, ${failed} failed (see the logs)`,
          `${done} traitée(s), ${failed} en échec (voir les journaux)`,
          `${done} erledigt, ${failed} fehlgeschlagen (siehe Protokolle)`,
          `${done} hecho(s), ${failed} con error (ver los registros)`,
        );

  return {
    [ENERGY_METER_WIDGET]: {
      async get({ settings = {} }) {
        if (!settings.device) {
          return messageContent(TEXT.chooseDevice);
        }
        const [device] = await devicesOf(gladys, [String(settings.device)]);
        if (!device) {
          return messageContent(TEXT.chooseDevice);
        }
        const layout = meterLayout(device);
        if (!layout) {
          return messageContent(TEXT.noMeter);
        }
        const runtime = runtimeOf(device);
        const maxPower = Number(settings.max_power) > 0 ? Number(settings.max_power) : 6000;
        const interval = CHART_INTERVALS.includes(settings.interval)
          ? settings.interval
          : 'last-day';
        const components = [
          { type: 'text', variant: 'heading', text: device.name },
          {
            type: 'gauge',
            label: TEXT.power,
            device_feature: layout.main.external_id,
            // A meter that sees returned energy swings both ways.
            min: layout.returned ? -maxPower : 0,
            max: maxPower,
          },
          ...layout.phases.map(({ phase, feature }) => ({
            type: 'value',
            label: phase.toUpperCase(),
            device_feature: feature.external_id,
          })),
        ];
        if (layout.energy) {
          components.push({
            type: 'value',
            label: TEXT.totalEnergy,
            device_feature: layout.energy.external_id,
          });
        }
        // Heading, chart and status take three of the 8 components: the
        // returned energy gets a tile only when there is room left, a status
        // row (last reading) otherwise.
        const returnedRow = [];
        if (layout.returned && components.length + 4 <= MAX_COMPONENTS) {
          components.push({
            type: 'value',
            label: TEXT.returned,
            device_feature: layout.returned.external_id,
          });
        } else if (layout.returned && typeof layout.returned.last_value === 'number') {
          returnedRow.push({ label: TEXT.returned, value: `${layout.returned.last_value} kWh` });
        }
        components.push({
          type: 'chart',
          chart_type: 'area',
          device_features: [layout.main.external_id],
          interval,
        });
        const source = sourceText(runtime, now());
        const rows = [
          ...meterRows(layout, runtime.status),
          ...returnedRow,
          { label: TEXT.source, value: source.value, color: source.color },
        ].slice(-MAX_STATUS_ROWS);
        components.push({ type: 'status', items: rows });
        return { ttl_seconds: 30, components };
      },
    },

    [SWITCHES_WIDGET]: {
      async get({ settings = {} }) {
        const channels = await switchChannels(settings);
        if (channels.length === 0) {
          return messageContent(TEXT.noSwitch);
        }
        let onCount = 0;
        let totalPower = 0;
        let havePower = false;
        const rows = channels.map(({ device, feature, key }) => {
          const runtime = runtimeOf(device);
          const component = runtime.status?.[`${key.family}:${key.index}`];
          if (runtime.transport?.transport === 'unreachable') {
            return { label: feature.name, value: TEXT.unreachable, color: WIDGET_COLORS.DANGER };
          }
          const on = component ? Boolean(component.output) : Number(feature.last_value) === 1;
          if (on) {
            onCount += 1;
          }
          if (typeof component?.apower === 'number') {
            totalPower += component.apower;
            havePower = true;
          }
          const power =
            typeof component?.apower === 'number' ? `· ${formatPower(component.apower)}` : '';
          return {
            label:
              channels.length > 1 && !feature.name.includes(device.name)
                ? `${device.name} — ${feature.name}`
                : feature.name,
            value: withValue(on ? TEXT.on : TEXT.off, power),
            color: on ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
          };
        });
        const components = [];
        if (settings.title) {
          components.push({
            type: 'text',
            variant: 'heading',
            text: String(settings.title).slice(0, 40),
          });
        }
        components.push({
          type: 'value',
          label: TEXT.switchedOn,
          value: `${onCount}/${channels.length}`,
          icon: 'toggle-right',
          color: onCount > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
        });
        if (havePower) {
          components.push({
            type: 'value',
            label: TEXT.power,
            value: formatPower(totalPower),
            icon: 'zap',
          });
        }
        components.push({ type: 'status', items: rows.slice(0, MAX_STATUS_ROWS) });
        components.push(
          {
            type: 'button',
            label: TEXT.allOn,
            icon: 'power',
            style: 'secondary',
            action: { key: WIDGET_ACTIONS.ALL_ON, confirm: true },
          },
          {
            type: 'button',
            label: TEXT.allOff,
            icon: 'power',
            style: 'danger',
            action: { key: WIDGET_ACTIONS.ALL_OFF, confirm: true },
          },
        );
        return { ttl_seconds: 15, components };
      },

      async action(actionKey, _params, { settings = {} } = {}) {
        if (actionKey !== WIDGET_ACTIONS.ALL_ON && actionKey !== WIDGET_ACTIONS.ALL_OFF) {
          throw new Error(`Unknown action ${actionKey}`);
        }
        const channels = await switchChannels(settings);
        return toast(await applyAll(channels, actionKey === WIDGET_ACTIONS.ALL_ON ? 1 : 0));
      },
    },

    [SHUTTERS_WIDGET]: {
      async get({ settings = {} }) {
        const list = await covers(settings);
        if (list.length === 0) {
          return messageContent(TEXT.noCover);
        }
        const positions = [];
        const rows = list.map(({ device, feature, key }) => {
          const runtime = runtimeOf(device);
          const component = runtime.status?.[`cover:${key.index}`];
          if (runtime.transport?.transport === 'unreachable') {
            return { label: feature.name, value: TEXT.unreachable, color: WIDGET_COLORS.DANGER };
          }
          const state =
            TEXT[component?.state === 'open' ? 'opened' : component?.state] ?? TEXT.stopped;
          const pos =
            typeof component?.current_pos === 'number' ? component.current_pos : undefined;
          if (pos !== undefined) {
            positions.push(pos);
          }
          const moving = component?.state === 'opening' || component?.state === 'closing';
          return {
            label:
              list.length > 1 && !feature.name.includes(device.name)
                ? `${device.name} — ${feature.name}`
                : feature.name,
            value: pos !== undefined ? withValue(state, `· ${pos} %`) : state,
            color: moving
              ? WIDGET_COLORS.INFO
              : pos === 0 || component?.state === 'closed'
                ? WIDGET_COLORS.NEUTRAL
                : WIDGET_COLORS.SUCCESS,
          };
        });
        const average =
          positions.length > 0
            ? Math.round(positions.reduce((a, b) => a + b, 0) / positions.length)
            : undefined;
        const components = [];
        if (settings.title) {
          components.push({
            type: 'text',
            variant: 'heading',
            text: String(settings.title).slice(0, 40),
          });
        }
        if (average !== undefined) {
          components.push({
            type: 'gauge',
            label: TEXT.averagePosition,
            value: average,
            min: 0,
            max: 100,
            unit: '%',
          });
        }
        components.push({ type: 'status', items: rows.slice(0, MAX_STATUS_ROWS) });
        components.push(
          {
            type: 'button',
            label: TEXT.open,
            icon: 'chevrons-up',
            style: 'secondary',
            action: { key: WIDGET_ACTIONS.OPEN },
          },
          {
            type: 'button',
            label: TEXT.stop,
            icon: 'pause',
            style: 'secondary',
            action: { key: WIDGET_ACTIONS.STOP },
          },
          {
            type: 'button',
            label: TEXT.close,
            icon: 'chevrons-down',
            style: 'secondary',
            action: { key: WIDGET_ACTIONS.CLOSE },
          },
        );
        if (positions.length > 0) {
          components.push({
            type: 'button',
            label: TEXT.positionButton,
            icon: 'sliders',
            style: 'primary',
            action: {
              key: WIDGET_ACTIONS.POSITION,
              fields: [
                {
                  key: 'position',
                  type: 'number',
                  required: true,
                  min: 0,
                  max: 100,
                  default: average,
                  label: TEXT.positionField,
                },
              ],
            },
          });
        }
        return { ttl_seconds: 15, components };
      },

      async action(actionKey, _params, { settings = {}, values } = {}) {
        const list = await covers(settings);
        if (actionKey === WIDGET_ACTIONS.POSITION) {
          // An older core drops the form and relays the action without values:
          // refuse it rather than guessing a position.
          const position = Number(values?.position);
          if (!Number.isFinite(position)) {
            throw new Error('No position received');
          }
          const targets = list
            .filter(({ position: feature }) => feature)
            .map(({ device, position: feature }) => ({ device, feature }));
          return toast(await applyAll(targets, Math.min(Math.max(Math.round(position), 0), 100)));
        }
        const value = {
          [WIDGET_ACTIONS.OPEN]: 1,
          [WIDGET_ACTIONS.STOP]: 0,
          [WIDGET_ACTIONS.CLOSE]: -1,
        }[actionKey];
        if (value === undefined) {
          throw new Error(`Unknown action ${actionKey}`);
        }
        return toast(await applyAll(list, value));
      },
    },

    [NETWORK_WIDGET]: {
      async get() {
        const devices = await devicesOf(gladys, []);
        if (devices.length === 0) {
          return messageContent(TEXT.noDevice);
        }
        let live = 0;
        let fallback = 0;
        let unreachable = 0;
        const problems = [];
        devices.forEach((device) => {
          const runtime = runtimeOf(device);
          const transport = runtime.transport;
          if (runtime.webSocketLive || runtime.mqttSeeded) {
            live += 1;
          }
          if (transport?.transport === 'unreachable') {
            unreachable += 1;
            problems.push({
              label: device.name,
              value: TEXT.unreachable,
              color: WIDGET_COLORS.DANGER,
              rank: 0,
            });
            return;
          }
          if (transport?.degraded || transport?.transport === 'cloud') {
            fallback += 1;
            problems.push({
              label: device.name,
              value: TEXT.degraded,
              color: WIDGET_COLORS.WARNING,
              rank: 1,
            });
          }
          const rssi = runtime.status?.wifi?.rssi ?? runtime.status?.wifi_sta?.rssi;
          if (typeof rssi === 'number' && rssi < WEAK_RSSI_DBM) {
            problems.push({
              label: device.name,
              value: withValue(TEXT.weakWifi, `${rssi} dBm`),
              color: WIDGET_COLORS.WARNING,
              rank: 2,
            });
          }
          const update = runtime.status?.sys?.available_updates?.stable?.version;
          if (update) {
            problems.push({
              label: device.name,
              value: withValue(TEXT.update, update),
              color: WIDGET_COLORS.INFO,
              rank: 3,
            });
          }
        });
        problems.sort((a, b) => a.rank - b.rank);
        const budget = telemetry.describeBudget();
        const lane = budget.configuredRealtimeSeconds
          ? ` · ${budget.effectiveRealtimeSeconds} s`
          : '';
        return {
          ttl_seconds: 60,
          components: [
            { type: 'value', label: TEXT.devices, value: devices.length, icon: 'cpu' },
            {
              type: 'value',
              label: TEXT.realtime,
              value: live,
              icon: 'zap',
              color: WIDGET_COLORS.SUCCESS,
            },
            {
              type: 'value',
              label: TEXT.fallback,
              value: fallback,
              icon: 'cloud',
              color: fallback > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
            },
            {
              type: 'value',
              label: TEXT.unreachable,
              value: unreachable,
              icon: 'wifi-off',
              color: unreachable > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
            },
            {
              type: 'status',
              items:
                problems.length > 0
                  ? problems.slice(0, MAX_STATUS_ROWS).map(({ rank: _rank, ...row }) => row)
                  : [{ label: TEXT.everyDevice, value: TEXT.allOk, color: WIDGET_COLORS.SUCCESS }],
            },
            {
              type: 'text',
              variant: 'caption',
              text: T(
                `Gladys budget: ${budget.statesLastMinute}/${budget.limitPerMinute} states/min${lane}`,
                `Budget Gladys : ${budget.statesLastMinute}/${budget.limitPerMinute} états/min${lane}`,
                `Gladys-Budget: ${budget.statesLastMinute}/${budget.limitPerMinute} Zustände/Min${lane}`,
                `Presupuesto Gladys: ${budget.statesLastMinute}/${budget.limitPerMinute} estados/min${lane}`,
              ),
            },
          ],
        };
      },
    },
  };
}
