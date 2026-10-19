// -----------------------------------------------------------------------------
// Consistency checks on `gladys-assistant-integration.json`.
//
// The store indexer validates the manifest shape, but it cannot know what the
// code expects (config defaults, action / scene / widget handlers), and some
// of its rules are easy to miss before a release (version coupling,
// description length, languages): these tests catch them in CI.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createActions } from '../src/actions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createSceneActions } from '../src/scenes.js';
import { CONNECTION_MESSAGES, TRANSPORT_MESSAGES } from '../src/shelly/constants.js';
import { FEATURE_NAME_LANGUAGES } from '../src/shelly/featureNames.js';
import { INPUT_EVENT_TRIGGER, REACHABILITY_TRIGGER } from '../src/shelly/telemetry.js';
import { CHART_INTERVALS, createWidgets } from '../src/widgets.js';
import { DEVICE_REQUIRED_MESSAGE, REPORT_INTROS } from '../src/actions.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Store catalog vocabulary (Gladys INTEGRATION_CATALOG_CATEGORIES).
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];
// Scene triggers, scene actions and widgets need Gladys 5.1.0.
const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
// The languages of the Gladys interface: every text the user reads ships in
// all of them (Gladys falls back to English for a missing one).
const GLADYS_LANGUAGES = ['en', 'fr', 'de', 'es'];

/** Every multi-language text object ({ en, fr, ... }) of a subtree. */
function multiLanguageTexts(node, path = 'manifest') {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => multiLanguageTexts(child, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  if (typeof node.en === 'string') {
    return [{ path, text: node }];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    multiLanguageTexts(child, `${path}.${key}`),
  );
}

function assertEveryLanguage(text, path) {
  assert.deepEqual(Object.keys(text).sort(), [...GLADYS_LANGUAGES].sort(), `${path} languages`);
  for (const language of GLADYS_LANGUAGES) {
    assert.ok(text[language].trim().length > 0, `${path}.${language} is empty`);
  }
}

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

/** Handlers built with inert dependencies: only their keys are compared. */
const deps = { gladys: {}, client: {}, telemetry: {}, getConfig: () => ({}) };
const keysOf = (list) => (list || []).map((entry) => entry.key).sort();

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('catalog categories: 1 to 3 known keys, and Gladys >= 4.86.0', () => {
  assert.ok(Array.isArray(manifest.categories), 'categories must be declared');
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category "${category}"`);
  }
  assert.ok(isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION));
});

test('scene triggers, scene actions and widgets require Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  if (declared.length > 0) {
    assert.ok(
      isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
      `${declared.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
    );
  }
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('config_schema keys are snake_case and defaults match DEFAULT_CONFIG', () => {
  const withDefault = manifest.config_schema.filter((field) => field.default !== undefined);
  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/, `config key "${field.key}"`);
  }
  for (const field of withDefault) {
    assert.equal(DEFAULT_CONFIG[field.key], field.default, `DEFAULT_CONFIG.${field.key}`);
  }
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG).sort(),
    withDefault.map((field) => field.key).sort(),
    'every DEFAULT_CONFIG key is a manifest default',
  );
});

test('the feature_names options are the languages the dictionary carries', () => {
  const field = manifest.config_schema.find((candidate) => candidate.key === 'feature_names');
  assert.deepEqual(
    field.options.map((option) => option.value).sort(),
    [...FEATURE_NAME_LANGUAGES].sort(),
  );
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('every declared action, scene action and widget has its handler, and back', () => {
  assert.deepEqual(keysOf(manifest.actions), Object.keys(createActions(deps)).sort());
  assert.deepEqual(keysOf(manifest.scene_actions), Object.keys(createSceneActions(deps)).sort());
  assert.deepEqual(keysOf(manifest.widgets), Object.keys(createWidgets(deps)).sort());
});

test('the scene triggers are the ones the telemetry fires', () => {
  assert.deepEqual(
    keysOf(manifest.scene_triggers),
    [REACHABILITY_TRIGGER, INPUT_EVENT_TRIGGER].sort(),
  );
  // `data` keys of the events: the declared fields and variables.
  const input = manifest.scene_triggers.find((t) => t.key === INPUT_EVENT_TRIGGER);
  assert.deepEqual(
    [...input.fields, ...input.variables].map((f) => f.key).sort(),
    ['device', 'device_name', 'event', 'event', 'input', 'input'].sort(),
  );
});

test('the widget settings match what the widgets read', () => {
  const meter = manifest.widgets.find((widget) => widget.key === 'energy_meter');
  const interval = meter.settings.find((setting) => setting.key === 'interval');
  assert.deepEqual(
    interval.options.map((option) => option.value),
    CHART_INTERVALS,
  );
  assert.ok(manifest.widgets.length <= 5, 'at most 5 widgets');
});

test('every manifest text ships in every Gladys language', () => {
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 100);
  for (const { path, text } of texts) {
    assertEveryLanguage(text, path);
  }
});

test('every runtime message ships in every Gladys language', () => {
  for (const [key, message] of Object.entries(CONNECTION_MESSAGES)) {
    assertEveryLanguage(message, `CONNECTION_MESSAGES.${key}`);
  }
  for (const [key, message] of Object.entries(TRANSPORT_MESSAGES)) {
    assertEveryLanguage(message, `TRANSPORT_MESSAGES.${key}`);
  }
  for (const [key, message] of Object.entries(REPORT_INTROS)) {
    assertEveryLanguage(message, `REPORT_INTROS.${key}`);
  }
  assertEveryLanguage(DEVICE_REQUIRED_MESSAGE, 'DEVICE_REQUIRED_MESSAGE');
});

test('the user documentation ships in every Gladys language, with the same sections', async () => {
  const headings = async (language) => {
    const text = await readFile(new URL(`../docs/${language}.md`, import.meta.url), 'utf8');
    // The store skips a file under 300 characters.
    assert.ok(text.length >= 300, `docs/${language}.md is too short`);
    return text
      .split('\n')
      .filter((line) => /^#{1,3} /.test(line))
      .map((line) => line.match(/^#+/)[0]);
  };
  const reference = await headings('en');
  for (const language of GLADYS_LANGUAGES) {
    assert.deepEqual(await headings(language), reference, `docs/${language}.md outline`);
  }
});
