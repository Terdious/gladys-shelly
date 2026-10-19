import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createActions, findDevice, referenceOf, testDevice } from '../src/actions.js';
import { normalizeConfig } from '../src/config.js';
import {
  buildDeviceTestReport,
  buildFleetDiagnostic,
  formatAge,
  MASKED_HOST,
  MAX_REPORT_LENGTH,
  maskIdentifier,
  truncateReport,
} from '../src/diagnostic.js';
import { PRO_3EM_STATUS, startFakeShelly } from './helpers/fakeShelly.js';

const SECRET = 'hunter2-very-secret';

/** A created device as getDevices() returns it. */
function createdDevice(shellyId, host, name = 'Main meter') {
  return {
    name,
    external_id: `ext:shelly:device:${shellyId}`,
    features: [{ external_id: `ext:shelly:device:${shellyId}:em:0:total_active_power` }],
    params: [
      { name: 'SHELLY_ID', value: shellyId },
      { name: 'IP_ADDRESS', value: host },
      { name: 'SHELLY_MODEL', value: 'SPEM-003CEBEU' },
      { name: 'SHELLY_GEN', value: '2' },
    ],
  };
}

function deps({ devices, config, describeDevice }) {
  return {
    gladys: {
      async getDevices() {
        return devices;
      },
    },
    client: { localHealth: () => ({ failures: 3, until: Date.now() + 60000 }) },
    telemetry: {
      describeDevice:
        describeDevice ??
        (() => ({
          status: { ...PRO_3EM_STATUS, wifi: { rssi: -81 }, sys: { uptime: 90061 } },
          lastSeenAt: Date.now() - 3000,
          transport: { transport: 'cloud', degraded: true, message: { en: 'cloud fallback' } },
          webSocketLive: false,
        })),
      describeBudget: () => ({
        configuredRealtimeSeconds: 5,
        effectiveRealtimeSeconds: 8,
        statesLastMinute: 251,
        limitPerMinute: 300,
        webSocketConnections: 3,
        webSocketLive: 2,
        mqttConnected: true,
        mqttDevices: 4,
        mqttSeeded: 4,
      }),
    },
    getConfig: () => config,
  };
}

describe('helpers', () => {
  it('masks the MAC part of a Shelly id and keeps the model', () => {
    assert.equal(maskIdentifier('shellypro3em-2cbcbba663cc'), 'shellypro3em-2c…cc');
    assert.equal(maskIdentifier('2CBCBBA663CC'), '2C…CC');
    assert.equal(maskIdentifier(''), '-');
  });

  it('formats ages and bounds the report', () => {
    assert.equal(formatAge(undefined, 0), 'never');
    assert.equal(formatAge(1000, 4000), '3 s ago');
    assert.equal(formatAge(0 + 1, 1 + 10 * 60000), '10 min ago');
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const cut = truncateReport(long);
    assert.ok(cut.length <= MAX_REPORT_LENGTH);
    assert.match(cut, /report truncated/);
  });

  it('prefers the picked device over the typed reference, and finds it by any handle', () => {
    assert.equal(referenceOf({ device: 'ext:a', device_ref: '10.0.0.1' }), 'ext:a');
    assert.equal(referenceOf({ device_ref: ' 10.0.0.1 ' }), '10.0.0.1');
    const devices = [createdDevice('shellyplug-1', '10.5.0.9', 'Kettle')];
    assert.equal(findDevice(devices, 'kettle'), devices[0]);
    assert.equal(findDevice(devices, 'SHELLYPLUG-1'), devices[0]);
    assert.equal(findDevice(devices, '10.5.0.9'), devices[0]);
    assert.equal(findDevice(devices, 'nothing'), undefined);
  });
});

