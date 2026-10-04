# BYD OCPP 1.6J charge point

Real **OCPP 1.6 JSON** over WebSocket (`ocpp1.6` subprotocol), not a toy mock. Every CALL / CALLRESULT is checked against the 1.6 schema (required fields, enums, CiString lengths, ISO8601, no extra properties). Invalid CSMS calls are answered with **CALLERROR** (`FormationViolation` / `TypeConstraintViolation` / `NotImplemented`).

Charge Point → CSMS: BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction, MeterValues, StopTransaction, plus DiagnosticsStatusNotification / FirmwareStatusNotification when triggered.

CSMS → Charge Point: RemoteStartTransaction, RemoteStopTransaction, Reset, UnlockConnector, ChangeAvailability, GetConfiguration, ChangeConfiguration, ClearCache, TriggerMessage, DataTransfer, GetDiagnostics, UpdateFirmware, SendLocalList, GetLocalListVersion, ReserveNow, CancelReservation, SetChargingProfile, ClearChargingProfile, GetCompositeSchedule.

## Run

```bash
npm install
npm run dashboard
```

| Page | URL |
| --- | --- |
| Fleet (create more simulators) | http://127.0.0.1:18473/fleet |
| Charger HMI | http://127.0.0.1:18473/?id=1 |
| Settings + CSMS commands | http://127.0.0.1:18473/settings?id=1 |

Every charger and its live variables (status, SoC, power, meter, OCPP frames, sessions) are stored in SQLite at `data/byd-ocpp.sqlite`. Create extra Charge Points from the fleet page; each identity connects as `ws://127.0.0.1:18473/ocpp/<ChargePointId>`.

Point **OCPP URL** at any CSMS (`ws://` / `wss://`). Leave empty to use the in-process 1.6 Central System on the same port (`…/ocpp/<ChargePointId>`).

```bash
npm run simulator -- --url ws://YOUR-CSMS/ocpp --id BYD-001 --duration 30min --soc 30
npm test
```

Identity: vendor `BYD`, model `BYD EV Charger 120kW` (CiString20), serial `BYD-DC-XXXXXX`. Heartbeat 30 s, MeterValues 10 s. Frequency is reported **without** a `Hertz` unit (not in 1.6 `UnitOfMeasure`).

## Replace the Render app with MicroOcppSimulator

The Render configuration in `render.yaml` replaces this Node.js BYDCC dashboard with the upstream C++ [MicroOcppSimulator](https://github.com/matth-x/MicroOcppSimulator), using the existing Web Service and persistent disk. It does not create another service. The current BYDCC dashboard and its OCPP server will no longer run at that Render URL. The repository's Dockerfile clones the simulator and its submodules directly, avoiding the upstream Dockerfile's failed `git submodule` command. On first startup, `render-start.sh` deletes the old `/var/data/byd-ocpp.sqlite` database and its SQLite WAL/SHM files. Simulator state is stored separately in `/var/data/microocpp`.

Point the **existing** Render Web Service to this BYDCC repository and deploy the branch containing these changes; do not deploy the upstream simulator repository directly. Keep the existing persistent disk mounted at `/var/data`; do not create a new Web Service. The dashboard is served at the service root on port 8000.

Configure the simulator in its dashboard to connect to the OCPP Central System you want to test. Replacing BYDCC means the old BYDCC server is no longer available at this URL. The simulator's default API credentials are empty, so protect the service from public access unless you configure authentication.

## Deploy on AWS (EC2)

A single **EC2** instance is the right AWS shape (not Lambda, not App Runner). SQLite and OCPP WebSockets need a process that stays up and a disk that is not wiped.

1. Launch **Ubuntu 24.04**, `t3.small` or `t4g.small`, with 20 GB gp3. Security group: **22** (your IP), **80**, **443**. Do not open 18473 to `0.0.0.0/0`.
2. SSH in, install Node **22** and Nginx:

```bash
sudo apt update && sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo mkdir -p /opt/byd-ocpp /var/lib/byd-ocpp
sudo chown ubuntu:ubuntu /opt/byd-ocpp /var/lib/byd-ocpp
```

3. Copy this project into `/opt/byd-ocpp` (`git clone` once the GitHub repo is linked, or `scp -r`). Then:

```bash
cd /opt/byd-ocpp && npm install --omit=dev
sudo cp deploy/byd-ocpp.service /etc/systemd/system/
sudo cp deploy/nginx.conf /etc/nginx/sites-available/byd-ocpp
sudo ln -sf /etc/nginx/sites-available/byd-ocpp /etc/nginx/sites-enabled/byd-ocpp
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload
sudo systemctl enable --now byd-ocpp nginx
sudo nginx -t && sudo systemctl reload nginx
```

4. Optional TLS: point a domain at the Elastic IP, then `sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx`.

Open `http://<elastic-ip>/`, `/fleet`, `/settings`. OCPP is `ws://<elastic-ip>/ocpp/<ChargePointId>` (or `wss://` after certbot).

Skip ECS/EKS/RDS unless you later outgrow SQLite. An Elastic IP keeps the address stable after stop/start.
