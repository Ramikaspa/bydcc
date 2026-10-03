/**
 * BYD 120 kW commercial DC charging curve.
 *
 * Phase 1 (0–80% SoC): constant-current, 100–120 kW
 * Phase 2 (80–95% SoC): power taper (CV-like drop)
 * Phase 3 (95–100% SoC): trickle ~7 kW
 *
 * Voltage 380–420 V DC, current 0–250 A, ±2% jitter on V/I.
 */

export function jitter(value, pct = 0.02) {
  if (value === 0) return 0;
  return value * (1 + (Math.random() * 2 - 1) * pct);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function targetPowerW(soc, profile) {
  const ccMin = profile.ccPowerMin ?? 100000;
  const ccMax = profile.ccPowerMax ?? 120000;
  const trickle = profile.tricklePower ?? 7000;
  const cvStart = profile.cvSocStart ?? 80;
  const trickleStart = profile.trickleSocStart ?? 95;
  const maxPower = profile.maxPower ?? 120000;

  let power;
  if (soc < cvStart) {
    // CC: voltage rises with SoC so delivered power climbs 100 → 120 kW
    const t = clamp(soc / cvStart, 0, 1);
    power = ccMin + (ccMax - ccMin) * t;
  } else if (soc < trickleStart) {
    const t = (soc - cvStart) / (trickleStart - cvStart);
    const eased = 1 - (1 - t) ** 1.6;
    const p80 = ccMax;
    power = p80 + (trickle - p80) * eased;
  } else {
    power = trickle;
  }

  return clamp(power, 0, maxPower);
}

export function voltageForSoc(soc, profile) {
  const vMin = profile.voltageMin ?? 380;
  const vMax = profile.voltageMax ?? 420;
  // Pack voltage sits in the upper half of 380–420 V so 250 A still yields ~100 kW in CC.
  // Nameplate 120 kW is the cabinet rating (shared across two connectors).
  const t = clamp(soc, 0, 100) / 100;
  return vMin + (vMax - vMin) * (0.55 + 0.45 * t);
}

export function nextSample(state, profile, dtSec) {
  const soc = clamp(state.soc, 0, 100);
  const maxI = profile.maxCurrent ?? 250;
  const maxP = profile.maxPower ?? 120000;

  let voltage = voltageForSoc(soc, profile);
  let power = targetPowerW(soc, profile);
  let current = voltage > 0 ? power / voltage : 0;

  if (current > maxI) {
    current = maxI;
    power = current * voltage;
  }
  if (power > maxP) {
    power = maxP;
    current = voltage > 0 ? power / voltage : 0;
  }

  voltage = jitter(voltage, 0.02);
  current = jitter(Math.max(0, current), 0.02);
  voltage = clamp(voltage, profile.voltageMin ?? 380, profile.voltageMax ?? 420);
  current = clamp(current, 0, maxI);
  power = clamp(voltage * current, 0, maxP);

  const energyDeltaWh = power * (dtSec / 3600);
  const batteryKwh = profile.batteryCapacityKwh ?? 80;
  const socDelta = batteryKwh > 0 ? (energyDeltaWh / 1000 / batteryKwh) * 100 : 0;
  const nextSoc = clamp(soc + socDelta, 0, 100);

  const load = maxP > 0 ? power / maxP : 0;
  const boardTemp = 38 + 28 * load + (Math.random() * 1.4 - 0.7);
  const connectorTemp = 32 + 22 * (maxI > 0 ? current / maxI : 0) + (Math.random() * 1.2 - 0.6);

  return {
    voltage,
    current,
    power,
    soc: nextSoc,
    energyWh: state.energyWh + energyDeltaWh,
    boardTemp,
    connectorTemp,
    frequency: jitter(50, 0.004),
    powerFactor: clamp(jitter(0.99, 0.01), 0.92, 1),
    phase: soc < (profile.cvSocStart ?? 80)
      ? "CC"
      : soc < (profile.trickleSocStart ?? 95)
        ? "CV"
        : "trickle",
  };
}
