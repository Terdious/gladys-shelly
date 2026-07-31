// -----------------------------------------------------------------------------
// Minimal fake of a Shelly Gen2+ device: a real HTTP server answering
// `GET /shelly` and `POST /rpc`, with optional SHA-256 digest authentication.
//
// A real server (rather than a stubbed fetch) is what makes the RPC tests
// meaningful: the digest handshake, the 401 round trip and the nonce counter
// are protocol behaviour, and only an actual HTTP exchange proves we speak it.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-256 hex digest helper, mirroring what a Shelly device computes.
 * @param {string} value string to hash
 * @returns {string} lowercase hex digest
 */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Start a fake Shelly device.
 * @param {object} [options] device options
 * @param {object} [options.info] payload returned by `GET /shelly`
 * @param {object} [options.status] payload returned by `Shelly.GetStatus`
 * @param {object} [options.config] payload returned by `Shelly.GetConfig`
 * @param {string} [options.password] when set, RPC requires digest auth
 * @returns {Promise<object>} the running fake device
 */
export async function startFakeShelly({
  info = {
    name: null,
    id: 'shellyplusplugs-fcb467266e2c',
    mac: 'FCB467266E2C',
    model: 'SNPL-00112EU',
    gen: 2,
    fw_id: '20241011-114455',
    ver: '1.4.4',
    app: 'PlusPlugS',
    auth_en: false,
  },
  status = {
    'switch:0': {
      id: 0,
      output: false,
      apower: 0,
      voltage: 0,
      current: 0,
      aenergy: { total: 1234.5 },
      temperature: { tC: 32.4 },
    },
  },
  config = { sys: { device: { name: null } } },
  password = null,
} = {}) {
  const calls = [];
  const nonce = randomBytes(8).toString('hex');
  const realm = info.id;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const respond = (payload, statusCode = 200, headers = {}) => {
        res.statusCode = statusCode;
        res.setHeader('content-type', 'application/json');
        Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && req.url === '/shelly') {
        respond({ ...info, auth_en: Boolean(password) });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/rpc') {
        respond({ error: 'not found' }, 404);
        return;
      }

      if (password) {
        const header = req.headers.authorization || '';
        const expectedHa1 = sha256(`admin:${realm}:${password}`);
        const params = Object.fromEntries(
          [...header.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [
            match[1],
            match[2] !== undefined ? match[2] : match[3],
          ]),
        );
        const expected =
          params.nc && params.cnonce
            ? sha256(
                `${expectedHa1}:${nonce}:${params.nc}:${params.cnonce}:auth:${sha256('POST:/rpc')}`,
              )
            : null;
        if (!header.startsWith('Digest ') || params.response !== expected) {
          respond({ error: 'unauthorized' }, 401, {
            'www-authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", algorithm=SHA-256`,
          });
          return;
        }
      }

      const request = JSON.parse(body);
      calls.push(request);

      if (request.method === 'Shelly.GetStatus') {
        respond({ id: request.id, result: status });
      } else if (request.method === 'Shelly.GetConfig') {
        respond({ id: request.id, result: config });
      } else if (request.method === 'Switch.Set') {
        const component = status[`switch:${request.params.id}`];
        if (!component) {
          respond({ id: request.id, error: { code: 404, message: 'No handler for Switch.Set' } });
          return;
        }
        const was = component.output;
        component.output = Boolean(request.params.on);
        respond({ id: request.id, result: { was_on: was } });
      } else {
        respond({ id: request.id, error: { code: 404, message: 'No handler for that method' } });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    host: `127.0.0.1:${port}`,
    port,
    info,
    status,
    config,
    /** Every RPC request the device received, in order. */
    calls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A realistic Shelly Pro 3EM status payload (captured from a real device). */
export const PRO_3EM_STATUS = {
  sys: { mac: '2CBCBBA663CC', uptime: 481234 },
  wifi: { sta_ip: '10.5.0.171', status: 'got ip', rssi: -58 },
  'em:0': {
    id: 0,
    a_act_power: -8.4,
    a_aprt_power: 628.6,
    a_current: 2.76,
    a_freq: 50,
    a_pf: 0.01,
    a_voltage: 227.8,
    b_act_power: 107.9,
    b_aprt_power: 532.4,
    b_current: 2.342,
    b_freq: 50,
    b_pf: 0.2,
    b_voltage: 227.5,
    c_act_power: -1150.3,
    c_aprt_power: 1272.8,
    c_current: 5.578,
    c_freq: 50,
    c_pf: 0.9,
    c_voltage: 228.4,
    n_current: 6.926,
    total_act_power: -1050.756,
    total_aprt_power: 2433.709,
    total_current: 10.68,
  },
  'emdata:0': {
    id: 0,
    a_total_act_energy: 7915525.36,
    a_total_act_ret_energy: 329811.77,
    b_total_act_energy: 6537028.17,
    b_total_act_ret_energy: 215225.07,
    c_total_act_energy: 7503374.27,
    c_total_act_ret_energy: 284224.17,
    total_act: 21955927.8,
    total_act_ret: 829261.02,
  },
};

/** A realistic Shelly Pro 4PM status payload (four metered relays). */
export const PRO_4PM_STATUS = {
  sys: { mac: 'ECE334EA4D10' },
  'switch:0': {
    id: 0,
    output: true,
    apower: 12.3,
    voltage: 231.4,
    current: 0.058,
    aenergy: { total: 45678.9 },
    temperature: { tC: 41.2 },
  },
  'switch:1': {
    id: 1,
    output: false,
    apower: 0,
    voltage: 231.1,
    current: 0,
    aenergy: { total: 12.3 },
    temperature: { tC: 41.1 },
  },
  'switch:2': {
    id: 2,
    output: false,
    apower: 0,
    voltage: 231.2,
    current: 0,
    aenergy: { total: 0 },
    temperature: { tC: 40.9 },
  },
  'switch:3': {
    id: 3,
    output: true,
    apower: 4.7,
    voltage: 231.0,
    current: 0.021,
    aenergy: { total: 987.6 },
    temperature: { tC: 41.4 },
  },
  'temperature:100': { id: 100, tC: 41.2, tF: 106.2 },
};
