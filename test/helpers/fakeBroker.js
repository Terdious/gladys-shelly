// -----------------------------------------------------------------------------
// A REAL MQTT broker, in process, plus a fake Shelly speaking to it.
//
// Using a real broker rather than a stubbed mqtt client is what makes these
// tests worth writing: wildcard subscription matching, retained-message
// ordering and the request/reply correlation over two separate topics are
// broker behaviour, and only an actual pub/sub exchange proves we speak it.
// -----------------------------------------------------------------------------

import net from 'node:net';

import { Aedes } from 'aedes';
import mqtt from 'mqtt';

/**
 * Start an in-process MQTT broker on a free port.
 * @returns {Promise<object>} the running broker
 */
export async function startFakeBroker() {
  const aedes = await Aedes.createBroker();
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    address: `127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => aedes.close(resolve));
    },
  };
}

/**
 * A fake Shelly device that lives ONLY on MQTT — no HTTP, no mDNS, nothing on
 * the local network. This is the device the bench could never discover.
 *
 * @param {object} options device options
 * @param {string} options.address broker address
 * @param {string} options.shellyId the device id, sent as `src`
 * @param {string} [options.prefix] topic prefix (defaults to the id, as Shelly does)
 * @param {object} [options.status] the `Shelly.GetStatus` result
 * @param {object} [options.info] the `Shelly.GetDeviceInfo` result
 * @param {object} [options.config] the `Shelly.GetConfig` result
 * @param {boolean} [options.control] whether "MQTT Control" is enabled
 * @returns {Promise<object>} the running fake device
 */
export async function startMqttShelly({
  address,
  shellyId,
  prefix = shellyId,
  status = { 'switch:0': { id: 0, output: false, apower: 0 } },
  info = { id: shellyId, model: 'SNPL-00112EU', gen: 2, name: null },
  config = { sys: { device: { name: null } } },
  control = true,
}) {
  const client = mqtt.connect(`mqtt://${address}`, { clientId: `fake-${shellyId}` });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });

  if (control) {
    await new Promise((resolve) => client.subscribe(`${prefix}/rpc`, resolve));
    client.on('message', (topic, raw) => {
      if (topic !== `${prefix}/rpc`) {
        return;
      }
      const request = JSON.parse(raw.toString());
      const answer = (result) =>
        client.publish(
          `${request.src}/rpc`,
          JSON.stringify({ id: request.id, src: shellyId, result }),
        );

      if (request.method === 'Shelly.GetStatus') {
        answer(status);
      } else if (request.method === 'Shelly.GetConfig') {
        answer(config);
      } else if (request.method === 'Shelly.GetDeviceInfo') {
        answer(info);
      } else if (request.method === 'Switch.Set') {
        const component = status[`switch:${request.params.id}`];
        const was = component?.output;
        if (component) {
          component.output = Boolean(request.params.on);
        }
        answer({ was_on: was });
      } else {
        client.publish(
          `${request.src}/rpc`,
          JSON.stringify({ id: request.id, error: { code: 404, message: 'No handler' } }),
        );
      }
    });
  }

  return {
    shellyId,
    prefix,
    status,
    /** Publish a `NotifyStatus`, the way a real device does when a value moves. */
    push(params, method = 'NotifyStatus') {
      client.publish(
        `${prefix}/events/rpc`,
        JSON.stringify({ src: shellyId, dst: 'all', method, params }),
      );
    },
    /** Publish a Gen1 scalar topic under `shellies/<id>/…`. */
    pushGen1(suffix, payload) {
      client.publish(`shellies/${shellyId}/${suffix}`, String(payload));
    },
    async close() {
      await new Promise((resolve) => client.end(true, {}, resolve));
    },
  };
}