describe('fleet diagnostic', () => {
  const config = normalizeConfig({
    device_password: SECRET,
    mqtt_enabled: true,
    mqtt_server: '10.5.0.50:1883',
    mqtt_password: 'mqtt-secret-pass',
    manual_hosts: '10.5.0.171',
  });
  const devices = [createdDevice('shellypro3em-2cbcbba663cc', '10.5.0.174')];

  it('reports the configuration, budget and each device, masked and without any secret', async () => {
    const actions = createActions(deps({ devices, config }));
    const result = await actions.fleet_diagnostic({});
    for (const language of ['en', 'fr', 'de', 'es']) {
      assert.ok(result[language].includes('Shelly integration — diagnostic'));
    }
    const report = result.en;
    assert.ok(!report.includes(SECRET));
    assert.ok(!report.includes('mqtt-secret-pass'));
    assert.ok(!report.includes('10.5.0.174'));
    assert.ok(!report.includes('2cbcbba663cc'));
    assert.ok(report.includes(MASKED_HOST));
    assert.match(report, /device password: set/);
    assert.match(report, /251\/300 — slowed to 8 s/);
    assert.match(report, /DEGRADED: cloud fallback/);
    assert.match(report, /-81 dBm — WEAK/);
    assert.match(report, /Uptime: 1 d 1 h/);
    assert.match(report, /3 failure\(s\) in a row, parked until/);
  });

  it('shows the identifiers when asked, never the secrets', async () => {
    const actions = createActions(deps({ devices, config }));
    const report = (await actions.fleet_diagnostic({ include_identifiers: true })).en;
    assert.ok(report.includes('shellypro3em-2cbcbba663cc'));
    assert.ok(report.includes('10.5.0.174'));
    assert.ok(!report.includes(SECRET));
    assert.match(report, /do not post it publicly/);
  });

  it('filters on one device, and says so when nothing matches', () => {
    const snapshot = {
      config,
      budget: deps({ devices, config }).telemetry.describeBudget(),
      devices: [],
      filter: 'nothing',
      secrets: [],
    };
    assert.match(
      buildFleetDiagnostic(snapshot, { includeIdentifiers: false }),
      /No created device matches/,
    );
  });
});

describe('device test', () => {
  const fakes = [];
  after(() => Promise.all(fakes.map((fake) => fake.close())));

  it('reads a live device and reports its answer times and components', async () => {
    const fake = await startFakeShelly({
      info: {
        id: 'shellypro3em-2cbcbba663cc',
        mac: '2CBCBBA663CC',
        model: 'SPEM-003CEBEU',
        gen: 2,
        ver: '1.4.4',
      },
      status: { ...PRO_3EM_STATUS, wifi: { rssi: -60 } },
    });
    fakes.push(fake);
    const config = normalizeConfig();
    const devices = [createdDevice('shellypro3em-2cbcbba663cc', fake.host)];
    const actions = createActions(deps({ devices, config }));
    const report = (await actions.test_device({ device: devices[0].external_id })).en;
    assert.match(report, /\[1\] GET \/shelly/);
    assert.match(report, /firmware 1\.4\.4/);
    assert.match(report, /Components: em x1, emdata x1/);
    assert.match(report, /Wi-Fi signal: -60 dBm/);
    assert.match(report, /WebSocket NOT live/);
    assert.match(report, /Result: OK/);
    // Read-only: only the identity and a status read reached the device.
    assert.deepEqual(
      fake.calls.map((call) => call.method),
      ['Shelly.GetStatus'],
    );
  });

  it('names a refused password', async () => {
    const fake = await startFakeShelly({ password: 'right-password' });
    fakes.push(fake);
    const config = normalizeConfig({ device_password: 'wrong-password' });
    const outcome = await testDevice(
      { ...deps({ devices: [], config }), fetchImpl: fetch },
      fake.host,
    );
    assert.equal(outcome.failure, 'auth');
    const report = buildDeviceTestReport(outcome, { includeIdentifiers: false });
    assert.match(report, /refused the password/);
    assert.ok(!report.includes('wrong-password'));
  });

  it('explains an address that does not answer, and a missing address', async () => {
    const config = normalizeConfig();
    const silent = await testDevice(deps({ devices: [], config }), '127.0.0.1:1');
    assert.equal(silent.failure, 'no-answer');
    assert.match(buildDeviceTestReport(silent, { includeIdentifiers: true }), /Nothing answered/);

    const unknown = await testDevice(deps({ devices: [], config }), 'Some name');
    assert.equal(unknown.failure, 'no-address');

    const actions = createActions(deps({ devices: [], config }));
    await assert.rejects(() => actions.test_device({}), /Pick a device/);
  });
});
