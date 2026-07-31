// -----------------------------------------------------------------------------
// Per-device local health / circuit breaker.
//
// Same pattern as the Tuya integration (src/tuya/local/tuya.localCircuit.js):
// a device that is locally unreachable would otherwise be retried on EVERY
// poll cycle — 5 s of timeout burned per cycle and a WARN line every 30 s. On
// a fleet with one unplugged Shelly that is the difference between a refresh
// cycle that takes 200 ms and one that takes 5 s.
//
// After N consecutive local failures the device is parked for a cooldown:
//   - with a cloud fallback configured, it goes straight to the cloud
//     (degraded, so the user still sees why);
//   - without one, it is reported unreachable without paying the timeout, and
//     re-probed once per cooldown so it recovers by itself.
// -----------------------------------------------------------------------------

/** Consecutive local failures before a device is parked. */
export const LOCAL_FAILURE_THRESHOLD = 3;

/** How long a parked device stays parked, in ms. */
export const LOCAL_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Get (or create) the circuit entry of one device.
 * @param {Map<string, object>} circuit the circuit state
 * @param {string} shellyId the Shelly device id
 * @returns {object} the entry
 */
function getEntry(circuit, shellyId) {
  let entry = circuit.get(shellyId);
  if (!entry) {
    entry = { failures: 0, until: 0 };
    circuit.set(shellyId, entry);
  }
  return entry;
}

/**
 * Whether local access is currently parked for a device.
 * @param {Map<string, object>} circuit the circuit state
 * @param {string} shellyId the Shelly device id
 * @param {number} now current epoch ms
 * @returns {boolean} true while the cooldown is active
 */
export function isLocalInCooldown(circuit, shellyId, now) {
  const entry = circuit.get(shellyId);
  return Boolean(entry && entry.until > now);
}

/**
 * Reset a device after a successful local call.
 * @param {Map<string, object>} circuit the circuit state
 * @param {string} shellyId the Shelly device id
 */
export function recordLocalSuccess(circuit, shellyId) {
  const entry = circuit.get(shellyId);
  if (entry) {
    entry.failures = 0;
    entry.until = 0;
  }
}

/**
 * Record a failed local call and arm the cooldown once the threshold is
 * reached. Once armed, every further failure re-arms it, so a permanently
 * unreachable device is probed at most once per cooldown.
 * @param {Map<string, object>} circuit the circuit state
 * @param {string} shellyId the Shelly device id
 * @param {number} now current epoch ms
 * @param {number} [threshold] consecutive failures before parking
 * @param {number} [cooldownMs] park duration
 * @returns {{tripped: boolean, cooldownMs: number}} `tripped` is true only on
 * the exact threshold crossing, so the parking is logged once and not on every
 * later cycle
 */
export function recordLocalFailure(
  circuit,
  shellyId,
  now,
  threshold = LOCAL_FAILURE_THRESHOLD,
  cooldownMs = LOCAL_COOLDOWN_MS,
) {
  const entry = getEntry(circuit, shellyId);
  entry.failures += 1;
  if (entry.failures >= threshold) {
    entry.until = now + cooldownMs;
    return { tripped: entry.failures === threshold, cooldownMs };
  }
  return { tripped: false, cooldownMs: 0 };
}

/**
 * Clear a device (or the whole circuit): a fresh discovery may have learnt a
 * new IP, and a password fix makes every parked device worth probing again.
 * @param {Map<string, object>} circuit the circuit state
 * @param {string} [shellyId] the device to clear, or every device when omitted
 */
export function clearLocalCircuit(circuit, shellyId) {
  if (shellyId === undefined) {
    circuit.clear();
    return;
  }
  circuit.delete(shellyId);
}
