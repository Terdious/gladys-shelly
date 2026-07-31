# Shelly integration for Gladys Assistant

This integration connects your **Shelly** devices to Gladys Assistant: relays,
smart plugs and energy meters.

It talks **directly to your devices on your local network** (the Gen2+ RPC
protocol), and can fall back to the **Shelly Cloud** when a device cannot be
reached locally. No MQTT broker, no mandatory account: a fully local setup works
with an **entirely empty form**.

> **Supported generations:** Gen2 and later — Shelly **Plus**, **Pro**,
> **Mini**, **Gen3**, **Gen4**. **Gen1** devices (Shelly 1, 2.5, Plug S
> "SHPLG-S", Dimmer 2…) use a completely different API and are **not supported
> yet**; they are detected and skipped cleanly, with an explicit log line.

---

## Requirements

- Gladys Assistant **4.83.0** or newer.
- Your Shelly devices are powered and joined to your Wi-Fi (set up from the
  Shelly app or the device web interface).
- Gladys and your Shelly devices are on the **same local network** — or you know
  the IP addresses of the devices sitting on another VLAN.

---

## Step 1 — Install the integration

In Gladys: **Integrations → Install an integration → Shelly**, then **Install**.
Gladys pulls the Docker image and starts the container.

There is **nothing to configure** for a simple local setup: go straight to
step 3.

---

## Step 2 — Configure (only if you need to)

Open the integration **Configuration** screen. Every field is optional.

### Local connection

| Field                           | When to fill it in                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Additional device addresses** | Your Shelly devices are not found automatically (another VLAN, mDNS disabled on the device or filtered by the router). Enter the IPs, comma-separated. |
| **Device username**             | Leave it as `admin`: it is the only username Gen2+ devices accept.                                                                                     |
| **Device password**             | You enabled authentication on your Shelly devices. **One single password** is used for all of them.                                                    |

> ⚠️ If your Shelly devices have **different** passwords, the integration can
> only reach the ones sharing the password you entered. Unify the password, or
> disable authentication on your trusted local network.

### Shelly Cloud (fallback)

Fill this in only if you want Gladys to keep controlling a device that is
**unreachable locally** (Gladys hosted elsewhere, device on another network,
temporary Wi-Fi drop).

