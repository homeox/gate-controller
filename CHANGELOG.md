# Changelog

All notable changes to this project are documented here.

The project uses Semantic Versioning for source, firmware, web, and cloud function releases.

## [0.3.2+20260616] - 2026-06-16

### Fixed

- Moved the camera preview below the gate button and capped it to a small thumbnail-sized box.
- Bumped the web version so browsers reload the corrected layout.

## [0.3.1+20260616] - 2026-06-16

### Fixed

- Removed browser-authored gate command timing, expiry, TTL, and executable `gate/liveCommand` writes.
- Added Firebase Function handling for `gate/commandRequests/{id}` so Firebase is the time authority.
- Blocked normal users from writing command logs, command records, or `gate/liveCommand` directly in database rules.

### Changed

- Shrunk the camera panel into a thumbnail-sized preview.

## [0.3.0+20260616] - 2026-06-16

### Added

- Added a Firebase web camera preview panel that loads an HLS relay with hls.js.
- Added `camera-config.js` so the browser only sees the MediaMTX HLS URL, not the raw DVR RTSP URL.
- Added no-Docker MediaMTX relay setup files for a Google Compute Engine VM.

### Changed

- Moved user-facing access stats and logs behind an `Activity and diagnostics` fold so the main gate page is cleaner.

## [0.2.1+20260615] - 2026-06-15

### Fixed

- Restored ESP32 millisecond epoch timestamps for cloud telemetry and stale-command checks.
- Prevented delayed Firebase `active` callbacks from downgrading already-final command records.
- Confirmed Firebase rules allow the ESP device account to acknowledge and complete existing live commands.

### Changed

- Added explicit project version tracking across ESP firmware, web app, and cloud functions.
- Moved PlatformIO build output to `D:/GateControllerBuild/platformio` to avoid generated build junk in OneDrive.

## [0.2.0+20260614] - 2026-06-14

### Fixed

- Stopped web and Android clients from rounding command timestamps down to whole seconds.
- Moved command freshness checks to Firebase/server-received timestamps.
- Cleaned stale pending audit records and confirmed the executable live command slot was empty.

### Added

- Initial GitHub handoff with ESP32 firmware, Firebase web/functions/rules, Android source, and project README.
