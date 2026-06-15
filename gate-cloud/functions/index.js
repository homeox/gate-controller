const admin = require('firebase-admin');
const functions = require('firebase-functions/v1');

admin.initializeApp();

const db = admin.database();
const COMMAND_TIMEOUT_MS = 3000;
const LIVE_SLOT_RETIRE_MS = 10000;
const INSTANCE = 'gate-controller-1b092-default-rtdb';
const FUNCTION_VERSION = '0.2.1+20260615';

function now() {
  return Date.now();
}

function eventKey(at, event) {
  return `${at}_firebase_${event}`;
}

function commandTtl(command) {
  const ttl = Number(command.ttlMs || COMMAND_TIMEOUT_MS);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > COMMAND_TIMEOUT_MS) {
    return COMMAND_TIMEOUT_MS;
  }
  return ttl;
}

function commandRequestedAt(command) {
  return Number(command.requestedAt || command.requestedAtEsp || command.requestedAtClient || 0);
}

function commandExpiresAt(command) {
  const requestedAt = commandRequestedAt(command);
  return requestedAt ? requestedAt + commandTtl(command) : 0;
}

function commandEvent(command, event, reason, at = now()) {
  return {
    commandId: command.id,
    event,
    at,
    actor: 'firebase',
    sessionId: command.sessionId || '',
    status: command.status || '',
    reason,
    functionVersion: FUNCTION_VERSION
  };
}

function commandRecordPatch(command, patch) {
  return {
    id: command.id,
    type: command.type || 'pulse',
    requestedBy: command.requestedBy || '',
    requestedByName: command.requestedByName || '',
    sessionId: command.sessionId || '',
    requestedAt: commandRequestedAt(command),
    requestedAtEsp: commandRequestedAt(command),
    requestedAtClient: Number(command.requestedAtClient || 0),
    ttlMs: commandTtl(command),
    expiresAt: commandExpiresAt(command),
    source: command.source || 'web',
    cloudFunctionVersion: FUNCTION_VERSION,
    ...patch
  };
}

function statusRank(status) {
  if (status === 'done' || status === 'failed' || status === 'expired') return 3;
  if (status === 'active') return 2;
  if (status === 'pending') return 1;
  return 0;
}

async function writeEvent(command, event, reason, at = now()) {
  if (!command || !command.id) return;
  await db.ref(`gate/commandEvents/${command.id}/${eventKey(at, event)}`).set(
    commandEvent(command, event, reason, at)
  );
}

async function patchRecord(command, patch) {
  if (!command || !command.id) return;
  const ref = db.ref(`gate/commandRecords/${command.id}`);
  if (patch.status) {
    const snap = await ref.get();
    const existing = snap.exists() ? snap.val() : null;
    if (existing && statusRank(existing.status) > statusRank(patch.status)) {
      return;
    }
  }
  await ref.update(commandRecordPatch(command, patch));
}

async function expireIfStillPending(id, reason) {
  const liveRef = db.ref('gate/liveCommand');
  const snap = await liveRef.get();
  if (!snap.exists()) return;

  const command = snap.val();
  if (!command || (id && command.id !== id) || command.status !== 'pending') return;

  const at = now();
  const expiresAt = commandExpiresAt(command);
  if (expiresAt && at < expiresAt + 250) return;

  const updates = {
    'status': 'expired',
    'doneAt': at,
    'closedAt': at,
    'resultReason': reason
  };
  await liveRef.update(updates);
  await patchRecord(command, {
    status: 'expired',
    doneAt: at,
    closedAt: at,
    resultReason: reason,
    firebaseExpiredAt: at
  });
  await writeEvent(command, 'expired_unclaimed', reason, at);
}

async function retireOldLiveSlot() {
  const liveRef = db.ref('gate/liveCommand');
  const snap = await liveRef.get();
  if (!snap.exists()) return;

  const command = snap.val();
  if (!command || !command.id) {
    await liveRef.remove();
    return;
  }

  const status = command.status || '';
  const ageFromRequest = now() - commandRequestedAt(command);
  const ageFromClose = now() - Number(command.doneAt || command.closedAt || 0);
  const finalStatus = /^(done|failed|expired)$/.test(status);

  if ((finalStatus && ageFromClose >= 1500) || ageFromRequest >= LIVE_SLOT_RETIRE_MS) {
    await writeEvent(command, 'live_slot_retired', finalStatus ? 'final_status_retired' : 'stale_slot_retired');
    await liveRef.remove();
  }
}

