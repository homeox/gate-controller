# Gate Cloud

Firebase-hosted gate controller page with:

- Firebase Auth login
- user enable/disable and expiry
- admin view
- single live gate command slot for the ESP32 to poll
- admin-tunable ESP timing config
- command records and event traces
- access logs

## Firebase Setup

1. Create a Firebase project.
2. Add a Web app and copy the `firebaseConfig`.
3. Enable Authentication -> Email/Password.
4. Create Realtime Database.
5. Put your Firebase web config into `public/firebase-config.js`.
6. Deploy `database.rules.json` to Realtime Database rules.
7. Deploy `public` to Firebase Hosting.

## First Admin

After your first login, copy your Firebase Auth UID from the Firebase console and create:

```json
{
  "users": {
    "YOUR_UID": {
      "name": "Admin",
      "email": "you@example.com",
      "role": "admin",
      "enabled": true,
      "expiresAt": 4102444800000
    }
  }
}
```

`4102444800000` is 2100-01-01 in milliseconds.

## ESP Polling Model

The ESP32 polls:

`/gate/liveCommand`

This is not a queue. There is only one live command slot. User interfaces may
write every tap immediately. The ESP32 is the authority: it accepts one fresh
command when it is ready, and discards stale or relay-busy commands instead of
storing them for later.

When the ESP sees a pending command, it verifies it is not expired, pulses the
gate trigger output, then writes:

- `/gate/liveCommand/status = "active"` when it takes the command
- `/gate/liveCommand/status = "done"` or `"failed"` when released
- `/gate/liveCommand/doneAt = <ESP timestamp>`
- `/gate/commandRecords/{commandId}` summary fields
- `/gate/commandEvents/{commandId}/{eventId}` trace events
- `/gate/device/lastSeen = <now>`

The hosted page is intentionally dumb: it writes one audited command into the
single `/gate/liveCommand` slot and listens for Firebase state/result updates.
It does not own a heartbeat or sync lease. The ESP polls `/gate/liveCommand`,
reports health under `/gate/device` and `/gate/state`, and old `/gate/fast` and
`/gate/sessions` paths are not executable paths.
