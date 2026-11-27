**English** · [简体中文](README.zh_CN.md)

# Gongxuan · Interactive Hardware Voting System (Cloud Mobile Host + LAN Dual Mode)

**Gongxuan** is a hardware-software real-time voting system built for live events, classrooms, panels, and meetings. Each participant uses a **FoloToy AI Passport (ESP32-C3, 8 MB flash, three physical buttons)**. A single voter firmware supports both **Cloudflare edge hosting controlled directly from any phone (no laptop required)** and **fully offline LAN computer hosting**.

- Supports 10 registered voters by default and scales up to **1–200 devices**;
- **2–6 choices** per question across **4 voting modes**: Single Choice, Approval (Approve / Oppose / Abstain), Five-Point Rating, and Quiz;
- Batch polls (up to **50 questions** per round), **live question appending** during voting, **countdown deadlines**, and **first-vote locking**;
- Built-in **question library**, **read-only projection stage view**, **archived session history**, and **CSV / high-res PNG export**.

Board support derives from [AI Passport](https://github.com/Eason-Xi/ai-passport) under the MIT license. The initial specification is documented in [LAN_Voting_PRD_v0.1_重建版.md](docs/LAN_Voting_PRD_v0.1_重建版.md) (Simplified Chinese).

---

## Choose Your Hosting Mode

| Dimension | Mode 1: Cloudflare Cloud Host (Recommended · Phone-Only) | Mode 2: Offline LAN Desktop Host (Zero Internet) |
| --- | --- | --- |
| **Host Device** | **Any phone / tablet browser** (no app installation on iOS/Android) | macOS / Windows laptop (native desktop app or browser) |
| **Network Requirement** | Any internet-capable 2.4 GHz Wi-Fi or mobile hotspot; **immune to hotel/corporate AP client isolation** | Local network only; host and voters must be able to reach each other |
| **Phone Screen Lock** | **Unaffected** — Cloudflare Durable Objects keep tallying and enforcing deadlines in the edge | Requires host computer to stay awake |
| **Voter Connection** | Encrypted `wss://` (port 443) via domain + 6-digit join code | UDP 48765 auto-discovery or private IPv4 `ws://` + 6-digit code / 5-min one-tap join |
| **Best For** | Mobile-only hosting, travel/offsite events, restricted Wi-Fi venues | Air-gapped rooms, basements without internet, strict intranet venues |

---

## Mode 1: Cloudflare Cloud Host (Control from Your Phone)

The cloud backend lives in [cloudflare/](cloudflare/README.md) and runs on **Cloudflare Workers + SQLite Durable Objects + WebSocket Hibernation + Alarms**.

### 1. Deploy to Cloudflare

```bash
cd cloudflare
npm install
npm run sync:assets
npx wrangler login
npm run deploy
npx wrangler secret put ADMIN_PASSWORD
```

- **No custom domain required**: works out of the box on your free `https://gongxuan-vote.<subdomain>.workers.dev` URL.
- **Optional custom domain (recommended in mainland China)**: if `*.workers.dev` is unreliable on local Wi-Fi, copy [cloudflare/wrangler.jsonc](cloudflare/wrangler.jsonc) to the git-ignored `cloudflare/wrangler.local.jsonc`, uncomment `routes` with your own Cloudflare-managed subdomain (e.g., `vote.example.com`), and deploy with:
  ```bash
  npm run deploy:custom
  ```
  Cloudflare automatically provisions a TLS certificate trusted by the voter firmware's built-in root certificate bundle.

### 2. Host from Your Phone & Connect Voters

1. **Sign in on your phone**: open your deployed HTTPS URL in Safari/Chrome and enter `ADMIN_PASSWORD` (session stays active for 30 days; mobile screens get a bottom quick-nav bar for Editor / Live / Devices / History).
2. **Note credentials**: check the **6-digit join code** at the top and copy the `wss://<your-host>/ws` address in the Devices panel.
3. **Provision each AI Passport voter**:
   - Scan the QR code on the voter screen to join its hotspot and open the setup portal (`http://192.168.4.1/`).
   - Pick the venue's 2.4 GHz Wi-Fi and enter its password.
   - Expand **"Cloud host or manual address"** and enter your hostname (e.g., `vote.example.com` — normalized automatically to `wss://vote.example.com/ws`).
   - Enter the 6-digit join code and submit. The voter verifies the connection, saves settings in NVS, and reboots straight into your cloud room.
4. **Read-only stage projection**: tap **"Copy read-only stage link"** in the Devices panel and open it on any venue laptop/projector browser — no admin login needed, and host control buttons are hidden.

---

## Mode 2: Offline LAN Desktop Host (No Internet Required)

Download packaged desktop installers from [GitHub Releases](https://github.com/Eason-Xi/ai-passport-lan-voting/releases/latest) or run from source:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r host/requirements-lock.txt
.venv/bin/python host/server.py
```

Open `http://127.0.0.1:8765` on the host computer. Leave the server address blank in the voter setup portal so voters auto-discover the LAN host over UDP 48765.

---

## Running an Event

1. **Question Library**: pre-save reusable questions before the event, edit with optimistic revision checks, or save drafts straight to the library.
2. **Device Capacity & Seat Aliases**: adjust the capacity limit (`1–200`) and label registered devices by seat or judge name.
3. **Launch Polls (4 Modes, up to 50 Questions)**: combine Single Choice, Approval, Five-Point Rating, and Quiz in one batch, and append additional questions live while voting is open.
4. **Deadlines & Publication**: set manual closing, preset timers, custom durations, or an exact Beijing time. Press `F` or open the Stage view for projection, keep live counts masked while voting if desired, then close and publish results to every voter screen.
5. **History & Export**: every completed round is archived automatically with replay, question reuse, UTF-8 BOM CSV download, and high-res PNG export.

---

## Firmware Build, Flash & Verification (ESP32-C3)

Firmware on this branch adds `wss://` TLS support (using ESP-IDF's `CMN` certificate bundle covering Google Trust Services, Let's Encrypt ISRG, and DigiCert, plus mbedTLS dynamic buffers tuned for PSRAM-less ESP32-C3) while preserving full LAN `ws://` compatibility.

### Flash to AI Passport (ESP-IDF 5.5.3)

Replace `PORT` with your serial port (e.g., `/dev/cu.usbmodem101` or `COM5`):

```bash
# Clean full flash at 0x0 (may reset existing NVS Wi-Fi settings)
python -m esptool --chip esp32c3 -p PORT -b 460800 write_flash 0x0 build/FoloToy-AI-Passport-full.bin

# App-only update at 0x10000 (preserves NVS settings; requires this project's 8 MB partition table)
python -m esptool --chip esp32c3 -p PORT -b 460800 write_flash 0x10000 build/firmware/<SHA256>/FoloToy-AI-Passport.bin
```

### Verification Suite

```bash
# 1. Cloudflare Worker typecheck, workerd Vitest suite, and dry-run bundle
cd cloudflare
npm run typecheck
npm test
npm run deploy:dry-run

# 2. Full repository gate (font coverage, Python host tests, C protocol/model ASan+UBSan tests, ESP-IDF 5.5.3 build & verification)
./tools/validate.sh

# 3. Desktop host unit tests & LVGL preview rendering
.venv/bin/python tests/test_desktop_host.py
python3 tools/render_vote_preview.py
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup portal does not pop up after scanning QR | Confirm the phone joined `Vote-xxxxxx`, scan the second QR code, or visit `http://192.168.4.1/`. Keep the connection if the phone warns there is no internet. |
| "Host not found" after entering join code | For Cloudflare mode, expand the host address field and enter your domain (leaving it blank triggers LAN broadcast discovery). |
| Cannot reach `*.workers.dev` on local Wi-Fi | Bind your own Cloudflare-managed custom domain via `wrangler.local.jsonc` and `npm run deploy:custom`. |
| Voters cannot find LAN computer | Ensure 2.4 GHz Wi-Fi without AP client isolation; UDP 48765 (discovery) and TCP 8765 (WebSocket) must be reachable. |
| Reset forgotten cloud admin password | Run `cd cloudflare && npx wrangler secret put ADMIN_PASSWORD` to set a new password without losing data. |

## License

See [LICENSE](LICENSE).
