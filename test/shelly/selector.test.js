import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDeviceSelector, buildFeatureSelector, slugify } from '../../src/shelly/selector.js';
import { buildDevice } from '../../src/shelly/deviceMapping.js';
import { PRO_4PM_STATUS } from '../helpers/fakeShelly.js';

/** Stand-in for `gladys.externalIds('device', id)`. */
function externalIdsFor(shellyId) {
  return {
    device: `ext:shelly:device:${shellyId}`,
    feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
  };
}

describe('slugify', () => {
  it('strips accents and punctuation', () => {
    assert.equal(slugify("Éclairage Salle d'attente"), 'eclairage-salle-d-attente');
    assert.equal(slugify('WC / SDB — RdC'), 'wc-sdb-rdc');
    assert.equal(slugify('switch:0:binary'), 'switch-0-binary');
  });

  it('never leaves leading or trailing separators', () => {
    assert.equal(slugify('  --Hello--  '), 'hello');
    assert.equal(slugify(''), '');
    assert.equal(slugify(undefined), '');
  });
});

describe('buildDeviceSelector', () => {
  it('anchors the selector on the Shelly id', () => {
    assert.equal(
      buildDeviceSelector('Tableau Maison', 'shellypro3em-2cbcbba663cc'),
      'tableau-maison-shellypro3em-2cbcbba663cc',
    );
  });

  it('keeps two devices sharing a display name apart', () => {
    // The whole point: without the id suffix these would collide, and the
    // second device would be rejected with a 409.
    assert.notEqual(
      buildDeviceSelector('Chauffage', 'shellyplus2pm-aaaaaaaaaaaa'),
      buildDeviceSelector('Chauffage', 'shellyplus2pm-bbbbbbbbbbbb'),
    );
  });

  it('does not repeat the id when the device has no user-set name', () => {
    // An unnamed device falls back to its Shelly id as a display name.
    assert.equal(
      buildDeviceSelector('shellypro4pm-ece334ea4d10', 'shellypro4pm-ece334ea4d10'),
      'shellypro4pm-ece334ea4d10',
    );
  });

  it('falls back to the id, then to a constant, rather than producing nothing', () => {
    assert.equal(buildDeviceSelector('', 'shellyplug-abc'), 'shellyplug-abc');
    assert.equal(buildDeviceSelector('', ''), 'shelly-device');
  });
});

describe('buildFeatureSelector', () => {
  it('scopes the feature to its device', () => {
    assert.equal(
      buildFeatureSelector('tableau-maison-shellypro3em-abc', 'em:0:total_active_power'),
      'tableau-maison-shellypro3em-abc-em-0-total-active-power',
    );
  });

  it('is reproducible: the same inputs always give the same selector', () => {
    // Reconstructibility is what lets a re-discovery UPDATE the device instead
    // of creating a duplicate — hence derived values, never random ids.
    const once = buildFeatureSelector('dev-abc', 'switch:0:binary');
    const twice = buildFeatureSelector('dev-abc', 'switch:0:binary');
    assert.equal(once, twice);
  });
});

describe('the 409 that this prevents', () => {
  it('gives two devices with unnamed relays distinct feature selectors', () => {
    // Reproduces the real failure: adding a Plus 2PM after a Pro 4PM was
    // rejected with `selector must be unique` on `on-off-switch-0`, because
    // the core derives the selector from the display name and both devices
    // exposed an unnamed relay.
    const plus2pm = buildDevice({
      info: { id: 'shellyplus2pm-aabbccddeeff' },
      status: { 'switch:0': { id: 0, output: false }, 'switch:1': { id: 1, output: false } },
      externalIds: externalIdsFor('shellyplus2pm-aabbccddeeff'),
    });
    const pro4pm = buildDevice({
      info: { id: 'shellypro4pm-ece334ea4d10' },
      status: PRO_4PM_STATUS,
      externalIds: externalIdsFor('shellypro4pm-ece334ea4d10'),
    });

    const selectors = [...plus2pm.features, ...pro4pm.features].map((f) => f.selector);
    assert.equal(
      selectors.every((selector) => typeof selector === 'string' && selector.length > 0),
      true,
      'every feature must carry an explicit selector',
    );
    assert.equal(new Set(selectors).size, selectors.length, 'feature selectors must be unique');
    assert.notEqual(plus2pm.selector, pro4pm.selector);
  });

  it('produces the same selectors on a re-discovery', () => {
    const build = () =>
      buildDevice({
        info: { id: 'shellypro4pm-ece334ea4d10' },
        config: { sys: { device: { name: 'Éclairages RDC' } } },
        status: PRO_4PM_STATUS,
        externalIds: externalIdsFor('shellypro4pm-ece334ea4d10'),
      });

    const first = build();
    const second = build();
    assert.equal(first.selector, second.selector);
    assert.deepEqual(
      first.features.map((f) => f.selector),
      second.features.map((f) => f.selector),
    );
    // And the name really is part of it, which is what makes it readable.
    assert.match(first.selector, /^eclairages-rdc-shellypro4pm-ece334ea4d10$/);
  });
});
