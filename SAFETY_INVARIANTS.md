# Gate Controller Safety Invariants

These rules exist to stop regression drift. Read this file before changing the
ESP firmware, Firebase Functions, Firebase rules, Android app, or web app.

## Non-Negotiable Rules

1. There is no executable command queue.
   - Firebase may store audit records.
   - Firebase must expose at most one executable `gate/liveCommand`.
   - If a command cannot be acted on now, it is rejected, expired, or discarded.
   - It must never wait and run later.

2. The web app is a dumb GUI.
   - It may send a command intent.
   - It may display Firebase/ESP state.
   - It must not decide command freshness.
   - It must not write executable timing fields.
   - It must not write `gate/liveCommand` directly.

3. Firebase is the cloud command authority.
   - Firebase Functions stamp server-side command timing.
   - Firebase Functions publish the single executable live command.
   - Firebase Functions write clear telemetry reasons for rejected/expired commands.

4. The ESP is the actuator authority.
   - The ESP decides whether the optocoupler is currently free or active.
   - If the ESP is already pulsing GPIO32, extra commands are discarded.
   - The ESP must not queue or replay commands.

5. Local access must survive cloud trouble.
   - Firebase failures must not reboot the ESP.
   - Firebase failures must not disable the local web page.
   - The `GateController` backup AP remains available as the recovery path.

6. Telemetry must explain failure without moving authority to the browser.
   - Rejection reasons belong in Firebase records/admin diagnostics.
   - The family-facing page should show simple state such as ready, sent, active,
     done, or gate unavailable.

## Forbidden Regression Patterns

Do not add these back without explicitly updating this file and documenting why:

- Browser-authored `requestedAt`, `requestedAtEsp`, `expiresAt`, or `ttlMs`.
- Browser-side command expiry, stale checks, or command timeout authority.
- Client writes directly to `gate/liveCommand`.
- ESP reboot as a Firebase stale recovery method.
- Any list, backlog, FIFO, retry queue, delayed replay, or "run later" command path.
- ESP rejection of a Firebase live command based only on browser/app time.

## Required Changelog Detail

Every safety-affecting patch must say:

- What invariant it protects.
- What failure mode it prevents.
- Which component owns the decision after the change.
- Whether the change was flashed/deployed/tested.
