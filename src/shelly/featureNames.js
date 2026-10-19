// -----------------------------------------------------------------------------
// Feature names in the four languages of the Gladys interface.
//
// Only the NAME is translated: the external id, the selector and the category
// of a feature never depend on the language, so switching the option never
// re-creates a feature. The words are the ones the Gladys interface itself
// uses for the same quantities, so a feature reads the same as its neighbours
// from other integrations.
//
// The option applies at discovery: a device already created keeps the names it
// was created with (the user may have renamed them, and Gladys does not take
// names back from an Update anyway).
// -----------------------------------------------------------------------------

/** Languages of the Gladys interface; anything else falls back to English. */
export const FEATURE_NAME_LANGUAGES = ['en', 'fr', 'de', 'es'];

export const FEATURE_NAMES = {
  en: {
    on_off: 'On/Off',
    power: 'Power',
    voltage: 'Voltage',
    current: 'Current',
    total_energy: 'Total energy',
    internal_temperature: 'Internal temperature',
    active_power: 'Active power',
    apparent_power: 'Apparent power',
    total_active_power: 'Total active power',
    total_apparent_power: 'Total apparent power',
    total_current: 'Total current',
    neutral_current: 'Neutral current',
    total_returned_energy: 'Total returned energy',
    temperature: 'Temperature',
    humidity: 'Humidity',
    battery: 'Battery',
    shutter: 'Shutter',
    position: 'Position',
    brightness: 'Brightness',
    color: 'Color',
    color_temperature: 'Color temperature',
    input: 'Input',
    button: 'Button',
    counter: 'Counter',
    leak: 'Water leak',
    smoke: 'Smoke',
    opening: 'Opening',
    illuminance: 'Illuminance',
  },
  fr: {
    on_off: 'Marche/Arrêt',
    power: 'Puissance',
    voltage: 'Tension',
    current: 'Intensité',
    total_energy: 'Énergie totale',
    internal_temperature: 'Température interne',
    active_power: 'Puissance active',
    apparent_power: 'Puissance apparente',
    total_active_power: 'Puissance active totale',
    total_apparent_power: 'Puissance apparente totale',
    total_current: 'Intensité totale',
    neutral_current: 'Intensité du neutre',
    total_returned_energy: 'Énergie réinjectée totale',
    temperature: 'Température',
    humidity: 'Humidité',
    battery: 'Batterie',
    shutter: 'Volet',
    position: 'Position',
    brightness: 'Luminosité',
    color: 'Couleur',
    color_temperature: 'Température de couleur',
    input: 'Entrée',
    button: 'Bouton',
    counter: 'Compteur',
    leak: "Fuite d'eau",
    smoke: 'Fumée',
    opening: 'Ouverture',
    illuminance: 'Luminosité ambiante',
  },
  de: {
    on_off: 'Ein/Aus',
    power: 'Leistung',
    voltage: 'Spannung',
    current: 'Stromstärke',
    total_energy: 'Gesamtenergie',
    internal_temperature: 'Interne Temperatur',
    active_power: 'Wirkleistung',
    apparent_power: 'Scheinleistung',
    total_active_power: 'Gesamte Wirkleistung',
    total_apparent_power: 'Gesamte Scheinleistung',
    total_current: 'Gesamtstrom',
    neutral_current: 'Neutralleiterstrom',
    total_returned_energy: 'Gesamte eingespeiste Energie',
    temperature: 'Temperatur',
    humidity: 'Luftfeuchtigkeit',
    battery: 'Batterie',
    shutter: 'Rollladen',
    position: 'Position',
    brightness: 'Helligkeit',
    color: 'Farbe',
    color_temperature: 'Farbtemperatur',
    input: 'Eingang',
    button: 'Taster',
    counter: 'Zähler',
    leak: 'Wasserleck',
    smoke: 'Rauch',
    opening: 'Öffnung',
    illuminance: 'Beleuchtungsstärke',
  },
  es: {
    on_off: 'Encendido/Apagado',
    power: 'Potencia',
    voltage: 'Tensión',
    current: 'Corriente',
    total_energy: 'Energía total',
    internal_temperature: 'Temperatura interna',
    active_power: 'Potencia activa',
    apparent_power: 'Potencia aparente',
    total_active_power: 'Potencia activa total',
    total_apparent_power: 'Potencia aparente total',
    total_current: 'Corriente total',
    neutral_current: 'Corriente del neutro',
    total_returned_energy: 'Energía devuelta total',
    temperature: 'Temperatura',
    humidity: 'Humedad',
    battery: 'Batería',
    shutter: 'Persiana',
    position: 'Posición',
    brightness: 'Brillo',
    color: 'Color',
    color_temperature: 'Temperatura de color',
    input: 'Entrada',
    button: 'Botón',
    counter: 'Contador',
    leak: 'Fuga de agua',
    smoke: 'Humo',
    opening: 'Apertura',
    illuminance: 'Iluminancia',
  },
};

/**
 * Normalize a language option, English for anything unknown.
 * @param {unknown} language raw option value
 * @returns {string} one of FEATURE_NAME_LANGUAGES
 */
export function normalizeLanguage(language) {
  const value = String(language || '').toLowerCase();
  return FEATURE_NAME_LANGUAGES.includes(value) ? value : 'en';
}

/**
 * Name of a feature spec in a language.
 *
 * The phase of a three-phase meter stays a prefix in every language
 * (`L1 puissance active`): it is the word users sort and scan by, and the
 * Shelly app writes it the same way. German keeps the capital of its nouns.
 *
 * @param {{nameKey: string, phase?: string}} spec the feature spec
 * @param {string} [language] one of FEATURE_NAME_LANGUAGES
 * @returns {string} the feature name
 */
export function featureName(spec, language = 'en') {
  const lang = normalizeLanguage(language);
  const word = FEATURE_NAMES[lang][spec.nameKey] || FEATURE_NAMES.en[spec.nameKey] || spec.nameKey;
  if (!spec.phase) {
    return word;
  }
  const tail = lang === 'de' ? word : `${word.charAt(0).toLowerCase()}${word.slice(1)}`;
  return `${spec.phase} ${tail}`;
}
