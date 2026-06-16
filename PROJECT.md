# Gate Controller Project Context

This workspace contains several projects. For the electric gate controller, use these paths.

## Workspace

Workspace root:

`C:\Users\rkiwi\OneDrive\Documents\New project`

Gate controller repo root:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller`

## Gate Controller Paths

ESP32 firmware and local diagnostic page:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\esp32-com3`

Main ESP firmware:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\esp32-com3\src\main.cpp`

PlatformIO config:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\esp32-com3\platformio.ini`

Firebase web app, hosting, and database rules:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\gate-cloud`

Firebase web app JS:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\gate-cloud\public\app.js`

Firebase Realtime Database rules:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\gate-cloud\database.rules.json`

Camera relay setup:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\camera-relay`

Android app wrapper and widget:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\gate-android`

Android debug APK:

`C:\Users\rkiwi\OneDrive\Documents\New project\gate-controller\gate-android\app\build\outputs\apk\debug\app-debug.apk`

Android toolchain is installed on D drive, not C:

- JDK 17: `D:\GateAndroidTools\jdk-17`
- Android SDK: `D:\GateAndroidTools\android-sdk`
- Gradle: `D:\GateAndroidTools\gradle-8.10.2`
- Gradle user home/cache: `D:\GateAndroidTools\gradle-user-home`
- Emulator AVD home: `D:\AndroidAvd`
- AVD name: `GatePixelApi35_D`

## Live Endpoints

Local ESP direct page:

`http://192.168.0.228/`

ESP backup AP:

- SSID: `GateController`
- Password: stored in `esp32-com3/src/secrets.h`
- AP page: `http://192.168.4.1/`

Firebase hosted page:

`https://gate-controller-1b092.web.app/`

Firebase project:

`gate-controller-1b092`

Realtime Database:

`https://gate-controller-1b092-default-rtdb.asia-southeast1.firebasedatabase.app`

Gate camera:

- DVR local RTSP works on channel 7.
- Browser RTSP is not supported; public web camera preview uses a MediaMTX HLS relay.
- Relay setup files are in `camera-relay/`.
- Web HLS URL is configured in `gate-cloud/public/camera-config.js`.
- Do not put the raw DVR RTSP URL into frontend code.

## Hardware Map

Gate trigger:

- GPIO32 drives the PC817/817C optocoupler input.
- HIGH = activate gate trigger.
- LOW = release gate trigger.
- GPIO34 is input-only and must never be used as an output.

Detector inputs:

- GPIO34 = OPEN detector raw ADC input.
- GPIO35 = CLOSE detector raw ADC input.

Detector logic is still being tuned. Do not assume fixed HIGH/LOW meaning unless the current firmware says so.

## Current Safety Model

The ESP is the final authority. The web app and Firebase do not queue commands.

Required command behavior:

- The web app is GUI-only and must not write command time, expiry, TTL, logs, records, or executable live commands.
- The web app writes intent only to `gate/commandRequests/{id}`.
- Firebase Functions stamps server time and publishes `gate/liveCommand`.
- Firebase command slot is `gate/liveCommand`.
- There must be no executable command queue.
- One command equals one immediate action.
- Commands must include `requestedAt` and `expiresAt`.
- Web commands expire after about `2000 ms`.
- ESP rejects stale commands.
- ESP rejects commands created during the previous pulse.
- ESP does not poll cloud commands while the pulse output is active.
- Anything sent during an active pulse must be discarded, not stored for later.
- Rapid button spam is acceptable only because stale/busy commands are ignored.
- Delayed surprise pulses are unacceptable.

## Current Firmware Behavior

The ESP firmware keeps the local page and backup AP in place, and adds Firebase polling as a second layer.

Local direct controls must not be removed while working on cloud control.

Cloud polling:

- ESP signs in as `gate-device@gate-controller.local`.
- ESP writes heartbeat to `gate/device`.
- ESP polls `gate/liveCommand` while idle.
- ESP marks accepted commands `active`, then `done` or `failed`.

## Useful Commands

Build ESP firmware:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run
```

OTA upload to gate ESP:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e esp32dev_ota --target upload --upload-port 192.168.0.228
```

Check local ESP status:

```powershell
Invoke-RestMethod -Uri 'http://192.168.0.228/status' -TimeoutSec 5
```

Deploy Firebase hosting and database rules:

```powershell
npx firebase-tools deploy --only hosting,database --project gate-controller-1b092
```

Check Firebase device heartbeat:

```powershell
npx firebase-tools database:get /gate/device --project gate-controller-1b092
```

Build Android debug APK:

```powershell
$env:JAVA_HOME='D:\GateAndroidTools\jdk-17'
$env:ANDROID_HOME='D:\GateAndroidTools\android-sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:ANDROID_AVD_HOME='D:\AndroidAvd'
$env:GRADLE_USER_HOME='D:\GateAndroidTools\gradle-user-home'
$env:Path="$env:JAVA_HOME\bin;D:\GateAndroidTools\gradle-8.10.2\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
gradle assembleDebug
```

Start Android emulator from D drive:

```powershell
$env:ANDROID_HOME='D:\GateAndroidTools\android-sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:ANDROID_AVD_HOME='D:\AndroidAvd'
$env:Path="$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
emulator -avd GatePixelApi35_D -no-snapshot -gpu swiftshader_indirect
```

## Important Operating Rules

- Do not create extra Firebase projects, hosting sites, or orphan pages.
- Do not create new Firebase Auth device users unless explicitly asked.
- Do not remove local ESP controls while working on cloud control.
- Do not send a live gate pulse unless explicitly asked.
- Do not flash the ESP unless the change has been compiled and the user expects upload.
- Keep changes small and targeted.
