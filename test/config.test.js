import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isCloudConfigured, normalizeConfig } from '../src/config.js';

describe('normalizeConfig', () => {
  it('applies the defaults on an empty configuration', () => {
    const config = normalizeConfig();
    assert.deepEqual(config.manualHosts, []);
    assert.equal(config.deviceUsername, 'admin');
    assert.equal(config.devicePassword, '');
    assert.equal(config.cloudEnabled, false);
    assert.equal(config.refreshSeconds, 30);
    // The core only writes GLADYS_PREFER_LOCAL when the user changed it, and
    // its documented default is true.
    assert.equal(config.preferLocal, true);
  });

  it('parses a manual host list however the user pasted it', () => {
    const config = normalizeConfig({
      manual_hosts: ' 10.5.0.171, http://10.5.0.172/ ;10.5.0.171\n shelly.local ,',
    });
    assert.deepEqual(config.manualHosts, ['10.5.0.171', '10.5.0.172', 'shelly.local']);
  });

  it('keeps a password verbatim but trims a pasted cloud key', () => {
    const config = normalizeConfig({
      device_password: ' secret ',
      cloud_auth_key: '  key-123  ',
      cloud_server: 'https://shelly-53-eu.shelly.cloud/',
    });
    assert.equal(config.devicePassword, ' secret ');
    assert.equal(config.cloudAuthKey, 'key-123');
    assert.equal(config.cloudServer, 'shelly-53-eu.shelly.cloud');
  });

  it('reads the refresh interval as a number and clamps it', () => {
    assert.equal(normalizeConfig({ refresh_interval: '60' }).refreshSeconds, 60);
    assert.equal(normalizeConfig({ refresh_interval: '1' }).refreshSeconds, 5);
    assert.equal(normalizeConfig({ refresh_interval: '99999' }).refreshSeconds, 3600);
    assert.equal(normalizeConfig({ refresh_interval: 'nope' }).refreshSeconds, 30);
  });

  it('reads booleans coming from a select as strings', () => {
    assert.equal(normalizeConfig({ cloud_enabled: 'true' }).cloudEnabled, true);
    assert.equal(normalizeConfig({ cloud_enabled: 'false' }).cloudEnabled, false);
    assert.equal(normalizeConfig({ cloud_enabled: true }).cloudEnabled, true);
  });

  it('honours GLADYS_PREFER_LOCAL only when it is explicitly false', () => {
    assert.equal(normalizeConfig({ GLADYS_PREFER_LOCAL: false }).preferLocal, false);
    assert.equal(normalizeConfig({ GLADYS_PREFER_LOCAL: true }).preferLocal, true);
  });
});

describe('isCloudConfigured', () => {
  it('requires the toggle AND both credentials', () => {
    assert.equal(isCloudConfigured(normalizeConfig({ cloud_enabled: true })), false);
    assert.equal(
      isCloudConfigured(
        normalizeConfig({ cloud_enabled: true, cloud_server: 'shelly-53-eu.shelly.cloud' }),
      ),
      false,
    );
    assert.equal(
      isCloudConfigured(
        normalizeConfig({
          cloud_enabled: true,
          cloud_server: 'shelly-53-eu.shelly.cloud',
          cloud_auth_key: 'key',
        }),
      ),
      true,
    );
  });

  it('stays false when the credentials are there but the toggle is off', () => {
    assert.equal(
      isCloudConfigured(
        normalizeConfig({ cloud_server: 'shelly-53-eu.shelly.cloud', cloud_auth_key: 'key' }),
      ),
      false,
    );
  });
});