exports.onLiveCommandWritten = functions
  .runWith({ maxInstances: 2, timeoutSeconds: 30, memory: '256MB' })
  .region('asia-southeast1')
  .database.instance(INSTANCE)
  .ref('/gate/liveCommand')
  .onWrite(async (change) => {
    if (!change.after.exists()) return null;

    const command = change.after.val();
    if (!command || !command.id) {
      await change.after.ref.remove();
      return null;
    }

    const at = now();
    const status = command.status || '';

    if (status === 'pending') {
      const latestSnap = await change.after.ref.get();
      if (!latestSnap.exists()) return null;

      const latestCommand = latestSnap.val();
      if (!latestCommand || latestCommand.id !== command.id || latestCommand.status !== 'pending') {
        return null;
      }

      const latestRequestedAt = commandRequestedAt(latestCommand);
      const latestExpiresAt = commandExpiresAt(latestCommand);
      const malformed = !latestCommand.requestedBy || !latestRequestedAt || !latestExpiresAt;
      const alreadyExpired = latestExpiresAt <= at || latestRequestedAt > at + 10000;

      if (malformed || alreadyExpired) {
        const reason = malformed ? 'firebase_rejected_malformed' : 'firebase_rejected_expired';
        const verifySnap = await change.after.ref.get();
        const verifyCommand = verifySnap.exists() ? verifySnap.val() : null;
        if (!verifyCommand || verifyCommand.id !== command.id || verifyCommand.status !== 'pending') {
          return null;
        }

        await change.after.ref.update({
          status: 'expired',
          doneAt: at,
          closedAt: at,
          resultReason: reason
        });
        await patchRecord(command, {
          status: 'expired',
          doneAt: at,
          closedAt: at,
          resultReason: reason,
          firebaseValidatedAt: at
        });
        await writeEvent(command, 'rejected', reason, at);
        return null;
      }

      await patchRecord(latestCommand, {
        status: 'pending',
        resultReason: 'firebase_validated',
        firebaseValidatedAt: at,
        requestedAt: latestRequestedAt,
        requestedAtEsp: latestRequestedAt,
        ttlMs: commandTtl(latestCommand),
        expiresAt: latestExpiresAt
      });
      await writeEvent(latestCommand, 'validated', 'waiting_for_esp', at);
      await new Promise((resolve) => setTimeout(resolve, COMMAND_TIMEOUT_MS + 500));
      await expireIfStillPending(latestCommand.id, 'firebase_expired_unclaimed');
      await new Promise((resolve) => setTimeout(resolve, LIVE_SLOT_RETIRE_MS - COMMAND_TIMEOUT_MS));
      await retireOldLiveSlot();
      return null;
    }

    if (/^(active|done|failed|expired)$/.test(status)) {
      const patch = {
        status,
        resultReason: command.resultReason || `firebase_observed_${status}`
      };
      if (command.activeAt) patch.espClaimedAt = Number(command.activeAt);
      if (command.doneAt) {
        patch.doneAt = Number(command.doneAt);
        patch.closedAt = Number(command.doneAt);
      }
      await patchRecord(command, patch);
      await writeEvent(command, `observed_${status}`, patch.resultReason, at);
      if (/^(done|failed|expired)$/.test(status)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await retireOldLiveSlot();
      }
    }

    return null;
  });

exports.watchdogLiveCommand = functions
  .runWith({ maxInstances: 1, timeoutSeconds: 30, memory: '256MB' })
  .region('asia-southeast1')
  .pubsub.schedule('every 1 minutes')
  .timeZone('Australia/Brisbane')
  .onRun(async () => {
    await expireIfStillPending('', 'firebase_watchdog_expired');
    await retireOldLiveSlot();
    return null;
  });
