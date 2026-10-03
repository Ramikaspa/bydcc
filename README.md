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

## Deploy on Render

Yes — this app can run as a Render **Web Service**. It is one Node process (HMI + SQLite + OCPP WebSocket). Render injects `PORT`; the dashboard already binds that.

**Do not use the free instance** for this. Sleep/spin-down drops OCPP sockets, and the free filesystem is wiped on every deploy so the SQLite fleet would vanish. Use a **paid** web service and attach a **persistent disk** (see `render.yaml`).

1. Push this repo to GitHub/GitLab and connect it in [Render](https://render.com).
2. New **Web Service** → this repo. Build `npm install`, start `npm run dashboard`, Node **22**.
3. Attach a 1 GB disk at `/var/data` and set `OCPP_DB=/var/data/byd-ocpp.sqlite`.
4. After deploy, open `https://<your-service>.onrender.com/`, `/fleet`, and `/settings`. OCPP is `wss://<your-service>.onrender.com/ocpp/<ChargePointId>`.

Blueprint: commit `render.yaml` and choose **Apply** from the Render dashboard. WebSockets work on Render without extra nginx config.

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
