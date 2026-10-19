# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- **RGBW white channel** (#4): an RGBW output (Plus RGBW PM, Gen1 RGBW2 in
  colour mode) exposes its white LEDs as a 0-100 % light feature,
  controllable.
- **Profile changes** (#4): a scan names, in the logs, the features a created
  device no longer reports (a Plus 2PM switched from relays to cover...), and
  **Diagnostic of the devices** lists them, so the leftovers can be deleted.

### Changed

- **Shelly Cloud** (#6): the devices served by the cloud are read in ONE
  `all_status` request per refresh cycle instead of one request per device,
  and every Cloud API call is spaced one second apart (the documented limit);
  a rate-limit answer is named in the logs.

### Fixed

- **Gen1 devices through the Shelly Cloud** (#6): the cloud returns their flat
  Gen1 status, which is now normalized like a local Gen1 read; it was mapped
  to nothing before.

## [1.3.0] - 2026-10-19

### Added

- **Per-device passwords** (#9): a new optional secret field lists the devices
  whose password differs from the shared one, as `device=password` entries
  separated by `;` (Shelly id, MAC or IP address; a `;` or `=` inside a
  password is kept). Every path uses it: discovery, polling, real time,
  commands, Gen1, and the device test, which says which password it tried.
- A device that refuses its password gets an orange dot and the reason on its
  badge, and the Configuration screen names it (up to three names).
- **Gen1 battery sensors** (#7): Flood (water leak), Smoke, Door/Window 1 and 2
  (opening, illuminance), plus the `flood`, `smoke` and `illuminance`
  components of Gen2+ devices; over MQTT as well.
- **Sleepy devices** (#7): battery-powered models (H&T, Flood, Door/Window,
  Smoke, Button, Motion, Plus/Gen3 H&T, Plus Smoke) stay local while they
  reported in the last 26 hours: no unreachable badge, no circuit breaker, no
  "Shelly reachability changed" while they sleep; over MQTT they are not polled
  at all.
- **Gen1 buttons** (#7): single, double, triple and long presses of Gen1 inputs
  (i3, the SW inputs of a 1 or 2.5) become a button feature and fire "Button
  pressed on a Shelly", from the MQTT `input_event` topic or from the press
  counter of each reading, counted once when both report it.

## [1.2.0] - 2026-10-19

### Added

- **Virtual components** (`number:N`, `boolean:N`) of "Powered by Shelly"
  devices, read from `Shelly.GetComponents` (paginated): the LinkedGo ST1820
  floor-heating thermostat now exposes its setpoint (controllable, clamped to
  the device range and step), room temperature, humidity and on/off options.
  Writes go over the local network or MQTT. Contributed by @sylvainpelissier
  (#12).

## [1.1.0] - 2026-10-19

### Added

- **Roller shutters** (`cover:N`, roadmap #3): open / stop / close and the
  position (100 % = open, as in Gladys) through the standard Gladys shutter
  control, power, voltage, current, energy and temperature. The position only
  exists on a calibrated cover. Gen1 Shelly 2.5 in roller mode included.
- **Lights** (roadmap #4): dimmers (`light:N`) with on/off and brightness,
  colour outputs (`rgb:N`, `rgbw:N`) with the colour, tunable whites (`cct:N`)
  with the colour temperature (2700 K to 6500 K, in mireds as Gladys expects),
  and their power. Gen1 Dimmer, Bulb, Duo and RGBW2 in colour mode included.
- **Inputs and buttons** (`input:N`, roadmap #5): an input in switch mode is a
  real-time on/off input, a button a Gladys button fed by the device events
  (single, double, triple, long press over the WebSocket or MQTT), a counter a
  counter. A Shelly i4 now gives four usable buttons. Gen1 inputs (i3) report
  their on/off state.
- Devices created before get their new features (inputs of a Pro 4PM or a Plus
  1, a calibrated cover...) with **Update** in the Discover tab; their existing
  features, ids, history and scenes are unchanged.
- **Scene triggers** (Gladys 5.1): **Button pressed on a Shelly** (device,
  input, press) and **Shelly reachability changed** (unreachable on every
  transport / reachable again). A press delivered by both the WebSocket and MQTT
  runs the scene once.
- **Scene actions**: **Turn on for a duration** (the Shelly itself switches the
  relay or the light off after 1 s to 1 day, `toggle_after` / Gen1 `timer`, so
  a Gladys restart never leaves it on) and **Restart a Shelly**.
- **Dashboard widgets**: **Shelly energy meter** (live power gauge, phase or
  channel tiles, energy, power chart, voltages, currents, power factor,
  frequency, source), **Shelly switches** (state and power per output, total,
  All on / All off), **Shelly shutters** (state and position per cover, Open /
  Stop / Close / Position for the group) and **Shelly network health** (real
  time, fallback and unreachable devices, weak Wi-Fi, firmware updates, Gladys
  state budget).
- **Diagnostic** buttons on the Configuration screen: **Diagnostic of the
  devices** (configuration without any secret, real-time channels, state
  budget, then per device transport, last data, circuit breaker, components,
  Wi-Fi signal, uptime, firmware update, outputs) and **Test a device** (reads
  one device now, created or not, by its IP: identity, answer times, password,
  components, real time, with a hint on failure). Read-only; MAC addresses and
  local addresses masked by default.
- **Feature names** option: the names of newly discovered devices in English,
  French, German or Spanish. Existing devices, ids and selectors unchanged.
- Model names of the Plus i4, i4 Gen3, Plus RGBW PM, Plus 0-10V Dimmer, Pro
  Dual Cover PM, 1 Gen3, 2PM Gen3 and Plug S Gen3.
- Every text of the Configuration screen, the connection messages, the badges
  and the user documentation in English, French, German and Spanish
  (`docs/de.md`, `docs/es.md`).
- GitHub Releases: each version tag gets its release with the notes of this
  file, linked from the Gladys Supervision page.

### Changed

- Gladys **5.1.0** or newer is required (widgets, scene triggers and actions),
  the catalog lists the integration under Energy and Lighting.
- Integration SDK 0.15.0, Node 22 or newer; the CI runs on Node 22 and 24 and
  builds the Docker image; Dependabot keeps the dependencies up to date.
- The `/data` volume belongs to the `node` user of the image.

### Security

- mqtt 5.16: six broker-reachable advisories fixed (several could crash the
  integration). The MQTT connection keeps retrying after a refused CONNACK (a
  broker restarting, credentials being fixed) instead of stopping for good.
- `SECURITY.md`: how to report a vulnerability privately.

## [1.0.0] - 2026-08-01

### Added

- First release: Gen2+ local RPC with SHA-256 digest authentication, Gen1
  devices normalized into the same model, core-mediated mDNS discovery merged
  with typed and remembered addresses, MQTT as a third transport and inventory,
  and the Shelly Cloud as a fallback, with per-device transport badges and the
  degraded state.
- Features derived from the reported components: relays (`switch`),
  three-phase and single-phase meters (`em`, `emdata`, `em1`, `em1data`,
  `pm1`), temperature, humidity and battery.
- Real-time updates over the Gen2+ WebSocket and MQTT, with a self-pacing
  real-time lane that keeps the fleet within the Gladys budget of 300 states
  per minute.
- Per-device local circuit breaker, connection status on the Configuration
  screen, English and French documentation.

[Unreleased]: https://github.com/Terdious/gladys-shelly/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Terdious/gladys-shelly/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Terdious/gladys-shelly/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Terdious/gladys-shelly/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Terdious/gladys-shelly/releases/tag/v1.0.0
