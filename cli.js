#!/usr/bin/env node
import { BydOcppSimulator, loadProfile, DEFAULT_PROFILE_PATH } from "./byd_charger_simulator.js";

function parseDuration(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|m|min|mins|h|hr|hrs|hours)?$/i);
  if (!m) throw new Error(`Invalid --duration ${raw} (try 30min, 45s, 1h)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return n / 1000;
  if (unit === "s" || unit === "sec" || unit === "secs") return n;
  if (unit === "m" || unit === "min" || unit === "mins") return n * 60;
  return n * 3600;
}

function parseArgs(argv) {
  const out = {
    url: null,
    id: "BYD-001",
    duration: "30min",
    soc: 30,
    connector: 1,
    idTag: "BYD-RFID-001",
    mode: "rfid",
    protocol: "1.6J",
    profile: DEFAULT_PROFILE_PATH,
    fault: null,
    faultAt: 88,
    serial: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") out.url = next();
    else if (a === "--id") out.id = next();
    else if (a === "--duration") out.duration = next();
    else if (a === "--soc") out.soc = Number(next());
    else if (a === "--connector") out.connector = Number(next());
    else if (a === "--id-tag" || a === "--idTag") out.idTag = next();
    else if (a === "--mode") out.mode = next();
    else if (a === "--ocpp" || a === "--protocol") out.protocol = next();
    else if (a === "--profile") out.profile = next();
    else if (a === "--fault") out.fault = next();
    else if (a === "--fault-at") out.faultAt = Number(next());
    else if (a === "--serial") out.serial = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  return `BYD 120 kW commercial DC charger — OCPP simulator

Usage:
  npm run simulator -- --url ws://localhost:18473/ocpp --id BYD-001 --duration 30min --soc 30

Options:
  --url <ws://|wss://>   CSMS WebSocket URL (required)
  --id <ChargePointId>   Charge point identity in the connection path
  --duration <30min>     Session length (30s, 30min, 1h). Omit to run until SoC 100% or Ctrl+C
  --soc <n>              Starting state of charge (default 30)
  --connector <n>        Connector id (default 1 of 2)
  --id-tag <RFID>        idTag for Authorize / StartTransaction
  --mode rfid|pnc|app    RFID (default), Plug & Charge, or App Start (RemoteStart)
  --ocpp 1.6J|2.0.1      Protocol (default 1.6J JSON)
  --fault OverTemp|OverCurrent|GroundFailure
  --fault-at <soc>       Inject fault once SoC reaches this value
  --profile <path>       Override byd_120kw_profile.json
  --serial BYD-DC-XXXXXX
`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.url) {
    console.error("Missing --url. Example:\n  npm run simulator -- --url ws://localhost:18473/ocpp --id BYD-001 --duration 30min --soc 30");
    process.exit(1);
  }
  if (!/^wss?:\/\//i.test(args.url)) {
    console.error("--url must start with ws:// or wss://");
    process.exit(1);
  }

  const durationSec = args.duration ? parseDuration(args.duration) : null;
  const profile = loadProfile(args.profile);
  const sim = new BydOcppSimulator({
    protocol: args.protocol,
    profile,
    startMode: args.mode,
    fault: args.fault,
    faultAtSoc: args.faultAt,
    serialNumber: args.serial,
  });

  const shutdown = async (reason) => {
    try {
      await sim.stopCharging(reason);
    } catch (err) {
      console.error("[CP] stop failed:", err.message);
    }
    sim.disconnect();
  };

  process.on("SIGINT", () => {
    console.log("\n[CP] Local stop (SIGINT)");
    shutdown("Local").then(() => process.exit(0));
  });

  await sim.connect(args.url, args.id, args.connector);

  if (args.mode !== "app") {
    await sim.startCharging(args.idTag, args.soc);
  } else {
    await sim.startCharging(args.idTag, args.soc);
  }

  if (durationSec != null) {
    console.log(`[CP] charging for ${durationSec}s then StopTransaction`);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, durationSec * 1000);
      t.unref?.();
      const check = setInterval(() => {
        if (sim.status === "Available" || sim.status === "Faulted") {
          clearInterval(check);
          clearTimeout(t);
          resolve();
        }
      }, 500);
    });
    if (sim.transactionId != null) {
      await shutdown("Local");
    } else {
      sim.disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