1. Open the **Shelly** app (or <https://control.shelly.cloud/>).
2. **Settings → User settings → Authorization cloud key**.
3. Click **Get key**: the app shows the **authorization key** and the **server
   address** (something like `shelly-53-eu.shelly.cloud`).
4. Copy both values into Gladys and turn on **Enable the Shelly Cloud
   fallback**.

> 🔐 This key grants **full control** over every device of your Shelly account.
> Treat it like a password. Gladys stores it encrypted and never shows it in
> clear text.

When both channels are configured, Gladys shows a standard **"Prefer the local
connection"** toggle (on by default). It is a preference: the integration
applies it when it can, and reports the per-device reality through the
**transport badges** (see below).

### Advanced

**Refresh interval**: how often Gladys reads the state of every device. 30
seconds by default.

A shorter interval means fresher values but more requests. Gladys rate-limits an
integration to **300 states per minute**: the integration only publishes values
that **actually changed** (with a forced refresh every 30 minutes so a frozen
value does not look dead), so a short interval only hurts when many values move
constantly. A single Shelly Pro 3EM carries ~25 measurements: past three or four
energy meters, stay at 30 seconds or more.

---

## Step 3 — Discover your devices

Go to the integration **Discovery** tab and click **Scan**.

Gladys queries three sources and merges them:

1. **mDNS** — your Shelly devices announce themselves on the network (the
   `_shelly._tcp` service). The Gladys core listens on behalf of the
   integration: containers run on a bridge network and never receive multicast
   traffic.
2. **The addresses you typed** in step 2.
3. **The addresses of the devices already created** in Gladys — a re-scan never
   loses a device whose mDNS announcement was missed.

Each address is then queried over **unicast** (which does cross the bridge
network). Click **Create** to add a device to Gladys.

### One Shelly = one Gladys device

A Shelly Pro 4PM becomes **one single Gladys device** carrying **four** On/Off
features, plus their measurements. This is the Gladys convention, and it keeps
the external ids stable when you rename a channel.

If you named your channels in the Shelly app ("Bathroom", "Toilet"…), those
names are picked up: you get "Bathroom — On/Off" rather than four identical
"On/Off". **Name your channels in the Shelly app before running the
discovery**: it is the fastest way to get a readable result.

---

## Supported devices and measurements

Features are derived from what the device **actually reports**, never from a
hard-coded model table: a Shelly Pro 1 (no metering) only exposes an On/Off, a
Pro 1PM also exposes power, voltage, current and energy — and a Shelly released
after this version works as long as it speaks the same vocabulary.

| Shelly component      | What you get in Gladys                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `switch:N`            | On/Off (controllable), power (W), voltage (V), current (A), total energy (kWh), internal temperature (°C)                     |
| `em:N` (three-phase)  | Per L1/L2/L3 phase: active power (W), apparent power (VA), voltage (V), current (A) — plus the totals and the neutral current |
| `emdata:N`            | Total and returned energy, per phase and total (kWh)                                                                          |
| `em1:N` / `em1data:N` | Single-phase equivalents (Shelly Pro EM, 1PM Mini Gen3)                                                                       |
| `pm1:N`               | Power, voltage, current and energy of a standalone meter (PM Mini)                                                            |
| `temperature:N`       | Temperature (°C)                                                                                                              |
| `humidity:N`          | Humidity (%)                                                                                                                  |
| `devicepower:N`       | Battery level (%)                                                                                                             |

Hardware validated by design against real payloads: **Shelly Pro 3EM**,
**Shelly Pro 4PM**, **Shelly Plus Plug S**.

> **Not supported yet:** roller shutters (`cover`), dimmable lights (`light`),
> inputs (`input`), Gen1 devices. See the [roadmap](./ROADMAP.md).

### The neutral current

On a Pro 3EM, `n_current` is only measured when you **wired the neutral clamp**.
Without it the device returns `null`: the feature is then **not created at all**
rather than showing a permanently empty chart. If you add the clamp later, run a
discovery again to make the measurement appear.

---

## Transport badges

Every device shows a badge in Gladys telling you **which channel actually
reaches it**:

| Badge                  | Meaning                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Local**              | Nominal. Gladys talks directly to the device on your network.                                                      |
| **Cloud**              | Gladys goes through the Shelly Cloud (you turned off "Prefer the local connection").                               |
| **Cloud** + orange dot | **Degraded**: the device was not reachable locally, Gladys fell back to the cloud. Hover the badge for the reason. |
| **Unreachable**        | Neither the local network nor the cloud answered.                                                                  |

A **Cloud badge with an orange dot** is the one to watch: your setup works, but
not in its nominal mode. The tooltip gives the cause — device powered off, IP
changed, or password refused.

---

## Updating the integration

Gladys shows available updates in **Integrations**. Click **Update**: the
container is recreated with the new image, and your configuration and devices
are preserved.

---

## Troubleshooting

### No device found during the scan

1. **Check that the device answers.** From a browser on the same network, open
   `http://<shelly-ip>/shelly`. You should see JSON containing `"gen": 2` (or 3,
   or 4). If there is **no** `gen` field, this is a Gen1 device: not supported
   yet.
2. **mDNS does not cross VLANs, nor some Wi-Fi access points.** Enter the IP
   addresses by hand in **Additional device addresses**, then save: the
   discovery re-runs automatically.
3. **Read the container logs** (`docker logs <container>`). The integration logs
   how many candidate addresses it has, where each came from, and the exact
   reason an address was discarded.

### "The device refused the password"

You enabled authentication on that Shelly, and the password entered in Gladys
does not match. On Gen2+ the username is **always** `admin`: only the password
matters. Fix it and save — the correction takes effect immediately, without
restarting the container.

### A device keeps falling back to Cloud (orange badge)

Its IP address most likely changed (DHCP lease). Run a **discovery** again: the
address is re-learned and remembered. To avoid a repeat, reserve a static IP for
your Shelly devices in your router.

### The Shelly Cloud rejected the authorization key

Copy the key **and** the server address from the Shelly app: they go together,
and the server address depends on your account region. A valid key on the wrong
server is rejected.

### Values do not update as fast as expected

The integration only publishes values that **changed**. A stable value is only
republished every 30 minutes. This is deliberate: Gladys limits an integration
to 300 states per minute, and a single Pro 3EM carries ~25 measurements.

If you need truly real-time values, that is the "real-time notifications
(WebSocket)" item on the [roadmap](./ROADMAP.md): Gen2+ devices can push their
changes instead of being polled.

### Migrating from an existing MQTT / Node-RED setup

This integration creates its **own** devices with its own external ids
(`ext:shelly:device:...`). It does not carry over the history of devices created
through MQTT: both can coexist during the transition, then you delete the old
ones.

---

## Going further

- [Project README](../README.md) — architecture and development
- [Roadmap](./ROADMAP.md) — what is done, what is coming
- [Shelly Gen2+ API documentation](https://shelly-api-docs.shelly.cloud/gen2/)
- [Report an issue](https://github.com/Terdious/gladys-shelly/issues)
