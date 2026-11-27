**English** · [简体中文](README.zh_CN.md)

# LAN voting

One computer hosts a poll for up to ten registered AI Passport voters. Each question has two to six options. A device locks its first confirmed choice for that question. The host sees live statistics and publishes the final result to all voters. The session runs on the local network.

This repository contains the 0.3.0 voter firmware and host console. The voter uses an ESP32-C3, 8 MB of flash and three buttons. Board support comes from [AI Passport](https://github.com/Eason-Xi/ai-passport) under its original MIT license. The [project brief](docs/LAN_Voting_PRD_v0.1_重建版.md) is available in Simplified Chinese.

## Run a session

1. Install the host software as described below, then use the [host launcher](host/start.command) and open the [local console](http://127.0.0.1:8765). Find its six-digit enrollment code. When upgrading a running host, restart it with the same database.
2. Scan the QR code on the voter with a phone camera and join its hotspot. On supported phones the setup portal opens automatically. If it stays closed, scan the second code displayed after the phone joins, or open the [setup page](http://192.168.4.1/). UP/DOWN switches codes. The first screen also shows the hotspot name and password.
3. Select the venue's 2.4 GHz Wi-Fi and enter its password and the enrollment code. Open networks hide the password field. Hidden networks allow manual entry. The voter finds the host automatically. If several hosts answer, tap the public identifier shown on the intended console. The device saves its settings and restarts after receiving a valid host snapshot. Wi-Fi, discovery and enrollment errors can be retried on the same page.
4. Enter a question and options. Choose manual closing (the default), a duration of 30 seconds, 1 minute or 5 minutes, or a date and time in Beijing, then start voting. On each voter, UP/DOWN selects an option, OK opens confirmation, and the next OK submits. Either direction cancels confirmation. The success screen means the computer recorded the vote.
5. Closing voting stops new submissions while keeping results private. Publishing from either the open or closed phase sends the final counts and percentages to voters. Use UP/DOWN on the results page to scroll long option labels. Start a new question after publishing the current result.

The computer can use Ethernet or Wi-Fi. Automatic discovery uses UDP 48765 on the same IPv4 subnet. Voting uses the host TCP port (8765 by default). Discovery carries a random challenge, a public host identifier and a port. A paired voter can find the same host after its IP address or port changes. Hosts using different databases have different identities. Hold OK and confirm reconfiguration to change hosts.

If broadcasts are filtered or the host runs older software, expand manual host settings and enter a private IPv4 address such as `192.168.1.20` or `192.168.1.20:9876`. The console lists the full addresses under participating devices. Use a network that allows clients to communicate. Rejoin the device hotspot if the phone disconnects during a Wi-Fi channel change.

## Timed voting

Durations run from the time the host starts the poll. A specific date and time uses Beijing time (UTC+8) regardless of the browser's time zone. While voting is open, expand the deadline editor in the live results panel to reschedule or return to manual closing. A replacement duration starts when the host saves the change. The host may also close early.

The console displays the scheduled time and a countdown. Version 0.3 voters show the remaining time in their upper left corner, using the host snapshot and the device's monotonic clock. The host stops accepting new votes at the deadline and notifies connected voters even when the console page is closed. Closed questions stay closed. Publishing results remains a separate host action.

During host sleep or downtime, submissions cannot be recorded. Restarting with the same database restores future deadlines and closes overdue polls immediately. Questions migrated from earlier versions keep manual closing. Older voters receive the regular closed snapshot from the updated host. Install the new voter firmware to see the countdown on its display.

## Desktop client and local web console

### Option 1: Standalone desktop client (no Python required on target machines)

[host/desktop.py](host/desktop.py) and [desktop/gongxuan.spec](desktop/gongxuan.spec) package the same host service and upgraded console UI (with full-screen presentation mode via `F`, live font-coverage check, option presets, poll history reuse, device aliases, and PNG result export) into native desktop apps:

- **macOS**: Run `bash desktop/build_mac.sh` to build `dist/共选主持台.app` and `dist/共选主持台-macOS-<arch>.zip`. Data is stored in `~/Library/Application Support/GongxuanVoting/votes.sqlite3`.
- **Windows**: Run [desktop/build_windows.bat](desktop/build_windows.bat) on Windows to build a single-file `dist\共选主持台.exe` powered by Edge WebView2. Data is stored in `%APPDATA%\GongxuanVoting\votes.sqlite3`.
- **GitHub Actions**: Trigger [build-desktop.yml](.github/workflows/build-desktop.yml) manually or via a `v*` tag to build both macOS and Windows binaries.

### Option 2: Run from source

Clone this repository and install Python 3.12. Double-click [host/start.command](host/start.command) on macOS or [host/start.bat](host/start.bat) on Windows, or run from the repository root:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r host/requirements-lock.txt
.venv/bin/python host/server.py
```

On Windows, create the environment with `py -3.12 -m venv .venv` and use `.venv\Scripts\python.exe` for the following commands. Use `--port` for another port or `--data` for a different event database. Administrative access is local to the host computer.

## Counting and recovery

| Situation | Behavior |
| --- | --- |
| Disconnection or power loss during submission | The voter writes its poll ID and choice to NVS before sending. After reconnecting, it reads the host snapshot and retries the same choice only for the same open question with no accepted vote. |
| Repeated submissions | A unique key on poll ID and device ID counts the first accepted vote once. An identical retry receives the original record. A change of choice is rejected. |
| A pending vote reaches a closed poll | The host checks time when the write transaction acquires its lock. New votes at or after the deadline are rejected. An identical retry of a recorded vote receives its original confirmation. |
| Host restarts | Reuse the same database to restore the current question, phase, code, and votes. Voters synchronize on reconnect. |
| Enrollment is full | Forget an offline registration to free a slot. Existing votes remain recorded and still lock the same device ID. |
| Zero votes or ties | Empty results show 0%. Tied counts are preserved. The browser shows one decimal place and the device rounds to the nearest whole percent. |

The default SQLite database is `host/data/votes.sqlite3`. Stop the host before copying the database or use the SQLite backup API. The shared enrollment code and factory Wi-Fi MAC identify participants on a trusted LAN. This pairing scheme does not authenticate adversarial devices. Voters store Wi-Fi credentials locally in NVS.

## Display and text

A question can contain 60 characters and each option 24. The host and firmware share a 6,994-character inventory with 6,763 GB2312 Han characters, printable ASCII and common punctuation. The host identifies unsupported characters before a poll starts. Long questions and selected options scroll. The battery indicator shows a placeholder when unavailable. After 30 seconds of inactivity, or 60 seconds on the network setup page, the display dims. The first button press while dimmed wakes the display.

The 18 px, 4 bpp font uses a Source Han Sans SC subset. The source, license and manifest are in the [font asset directory](assets/fonts/). Regeneration requires `lv_font_conv@1.5.3` and `fonttools==4.61.1`.

```sh
python3 tools/gen_vote_font.py generate --font assets/fonts/SourceHanSansSC-Regular.otf --converter /path/to/lv_font_conv.js
python3 tools/gen_vote_font.py check
```

## Validation and flashing

Install the host dependencies above, activate ESP-IDF 5.5.3 and run these commands from the repository root.

```sh
./tools/validate.sh
python3 tools/render_vote_preview.py
```

`./tools/validate.sh` checks voting and host discovery, including ten clients, deadlines, reconnection and database migration. It also checks font coverage, tests the firmware verification tools, then builds with an isolated configuration and verifies the merged image. Use `./tools/validate.sh --firmware` for a firmware-only build. The preview compiles the actual LVGL UI and font and writes screenshots to `build/vote-preview/`. On a machine with Playwright and Chrome, `node tools/test_vote_browser.cjs` exercises the desktop and mobile host views and the setup page. Camera scanning and the operating-system captive portal require physical checks.

The ESP32-C3 uses the existing BSP and 8 MB partition layout. Flash **`build/FoloToy-AI-Passport-full.bin` at 0x0**. Its matching ELF, MAP, component images and SHA-256 manifest are in `build/firmware/<full-image-sha256>/`. Verify with `python3 tools/archive_firmware.py verify <directory>`.

Versions 0.1, 0.2 and 0.3 share the partition and NVS layout. To retain settings when upgrading this layout, the matching archived application image can be written at its application offset of 0x10000. Existing fixed endpoints continue to work, and reprovisioning enables discovery by host identity. A merged write at 0x0 may clear NVS. Obtain approval for this image before flashing. On hardware, verify boot, all three buttons, Chinese text, battery, provisioning, countdown and reconnection on one voter. Conduct a three-voter session before testing ten physical units and longer operation. Serial diagnostics report free heap, largest free block and main task stack headroom.
