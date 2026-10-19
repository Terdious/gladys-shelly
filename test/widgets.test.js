import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { buildDevice } from '../src/shelly/deviceMapping.js';
import {
  createWidgets,
  ENERGY_METER_WIDGET,
  formatPower,
  NETWORK_WIDGET,
  selectedIds,
  SHUTTERS_WIDGET,
  SWITCHES_WIDGET,
  WIDGET_ACTIONS,
} from '../src/widgets.js';
import { PRO_3EM_STATUS, PRO_4PM_STATUS } from './helpers/fakeShelly.js';

const externalIdsFor = (shellyId) => ({
  device: `ext:shelly:device:${shellyId}`,
  feature: (key) => `ext:shelly:device:${shellyId}:${key}`,
});

/** A created Gladys device, as getDevices() returns it. */
function created(shellyId, status, name) {
  const device = buildDevice({
    info: { id: shellyId, model: 'X', gen: 2, name },
    status,
    host: '10.5.0.10',
    externalIds: externalIdsFor(shellyId),
  });
  return { ...device, name: name ?? device.name };
}

const COVER_STATUS = {
  'cover:0': { id: 0, state: 'stopped', current_pos: 40, pos_control: true, apower: 0 },
};

/** Widgets wired to stubs; `statuses` is what telemetry last saw. */
function harness({ devices, statuses = {}, transports = {} }) {
  const commands = [];
  const states = [];
  const gladys = {
    async getDevices() {
      return devices;
    },
    async publishState(id, value) {
      states.push([id, value]);
    },
  };
  const client = {
    async sendCommand(target, command) {
      commands.push([target.shellyId, command.rpc]);
      return 'local';
    },
  };
  const telemetry = {
    describeDevice: (shellyId) => ({
      status: statuses[shellyId],
      lastSeenAt: 1000,
      transport: transports[shellyId] ?? { transport: 'local' },
      webSocketLive: true,
    }),
    describeBudget: () => ({
      configuredRealtimeSeconds: 5,
      effectiveRealtimeSeconds: 5,
      statesLastMinute: 120,
      limitPerMinute: 300,
    }),
  };
  const widgets = createWidgets({ gladys, client, telemetry }, { now: () => 6000 });
  return { widgets, commands, states };
}

/** Content checks: the SDK validation passes, nothing dropped by the budget. */
function assertValid(content) {
  assert.deepEqual(validateWidgetContent(content), []);
}

describe('energy_meter widget', () => {
  const meter = created('shellypro3em-2cbcbba663cc', PRO_3EM_STATUS, 'Main meter');

  it('binds the gauge, phase and energy tiles and the chart to the meter features', async () => {
    const { widgets } = harness({
      devices: [meter],
      statuses: { 'shellypro3em-2cbcbba663cc': PRO_3EM_STATUS },
    });
    const content = await widgets[ENERGY_METER_WIDGET].get({
      settings: { device: meter.external_id, interval: 'last-hour', max_power: 9000 },
    });
    assertValid(content);
    const gauge = content.components.find((c) => c.type === 'gauge');
    assert.equal(gauge.device_feature, `${meter.external_id}:em:0:total_active_power`);
    assert.deepEqual([gauge.min, gauge.max], [-9000, 9000]);
    const tiles = content.components.filter((c) => c.type === 'value').map((c) => c.device_feature);
    assert.ok(tiles.includes(`${meter.external_id}:em:0:l2_active_power`));
    assert.ok(tiles.includes(`${meter.external_id}:emdata:0:total_energy`));
    const chart = content.components.find((c) => c.type === 'chart');
    assert.equal(chart.interval, 'last-hour');
    const status = content.components.find((c) => c.type === 'status');
    assert.ok(status.items.length >= 3);
  });

  it('works on a multi-channel relay with metering, and asks for a device otherwise', async () => {
    const pro4pm = created('shellypro4pm-ece334ea4d10', PRO_4PM_STATUS);
    const { widgets } = harness({ devices: [pro4pm] });
    const content = await widgets[ENERGY_METER_WIDGET].get({
      settings: { device: pro4pm.external_id },
    });
    assertValid(content);
    assert.equal(
      content.components.find((c) => c.type === 'gauge').device_feature,
      `${pro4pm.external_id}:switch:0:power`,
    );
    const empty = await widgets[ENERGY_METER_WIDGET].get({ settings: {} });
    assertValid(empty);
    assert.equal(empty.components[0].type, 'text');
  });
});

