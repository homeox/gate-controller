# Gate Controller

ESP32 + Firebase + Android gate controller for a TOPENS-style sliding gate controller.

The important design rule is simple: **there is no executable command queue**. The cloud holds one live command slot, and the ESP32 is the authority. If the ESP is idle and sees a fresh command, it pulses the gate. If it is already pulsing, the command is discarded. Old commands are expired, never replayed later.

## Repository Layout

- `esp32-com3/` - ESP32 firmware, local diagnostic page, backup AP, OTA, Firebase polling.
- `gate-cloud/` - Firebase Hosting web app, Realtime Database rules, and Cloud Functions.
- `gate-android/` - Android one-tap gate app used for sideload testing.
- `PROJECT.md` - working handoff notes with live paths, hardware map, commands, and safety rules.

## Current Live System

- Firebase project: `gate-controller-1b092`
- Hosting: `https://gate-controller-1b092.web.app/`
- Realtime Database: `gate-controller-1b092-default-rtdb` in `asia-southeast1`
- ESP local page: usually `http://192.168.0.228/` or the static lease address in the router.
- ESP backup AP: SSID `GateController`, page `http://192.168.4.1/`

Do not commit real Wi-Fi passwords, Firebase device passwords, or household login credentials. This repo uses examples for those.

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

The ESP:

1. Polls `gate/liveCommand` while idle.
2. Accepts only `status: "pending"`.
3. Rejects stale timestamps.
4. Rejects commands created during the previous pulse.
5. Rejects while the relay/optocoupler is active.
6. Marks accepted commands `active`, then `done` or `failed`.

Spam clicking is allowed at the UI level. The ESP and cloud cleanup must cull spam rather than queue it.

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

Build:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e esp32dev_ota
```

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

The app timestamp regression was fixed on 2026-06-14:

- Web and Android stopped rounding `requestedAtEsp` down to the nearest second.
- Web now writes Firebase server timestamps for `requestedAt`/`requestedAtEsp`.
- Firebase Functions derive expiry from server-received time plus `ttlMs`.
- ESP firmware derives expiry from `requestedAt + ttlMs`.
- Old stale `pending` audit rows were closed as `expired`; `gate/liveCommand` was confirmed `null`.

This fix matters because the previous rounded timestamp could make a fresh command look up to 999ms older than it really was.
