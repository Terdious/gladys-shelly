# Roadmap — Shelly external integration

> Tracking lives in the GitHub issues — central roadmap:
> [#1](https://github.com/Terdious/gladys-shelly/issues/1). This file is the
> technical companion: shipped scope, frozen conventions, and pointers.

## Shipped — v0.1.0

- **Repository brought up to the [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)**:
  manifest, Dockerfile (multi-arch, read-only rootfs, non-root), CI (Prettier /
  ESLint / `node --test`), Release + Build workflows, PR template, bilingual
  documentation.
- **Gen2+ local RPC transport** (`src/shelly/rpc.js`): JSON-RPC over
  `POST /rpc`, SHA-256 HTTP digest authentication with challenge caching and
  nonce counter, typed errors separating "retry later" from "the user must fix
  something".
- **Discovery** (`src/shelly/discovery.js`): core-mediated mDNS
  (`_shelly._tcp`, contract B.16) merged with hand-typed addresses and the
  addresses of the already-created devices, unicast probing with bounded
  concurrency, deduplication on the hardware identity, Gen1 and Gen2+ side by side.
- **Capability-derived device model** (`src/shelly/features.js`): the feature
  set comes from the components the device actually reports, never from a model
  table — a Shelly released after this code still maps. Covers `switch`, `em`,
  `emdata`, `em1`, `em1data`, `pm1`, `temperature`, `humidity`, `devicepower`.
- **Dual transport with badges** (`src/shelly/client.js`): local first, Shelly
  Cloud fallback, per-device `local` / `cloud` / `unreachable` published to
  Gladys (contract C.3), with the **degraded** flag and its reason when the
  fallback is not the nominal path. Honours the core's `GLADYS_PREFER_LOCAL`.
- **Telemetry** (`src/shelly/telemetry.js`): global refresh loop, state
  deduplication with a 30-minute keep-alive (the host API caps states at
  300/minute), 100-state batching, overlapping-cycle guard.
- **Per-device local circuit breaker** (`src/shelly/localCircuit.js`, same
  pattern as the Tuya integration): after 3 consecutive local failures a device
  is parked for 5 minutes instead of burning a 5 s timeout and a WARN line on
  every cycle. It is re-probed once per cooldown, un-parked on a credentials
  fix, and a deliberate user command still bypasses the park when there is no
  cloud to fall back on.
- **Control**: `Switch.Set` over whichever transport works, optimistic
  feedback, and a **failed ack** when the command could not be delivered.

## Shipped — real-time push (issue #2)

- **Gen2+ RPC over WebSocket** (`src/shelly/wsRpc.js`): the device pushes
  `NotifyStatus` / `NotifyFullStatus` instead of being polled. Handles the
  WebSocket digest scheme, which differs from the HTTP one in two ways that
  silently break naive implementations: the `auth` object lives INSIDE the JSON
  request, and its HA2 is the constant `sha256("dummy_method:dummy_uri")`.
  Reconnects for life with exponential backoff.
- **Declarative connection hub** (`src/shelly/wsHub.js`): `sync(targets)` opens,
  keeps or closes connections to match the devices that exist right now — the
  same list the poll loop already builds, so there is no second inventory.
- **Coalescing, because a Pro 3EM pushes about once a second.** Forwarding that
  verbatim would be ~900 states/minute against a 300/minute cap. Controllable
  states (a relay flipping) flush within a second — that is the latency a user
  feels — while measurements ride the configured cadence but are served from
  the freshest pushed value instead of an HTTP round trip.
- **The poll loop stays**, as a safety net: a live device is still read every
  5 minutes, because a socket can stay open and silent (device wedged, firmware
  bug) and only a real read tells that apart from "nothing changed".

## Shipped — v1.0.0 (2026-08-01)

- **Gen1 devices** (issue #7, polling part): REST + Basic auth, normalized into
  the Gen2+ component model (`src/shelly/gen1/`), so a Gen1 3EM exposes the same
  24 features as a Pro 3EM.
- **MQTT** as a third transport and as the reliable inventory of a large fleet
  (`src/shelly/mqttHub.js`): Gen2+ RPC frames and the Gen1 topic dialect.
- **Self-pacing real-time lane**: measures the states it publishes and stretches
  its cadence to stay within the 300 states/min budget.

## Shipped — next release (Unreleased in CHANGELOG.md)

- **Ecosystem upgrade**: SDK 0.15, Gladys >= 5.1.0, catalog categories, release
  tooling (GitHub Releases from CHANGELOG.md), CI on Node 22 + 24 with a Docker
  build, Dependabot, SECURITY.md, mqtt 5.16.
- **Four languages** (en, fr, de, es): manifest, runtime messages, user docs,
  and the `feature_names` option for new devices.
- [#3](https://github.com/Terdious/gladys-shelly/issues/3) **Roller shutters**
  (`cover:N`): state + position (calibrated only), Gen1 2.5 roller mode.
- [#4](https://github.com/Terdious/gladys-shelly/issues/4) **Lights**
  (`light`, `rgb`, `rgbw`, `cct`): on/off, brightness, colour, colour
  temperature (mireds). Gen1 Dimmer / Bulb / Duo / RGBW2 colour mode.
- [#5](https://github.com/Terdious/gladys-shelly/issues/5) **Inputs**
  (`input:N`): switch mode -> input, button mode -> button fed by
  `NotifyEvent` + `input_event` scene trigger, count mode -> counter.
- **Scenes**: `input_event` and `device_reachability_changed` triggers,
  `turn_on_for` (device-side timer) and `reboot` actions.
- **Widgets**: `energy_meter`, `switches`, `shutters`, `network`.
- **Diagnostic** actions: `fleet_diagnostic`, `test_device`.
- **241 tests** (`node --test`).

Covers, lights and inputs follow the documented API and are **waiting for
bench validation**: #3, #4 and #5 stay open until a user confirms them on real
hardware (position direction, colour round trip, button events).

## Open

Priority order.

- **Bench validation** of #3 / #4 / #5 on real hardware (Plus 2PM in cover
  mode, Plus RGBW PM, Plus i4 / i4 Gen3, Gen1 2.5 roller, Dimmer 2).
- [#6](https://github.com/Terdious/gladys-shelly/issues/6) **Validate the
  Shelly Cloud fallback on a real account** — status, relay, and now the roller
  and light control calls (`/device/relay/roller/control`,
  `/device/relay/roller/settings/topos`, `/device/light/control`).
- [#9](https://github.com/Terdious/gladys-shelly/issues/9) **Per-device
  passwords** — today one password is shared by every device.
- [#12](https://github.com/Terdious/gladys-shelly/pull/12) **Virtual
  components** (external contribution, LinkedGo ST1820 thermostat): review and
  rebase on the new command router (`src/shelly/commands.js`).
- [#7](https://github.com/Terdious/gladys-shelly/issues/7) **Gen1, what is
  left**: battery-powered sleepy sensors (H&T, Flood, Door/Window) need an
  "expected to sleep" rule before mapping; Gen1 button events (CoIoT, or the
  `event_cnt` of `/status` over MQTT).
- RGBW white channel, analog inputs (no matching Gladys category yet), the
  `energy_meter` widget's daily energy (needs midnight snapshots in `/data`).

## external_id conventions (FROZEN)

Renaming a suffix RE-CREATES the feature on every existing install and orphans
its history. These are contracts, not implementation details.

- Device: `ext:shelly:device:<shelly id>` — the Shelly id is the one from
  `GET /shelly` (`shellypro3em-2cbcbba663cc`), which embeds the MAC and is
  therefore the hardware identity.
- Feature: `ext:shelly:device:<shelly id>:<component family>:<index>:<suffix>`,
  e.g. `…:switch:0:binary`, `…:em:0:l1_active_power`,
  `…:emdata:0:total_energy`, `…:cover:0:state`, `…:cover:0:position`,
  `…:light:0:brightness`, `…:rgbw:0:color`, `…:cct:0:temperature`,
  `…:input:0:binary` / `:button` / `:counter`.
- Manifest keys, stored in users' scenes and dashboards: actions
  `fleet_diagnostic`, `test_device`; scene triggers `input_event`,
  `device_reachability_changed`; scene actions `turn_on_for`, `reboot`; widgets
  `energy_meter`, `switches`, `shutters`, `network`.
- The component family and index mirror the Shelly RPC vocabulary verbatim, so
  the command router parses them back out of the id with no lookup table.

## Design decisions worth keeping

- **One physical Shelly = one Gladys device.** A Pro 4PM is one device with
  four On/Off features, not four devices.
- **Capabilities come from the payload, not from a model table.** The only
  model list in the codebase is a cosmetic display-name map, and an unknown
  model falls back to its raw id rather than being rejected.
- **A missing measurement is never published as 0.** `null` (no neutral clamp,
  no probe) drops the feature entirely; a real zero is published.
- **Every degradation is visible.** Cloud fallback, wrong password and
  unreachable devices all surface as badges or connection-status messages
  rather than silent log lines.

## Fleet conventions

- Default branch: **`master`**; releases from the Actions → Release workflow
  (bump + tag + multi-arch image `:X.Y.Z` + `:latest`, manifest in lockstep,
  GitHub Release with the CHANGELOG.md section as notes).
- Catalog cover: **`cover.png`**, 800×534, ≤150 KB, artwork filling the frame.
- Quality gates: `npm run format:check` / `npm run lint` / `npm test`.
