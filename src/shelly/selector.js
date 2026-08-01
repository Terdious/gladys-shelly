// -----------------------------------------------------------------------------
// Selector helpers for discovered devices and features.
//
// Gladys stores a `selector` on every device AND every feature, and it must be
// unique across the WHOLE installation — not per device. When the discovery
// payload omits it, the core derives it from the display name, so two devices
// each exposing an unnamed relay both produce `on-off-switch-0` and the second
// one is rejected with a 409 `selector must be unique`.
//
// So the selectors are always explicit, and always DERIVED — never random:
//   - the device selector embeds the Shelly id, which carries the MAC and is
//     therefore globally unique;
//   - the feature selector is scoped to the device selector plus the component
//     key (`switch:0:binary`), which is unique within a device.
//
// Being derived rather than random is what makes them RECONSTRUCTIBLE: the same
// device re-discovered after an update, a container restart or a re-scan
// produces the same selectors, so Gladys updates the existing device instead of
// creating a duplicate.
//
// Same pattern as the Tuya integration (src/tuya/utils/tuya.selector.js).
// -----------------------------------------------------------------------------

/**
 * Slugify a string into a Gladys-safe selector segment (`[a-z0-9-]`).
 * @param {string} value raw string
 * @returns {string} the slug
 */
export function slugify(value) {
  return (
    String(value === undefined || value === null ? '' : value)
      .normalize('NFD')
      // Strip the combining diacritical marks left by the NFD decomposition.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

/**
 * Build the device selector: `<slug(name)>-<slug(shelly id)>`.
 *
 * The Shelly id suffix is what guarantees global uniqueness — two Shelly
 * devices the user called "Chauffage" still get distinct selectors.
 *
 * @param {string} name device display name
 * @param {string} shellyId the Shelly device id (e.g. `shellypro4pm-ece334ea4d10`)
 * @returns {string} the device selector
 */
export function buildDeviceSelector(name, shellyId) {
  const idSlug = slugify(shellyId);
  const nameSlug = slugify(name);
  if (!nameSlug) {
    return idSlug || 'shelly-device';
  }
  if (!idSlug) {
    return nameSlug;
  }
  // An unnamed device falls back to its Shelly id as a display name, so
  // appending the id again would give `shellypro4pm-abc-shellypro4pm-abc`.
  return nameSlug.includes(idSlug) ? nameSlug : `${nameSlug}-${idSlug}`;
}

/**
 * Build a feature selector scoped to its device.
 *
 * The feature key is the Shelly component coordinate (`switch:0:binary`,
 * `em:0:total_active_power`), unique within a device — so prefixing it with the
 * device selector makes it unique across the installation.
 *
 * @param {string} deviceSelector the owning device selector
 * @param {string} featureKey the feature key
 * @returns {string} the feature selector
 */
export function buildFeatureSelector(deviceSelector, featureKey) {
  const keySlug = slugify(featureKey);
  return keySlug ? `${deviceSelector}-${keySlug}` : deviceSelector;
}