describe('switches widget', () => {
  const pro4pm = created('shellypro4pm-ece334ea4d10', PRO_4PM_STATUS, 'Board');

  it('lists every channel with its state and power, and the total', async () => {
    const { widgets } = harness({
      devices: [pro4pm],
      statuses: { 'shellypro4pm-ece334ea4d10': PRO_4PM_STATUS },
    });
    const content = await widgets[SWITCHES_WIDGET].get({ settings: { title: 'Board' } });
    assertValid(content);
    const status = content.components.find((c) => c.type === 'status');
    assert.equal(status.items.length, 4);
    assert.equal(content.components.filter((c) => c.type === 'button').length, 2);
  });

  it('switches every selected channel off, one command each', async () => {
    const { widgets, commands, states } = harness({ devices: [pro4pm] });
    const toast = await widgets[SWITCHES_WIDGET].action(
      WIDGET_ACTIONS.ALL_OFF,
      {},
      {
        settings: { devices: [pro4pm.external_id] },
      },
    );
    assert.equal(commands.length, 4);
    assert.ok(commands.every(([, rpc]) => rpc.method === 'Switch.Set' && rpc.params.on === false));
    assert.equal(states.length, 4);
    assert.match(toast.en, /4 channel/);
  });
});

describe('shutters widget', () => {
  const cover = created('shellyplus2pm-a8032ab12345', COVER_STATUS, 'Living room');

  it('shows the position and offers a pre-filled position form', async () => {
    const { widgets } = harness({
      devices: [cover],
      statuses: { 'shellyplus2pm-a8032ab12345': COVER_STATUS },
    });
    const content = await widgets[SHUTTERS_WIDGET].get({ settings: {} });
    assertValid(content);
    const position = content.components.find(
      (c) => c.type === 'button' && c.action.key === WIDGET_ACTIONS.POSITION,
    );
    assert.equal(position.action.fields[0].default, 40);
  });

  it('closes the group and moves it to a position', async () => {
    const { widgets, commands } = harness({ devices: [cover] });
    await widgets[SHUTTERS_WIDGET].action(WIDGET_ACTIONS.CLOSE, {}, { settings: {} });
    await widgets[SHUTTERS_WIDGET].action(
      WIDGET_ACTIONS.POSITION,
      {},
      {
        settings: {},
        values: { position: 75 },
      },
    );
    assert.deepEqual(
      commands.map(([, rpc]) => rpc),
      [
        { method: 'Cover.Close', params: { id: 0 } },
        { method: 'Cover.GoToPosition', params: { id: 0, pos: 75 } },
      ],
    );
    // An older core relays the form without values: refused, nothing guessed.
    await assert.rejects(() =>
      widgets[SHUTTERS_WIDGET].action(WIDGET_ACTIONS.POSITION, {}, { settings: {} }),
    );
  });
});

describe('network widget', () => {
  it('counts the transports and lists the problems first', async () => {
    const plug = created('shellyplusplugs-a', { 'switch:0': { output: true } }, 'Plug');
    const meter = created('shellypro3em-b', PRO_3EM_STATUS, 'Meter');
    const { widgets } = harness({
      devices: [plug, meter],
      statuses: {
        'shellypro3em-b': { ...PRO_3EM_STATUS, wifi: { rssi: -82 } },
      },
      transports: { 'shellyplusplugs-a': { transport: 'unreachable' } },
    });
    const content = await widgets[NETWORK_WIDGET].get({});
    assertValid(content);
    const status = content.components.find((c) => c.type === 'status');
    assert.equal(status.items[0].label, 'Plug');
    assert.equal(status.items[0].color, 'danger');
    assert.match(status.items[1].value.en, /-82 dBm/);
  });
});

describe('helpers', () => {
  it('formats powers and reads the multi-select settings', () => {
    assert.equal(formatPower(1234.4), '1234 W');
    assert.equal(formatPower(12345), '12.3 kW');
    assert.equal(formatPower(undefined), '-');
    assert.deepEqual(selectedIds(['a', 'b']), ['a', 'b']);
    assert.deepEqual(selectedIds('a, b'), ['a', 'b']);
    assert.deepEqual(selectedIds(undefined), []);
  });
});
