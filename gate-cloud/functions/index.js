const admin = require('firebase-admin');
const functions = require('firebase-functions/v1');

admin.initializeApp();

const db = admin.database();
const COMMAND_TIMEOUT_MS = 3000;
const LIVE_SLOT_RETIRE_MS = 10000;
const INSTANCE = 'gate-controller-1b092-default-rtdb';
const FUNCTION_VERSION = '0.3.1+20260616';

function now() {
  return Date.now();
}

function eventTimeMs(context) {
  const parsed = context && context.timestamp ? Date.parse(context.timestamp) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : now();
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
  return Number(command.requestedAt || command.requestedAtEsp || 0);
}

function commandExpiresAt(command) {
  const explicit = Number(command.expiresAt || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
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
    ttlMs: commandTtl(command),
    expiresAt: commandExpiresAt(command),
    accessGroup: command.accessGroup || '',
    alertEligible: Boolean(command.alertEligible),
    source: command.source || 'web',
    cloudFunctionVersion: FUNCTION_VERSION,
    ...patch
  };
}

function liveCommandFromRequest(request, profile, requestedAt) {
  const ttlMs = commandTtl(request);
  const accessGroup = profile.accessGroup || 'guest';
  return {
    id: request.id,
    type: request.type || 'pulse',
    status: 'pending',
    sessionId: request.sessionId || '',
    requestedBy: request.requestedBy || '',
    requestedByName: request.requestedByName || profile.name || profile.email || 'User',
    requestedAt,
    requestedAtEsp: requestedAt,
    ttlMs,
    expiresAt: requestedAt + ttlMs,
    accessGroup,
    alertEligible: accessGroup !== 'family',
    pageVisibility: request.pageVisibility || '',
    userAgent: request.userAgent || '',
    espLastSeenAtRequest: Number(request.espLastSeenAtRequest || 0),
    espLastFirebaseCodeAtRequest: Number(request.espLastFirebaseCodeAtRequest || 0),
    espRssiAtRequest: Number(request.espRssiAtRequest || 0),
    durationMs: Number(request.durationMs || 0),
    source: 'web',
    firebaseReceivedAt: requestedAt,
    cloudFunctionVersion: FUNCTION_VERSION
  };
}

function isExecutableLiveCommand(command, at = now()) {
  if (!command || !command.id) return false;
  if (!/^(pending|active)$/.test(command.status || '')) return false;
  const expiresAt = commandExpiresAt(command);
  return !expiresAt || expiresAt > at;
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
  const record = commandRecordPatch(command, patch);
  const updates = {};
  updates[`gate/commandRecords/${command.id}`] = record;
  updates[`gate/logs/${command.id}`] = record;
  if (record.requestedBy) {
    updates[`userLogs/${record.requestedBy}/${command.id}`] = record;
  }
  await db.ref().update(updates);
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

exports.onCommandRequestCreated = functions
  .runWith({ maxInstances: 10, timeoutSeconds: 30, memory: '256MB' })
  .region('asia-southeast1')
  .database.instance(INSTANCE)
  .ref('/gate/commandRequests/{commandId}')
  .onCreate(async (snap, context) => {
    const request = snap.val();
    const requestedAt = eventTimeMs(context);
    const processedAt = now();

    if (!request || !request.id || request.id !== context.params.commandId || !request.requestedBy) {
      await snap.ref.update({
        status: 'rejected',
        resultReason: 'firebase_rejected_malformed',
        processedAt
      });
      return null;
    }

    if (processedAt - requestedAt > COMMAND_TIMEOUT_MS) {
      const staleCommand = liveCommandFromRequest(request, {}, requestedAt);
      await patchRecord(staleCommand, {
        status: 'expired',
        doneAt: processedAt,
        closedAt: processedAt,
        resultReason: 'firebase_request_stale',
        firebaseRejectedAt: processedAt
      });
      await writeEvent(staleCommand, 'request_rejected', 'firebase_request_stale', processedAt);
      await snap.ref.update({
        status: 'rejected',
        resultReason: 'firebase_request_stale',
        processedAt
      });
      return null;
    }

    const profileSnap = await db.ref(`users/${request.requestedBy}`).get();
    const profile = profileSnap.exists() ? profileSnap.val() : {};
    const enabled = profile.enabled === true && Number(profile.expiresAt || 0) > processedAt;
    const adminEmergency = request.type !== 'emergencyPulse' || profile.role === 'admin';

    if (!enabled || !adminEmergency) {
      const rejectedCommand = liveCommandFromRequest(request, profile, requestedAt);
      const reason = enabled ? 'firebase_rejected_admin_required' : 'firebase_rejected_access_disabled';
      await patchRecord(rejectedCommand, {
        status: 'failed',
        doneAt: processedAt,
        closedAt: processedAt,
        resultReason: reason,
        firebaseRejectedAt: processedAt
      });
      await writeEvent(rejectedCommand, 'request_rejected', reason, processedAt);
      await snap.ref.update({
        status: 'rejected',
        resultReason: reason,
        processedAt
      });
      return null;
    }

    const command = liveCommandFromRequest(request, profile, requestedAt);
    await patchRecord(command, {
      status: 'pending',
      resultReason: 'firebase_request_received',
      firebaseReceivedAt: requestedAt
    });
    await writeEvent(command, 'request_received', 'waiting_for_live_slot', requestedAt);

    const liveRef = db.ref('gate/liveCommand');
    const result = await liveRef.transaction((current) => {
      if (isExecutableLiveCommand(current, processedAt)) return current;
      return command;
    });

    const liveCommand = result.snapshot && result.snapshot.exists() ? result.snapshot.val() : null;
    const accepted = liveCommand && liveCommand.id === command.id;

    if (!accepted) {
      await patchRecord(command, {
        status: 'failed',
        doneAt: processedAt,
        closedAt: processedAt,
        resultReason: 'firebase_live_slot_busy',
        firebaseRejectedAt: processedAt
      });
      await writeEvent(command, 'request_rejected', 'firebase_live_slot_busy', processedAt);
      await snap.ref.update({
        status: 'rejected',
        resultReason: 'firebase_live_slot_busy',
        processedAt
      });
      return null;
    }

    await patchRecord(command, {
      status: 'pending',
      resultReason: 'live_slot_claimed',
      liveSlotClaimed: true,
      liveSlotClaimedAt: processedAt,
      firebaseValidatedAt: processedAt
    });
    await writeEvent(command, 'live_slot_claimed', 'waiting_for_esp', processedAt);
    await snap.ref.update({
      status: 'accepted',
      resultReason: 'live_slot_claimed',
      processedAt
    });
    return null;
  });

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
