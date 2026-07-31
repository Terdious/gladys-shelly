// -----------------------------------------------------------------------------
// Minimal fake of the Gladys core host API (REST + WebSocket) implementing
// the slice of the integration contract the SDK uses:
//   - WS: authenticate.integration-request -> authentication.connected,
//     plus server-initiated messages (scan request, device poll);
//   - REST: GET /device, GET /config, POST /config, POST /discovered_device,
//     POST /state.
// Lets the e2e test run the REAL @gladysassistant/integration-sdk client.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startFakeGladysCore({ config = {}, devices = [] } = {}) {
  const state = {
    config, // live config store, merged by POST /config (like the real core)
    discovered: [], // one entry per POST /discovered_device (the devices array)
    states: [], // flattened states of every POST /state
    connectionStatuses: [], // one entry per POST /connection_status ({connected, message?})
    transports: [], // one entry per POST /device/transport (the transports array)
    commandResults: [], // command-result acks received on the WS
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const respond = (payload, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && req.url === '/api/integration/v1/device') {
        respond(devices);
      } else if (req.method === 'GET' && req.url === '/api/integration/v1/config') {
        respond({ config: state.config });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/config') {
        // Partial merge, like the real core: keys outside the config_schema
        // are the integration's free storage (OAuth tokens...).
        Object.assign(state.config, JSON.parse(body).config);
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/discovered_device') {
        const parsed = JSON.parse(body);
        state.discovered.push(parsed.devices);
        respond({ success: true, count: parsed.devices.length });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/state') {
        const parsed = JSON.parse(body);
        state.states.push(...parsed.states);
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/connection_status') {
        state.connectionStatuses.push(JSON.parse(body));
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/device/transport') {
        const parsed = JSON.parse(body);
        state.transports.push(parsed.transports);
        respond({ success: true, count: parsed.transports.length });
      } else {
        respond({ code: 'NOT_FOUND', message: `no route for ${req.method} ${req.url}` }, 404);
      }
    });
  });

  const wss = new WebSocketServer({ server });
  let socket = null;
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'authenticate.integration-request') {
        ws.send(JSON.stringify({ type: 'authentication.connected', payload: {} }));
      }
      if (message.type === 'external-integration.command-result') {
        state.commandResults.push(message.payload);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,

    /** Send a server-initiated message to the connected integration. */
    send(type, payload) {
      socket.send(JSON.stringify({ type, payload }));
    },

    async close() {
      socket?.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Poll until `predicate()` is truthy (or fail after `timeout` ms). */
export async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
