# Changelog

All notable changes to this project are documented here.

The project uses Semantic Versioning for source, firmware, web, and cloud function releases.

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
