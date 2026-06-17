# Gate Controller

ESP32 + Firebase + Android gate controller for a TOPENS-style sliding gate controller.

The important design rule is simple: **there is no executable command queue**. Firebase holds one live command slot, and the ESP32 is the physical actuator authority. If the ESP is idle and sees a Firebase-published pending command, it pulses the gate. If it is already pulsing, the command is discarded. Old commands are expired by Firebase cleanup, never replayed later.

## Repository Layout

- `esp32-com3/` - ESP32 firmware, local diagnostic page, backup AP, OTA, Firebase polling.
- `gate-cloud/` - Firebase Hosting web app, Realtime Database rules, and Cloud Functions.
- `camera-relay/` - no-Docker MediaMTX relay notes and config for the gate camera RTSP-to-HLS bridge.
- `gate-android/` - Android one-tap gate app used for sideload testing.
- `PROJECT.md` - working handoff notes with live paths, hardware map, commands, and safety rules.
- `SAFETY_INVARIANTS.md` - non-negotiable command authority and no-queue rules.

## Current Live System

- Project version: `0.3.7+20260617`
- Firebase project: `gate-controller-1b092`
- Hosting: `https://gate-controller-1b092.web.app/`
- Realtime Database: `gate-controller-1b092-default-rtdb` in `asia-southeast1`
- ESP local page: usually `http://192.168.0.228/` or the static lease address in the router.
- ESP backup AP: SSID `GateController`, page `http://192.168.4.1/`. This AP is intentionally kept on while house Wi-Fi is connected so local recovery remains available.
- Gate camera relay: MediaMTX HLS URL is configured in `gate-cloud/public/camera-config.js` after the VM exists.

Do not commit real Wi-Fi passwords, Firebase device passwords, or household login credentials. This repo uses examples for those.

## Gate Camera Preview

Browsers cannot play the DVR RTSP feed directly, so the public web app expects a browser-safe HLS feed from MediaMTX:

```text
DVR RTSP -> MediaMTX VM -> HLS -> Firebase web app
```

The frontend camera config lives in:

```text
gate-cloud/public/camera-config.js
```

Set `hlsUrl` to the MediaMTX URL once the relay VM is running:

```text
https://YOUR_MEDIAMTX_DOMAIN/gate/index.m3u8
```

Do not put the raw RTSP URL into the web app.

## Hardware Map

### Gate Trigger

- `GPIO32` drives the PC817/817C optocoupler input.
- `HIGH` = press/activate gate trigger.
- `LOW` = release gate trigger.
- `GPIO34` is input-only and must never be used as an output.

### Detector Inputs

- `GPIO34` = OPEN detector raw ADC feed.
- `GPIO35` = CLOSE detector raw ADC feed.

Detector interpretation is tuning-based. Do not assume a fixed digital HIGH/LOW meaning without checking the current firmware and local diagnostic page.

## Command Contract

Cloud command path:

```text
gate/liveCommand
```

Command shape:

```json
{
  "id": "firebase-push-id",
  "type": "pulse",
  "status": "pending",
  "sessionId": "web_or_android_session",
  "requestedBy": "firebase-auth-uid",
  "requestedByName": "Display Name",
  "requestedAt": 1781428000000,
  "requestedAtEsp": 1781428000000,
  "requestedAtClient": 1781427999750,
  "ttlMs": 3000,
  "expiresAt": 1781428003000
}
```

`requestedAt` and `requestedAtEsp` must be Firebase/server-received time, not phone/browser time. The app may record `requestedAtClient` for diagnostics only.

The browser is GUI-only for gate commands. It writes a command intent to:

```text
gate/commandRequests/{id}
```

The browser must not write `requestedAt`, `requestedAtEsp`, `expiresAt`, `ttlMs`, or `gate/liveCommand`.

Firebase Functions stamps server time, mirrors the audit logs, and publishes the executable command to:

```text
gate/liveCommand
```

The ESP:

1. Polls `gate/liveCommand` while idle.
2. Accepts only `status: "pending"`.
3. Rejects malformed commands.
4. Rejects commands created during the previous pulse.
5. Rejects while the relay/optocoupler is active.
6. Marks accepted commands `active`, then `done` or `failed`.

The ESP must not reject Firebase-published commands based only on local clock age. Firebase owns cloud command timing and expiry.

Spam clicking is allowed at the UI level. The ESP and cloud cleanup must cull spam rather than queue it.

Firebase/cloud failures must not reboot the ESP or remove local controls. The local web server and backup AP are the survival layer.

## Firebase

Before deploy, create `gate-cloud/public/firebase-config.js` from `firebase-config.example.js`.

Deploy hosting, database rules, and functions:

```powershell
cd gate-cloud
npx firebase-tools deploy --only hosting,database,functions --project gate-controller-1b092
```

Read ESP heartbeat:

```powershell
npx firebase-tools database:get /gate/device --project gate-controller-1b092
```

Read live command slot:

```powershell
npx firebase-tools database:get /gate/liveCommand --project gate-controller-1b092
```

## ESP32 Firmware

Create `esp32-com3/src/secrets.h` from `secrets.example.h`.

Do not delete `secrets.h` after a real build/flash. It is ignored by git because
it contains live Wi-Fi/Firebase credentials, but it must remain on the workstation
for OTA/USB firmware work.

Build:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e esp32dev_ota
```

PlatformIO build output is configured to `D:/GateControllerBuild/platformio` so generated firmware build files do not fill OneDrive.

OTA upload:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e esp32dev_ota --target upload --upload-port 192.168.0.228
```

Local diagnostic page:

```text
http://<esp-ip>/
```

Backup AP page:

```text
http://192.168.4.1/
```

## Android

The Android app is a minimal one-tap client. It writes the same single live command slot as the web app. It must not implement a queue or delayed retry.

Current local toolchain notes from this workstation:

- JDK 17: `D:\GateAndroidTools\jdk-17`
- Android SDK: `D:\GateAndroidTools\android-sdk`
- Gradle: `D:\GateAndroidTools\gradle-8.10.2`
- Gradle cache: `D:\GateAndroidTools\gradle-user-home`

Build example:

```powershell
$env:JAVA_HOME='D:\GateAndroidTools\jdk-17'
$env:ANDROID_HOME='D:\GateAndroidTools\android-sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:GRADLE_USER_HOME='D:\GateAndroidTools\gradle-user-home'
$env:Path="$env:JAVA_HOME\bin;D:\GateAndroidTools\gradle-8.10.2\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
cd gate-android
gradle assembleDebug
```

## Safety Rules For Future Work

- Do not send a live gate pulse unless explicitly requested.
- Do not add app-side lockouts that block panic clicking.
- Do not add a command queue.
- Do not replay stale commands.
- Do not remove local ESP direct controls while cloud work is happening.
- Do not flash the ESP until the firmware builds.
- Do not deploy Firebase changes without checking rules/function syntax.
- Keep changes small and traceable.

## Recent Critical Fix

The command authority regression was fixed on 2026-06-17:

- Web and Android must not author executable timing fields.
- Firebase Functions derive command timing from server-side processing and publish the single live slot.
- ESP firmware no longer rejects Firebase-published commands based only on local clock age.
- Old pending telemetry remains audit history only; `gate/liveCommand` is the only executable command slot.
