const app = firebase.initializeApp(window.firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
const APP_VERSION = '0.3.2+20260616';

// Gate command boundary:
// This web app is a GUI only. It never authors command time, expiry, TTL, or
// executable gate state. It writes a user intent to gate/commandRequests/{id};
// Firebase Functions stamps server time and publishes gate/liveCommand for ESP.

const els = {
  statusPill: document.getElementById('statusPill'),
  subline: document.getElementById('subline'),
  loginView: document.getElementById('loginView'),
  inviteView: document.getElementById('inviteView'),
  gateView: document.getElementById('gateView'),
  adminView: document.getElementById('adminView'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('loginBtn'),
  loginError: document.getElementById('loginError'),
  inviteName: document.getElementById('inviteName'),
  inviteUsername: document.getElementById('inviteUsername'),
  inviteEmail: document.getElementById('inviteEmail'),
  invitePassword: document.getElementById('invitePassword'),
  claimInviteBtn: document.getElementById('claimInviteBtn'),
  inviteError: document.getElementById('inviteError'),
  logoutBtn: document.getElementById('logoutBtn'),
  userName: document.getElementById('userName'),
  userRole: document.getElementById('userRole'),
  userSummary: document.getElementById('userSummary'),
  openGateBtn: document.getElementById('openGateBtn'),
  gateMessage: document.getElementById('gateMessage'),
  gateCam: document.getElementById('gateCam'),
  cameraFallback: document.getElementById('cameraFallback'),
  cameraStatus: document.getElementById('cameraStatus'),
  lastCommand: document.getElementById('lastCommand'),
  deviceSeen: document.getElementById('deviceSeen'),
  userOpenCount: document.getElementById('userOpenCount'),
  userLastAccess: document.getElementById('userLastAccess'),
  userLogsList: document.getElementById('userLogsList'),
  themeSelect: document.getElementById('themeSelect'),
  backgroundInput: document.getElementById('backgroundInput'),
  clearBackgroundBtn: document.getElementById('clearBackgroundBtn'),
  adminTotalCommands: document.getElementById('adminTotalCommands'),
  adminNonFamily: document.getElementById('adminNonFamily'),
  adminEnabledUsers: document.getElementById('adminEnabledUsers'),
  adminLastCommand: document.getElementById('adminLastCommand'),
  refreshAdminBtn: document.getElementById('refreshAdminBtn'),
  adminBtn: document.getElementById('adminBtn'),
  backToGateBtn: document.getElementById('backToGateBtn'),
  emergencyPulseBtn: document.getElementById('emergencyPulseBtn'),
  emergencyStatus: document.getElementById('emergencyStatus'),
  configPulseMs: document.getElementById('configPulseMs'),
  configEmergencyPulseMs: document.getElementById('configEmergencyPulseMs'),
  configHeartbeatIdleMs: document.getElementById('configHeartbeatIdleMs'),
  configPollMs: document.getElementById('configPollMs'),
  configCommandTimeoutMs: document.getElementById('configCommandTimeoutMs'),
  saveConfigBtn: document.getElementById('saveConfigBtn'),
  configStatus: document.getElementById('configStatus'),
  reportedConfigSummary: document.getElementById('reportedConfigSummary'),
  commandRecordsList: document.getElementById('commandRecordsList'),
  userForm: document.getElementById('userForm'),
  editUid: document.getElementById('editUid'),
  editName: document.getElementById('editName'),
  editEmail: document.getElementById('editEmail'),
  editRole: document.getElementById('editRole'),
  editAccessGroup: document.getElementById('editAccessGroup'),
  editExpires: document.getElementById('editExpires'),
  editEnabled: document.getElementById('editEnabled'),
  deleteUserBtn: document.getElementById('deleteUserBtn'),
  inviteForm: document.getElementById('inviteForm'),
  quickInviteBtn: document.getElementById('quickInviteBtn'),
  inviteResult: document.getElementById('inviteResult'),
  quickInviteText: document.getElementById('quickInviteText'),
  inviteAccessGroup: document.getElementById('inviteAccessGroup'),
  inviteExpires: document.getElementById('inviteExpires'),
  inviteLink: document.getElementById('inviteLink'),
  invitesList: document.getElementById('invitesList'),
  usersList: document.getElementById('usersList'),
  logsList: document.getElementById('logsList')
};

let currentUser = null;
let currentProfile = null;
let pendingCommandId = '';
let sessionId = localStorage.getItem('gateSessionId') || '';
let latestLiveCommand = null;
let latestDevice = {};
let latestState = {};
let latestDesiredConfig = {};
let cameraStarted = false;
let cameraHls = null;
const LOOK_KEY = 'gateLook';
const DEVICE_HEARTBEAT_STALE_MS = 45000;
const inviteCode = new URLSearchParams(window.location.search).get('invite') || '';
const ACTIVE_COMMAND_STATUSES = new Set(['pending', 'active']);
const FULL_ACCESS_EXPIRES_AT = 4102444800000;

async function checkAppVersion() {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;

    const remote = await response.json();
    if (!remote || !remote.version || remote.version === APP_VERSION) return;

    const reloadKey = `gateReloadedForVersion:${remote.version}`;
    if (sessionStorage.getItem(reloadKey)) return;

    sessionStorage.setItem(reloadKey, '1');
    const url = new URL(window.location.href);
    url.searchParams.set('v', remote.version);
    window.location.replace(url.toString());
  } catch (error) {
    console.warn('Version check failed', error);
  }
}

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

function setOnline(online, label) {
  els.statusPill.textContent = label || (online ? 'Online' : 'Offline');
  els.statusPill.classList.toggle('online', online);
  els.statusPill.classList.toggle('offline', !online);
}

function setCameraState(state, message) {
  if (!els.cameraStatus || !els.cameraFallback) return;
  els.cameraStatus.textContent = message;
  els.cameraStatus.dataset.state = state;
  els.cameraFallback.classList.toggle('hidden', state === 'playing');
}

function initCameraPreview() {
  if (cameraStarted || !els.gateCam) return;
  cameraStarted = true;

  const cameraConfig = window.gateCameraConfig || {};
  const hlsUrl = String(cameraConfig.hlsUrl || '').trim();

  if (!hlsUrl) {
    setCameraState('missing', 'Camera relay not configured');
    return;
  }

  const video = els.gateCam;
  const markUnavailable = () => setCameraState('failed', 'Camera feed unavailable');

  video.muted = true;
  video.playsInline = true;
  video.addEventListener('playing', () => setCameraState('playing', 'Camera live'), { once: true });
  video.addEventListener('error', markUnavailable);

  if (window.Hls && window.Hls.isSupported()) {
    cameraHls = new window.Hls({
      lowLatencyMode: true,
      backBufferLength: 20
    });
    cameraHls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data && data.fatal) {
        cameraHls.destroy();
        cameraHls = null;
        markUnavailable();
      }
    });
    cameraHls.loadSource(hlsUrl);
    cameraHls.attachMedia(video);
    setCameraState('loading', 'Camera loading');
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = hlsUrl;
    setCameraState('loading', 'Camera loading');
    return;
  }

  setCameraState('unsupported', 'Camera feed unsupported by this browser');
}

function stopCameraPreview() {
  if (cameraHls) {
    cameraHls.destroy();
    cameraHls = null;
  }
  if (els.gateCam) {
    els.gateCam.pause();
    els.gateCam.removeAttribute('src');
    els.gateCam.load();
  }
  cameraStarted = false;
  setCameraState('missing', 'Camera not configured');
}

function fmtTime(value) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString();
}

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  if (ms < 1000) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function deviceHealth(now = Date.now()) {
  const seen = Number((latestState && latestState.deviceLastSeen) || (latestDevice && latestDevice.lastSeen) || 0);
  const age = seen ? now - seen : Infinity;
  return {
    seen,
    age,
    fresh: seen > 0 && age <= DEVICE_HEARTBEAT_STALE_MS,
    ip: (latestDevice && latestDevice.ip) || '',
    lastCode: Number((latestState && latestState.lastFirebaseCode) || (latestDevice && latestDevice.lastFirebaseCode) || 0),
    failures: Number((latestState && latestState.firebaseRequestFailureCount) || (latestDevice && latestDevice.firebaseRequestFailureCount) || 0),
    consecutiveFailures: Number((latestState && latestState.firebaseConsecutiveFailureCount) || (latestDevice && latestDevice.firebaseConsecutiveFailureCount) || 0),
    recovery: (latestState && latestState.lastCloudRecoveryReason) || (latestDevice && latestDevice.lastCloudRecoveryReason) || ''
  };
}

function datetimeLocalToMillis(value) {
  if (!value) return 4102444800000;
  return new Date(value).getTime();
}

function millisToDatetimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function canUseGate(profile) {
  return profile && profile.enabled === true && Number(profile.expiresAt || 0) > Date.now();
}

function setGateFeedback(state, message) {
  els.openGateBtn.classList.remove('sent', 'processing', 'accepted', 'rejected', 'idle', 'ready', 'lost');
  els.gateMessage.classList.remove('ok', 'bad', 'pending');

  if (state) {
    els.openGateBtn.classList.add(state);
  }

  if (state === 'accepted') {
    els.gateMessage.classList.add('ok');
  } else if (state === 'rejected') {
    els.gateMessage.classList.add('bad');
  } else if (state === 'sent' || state === 'processing') {
    els.gateMessage.classList.add('pending');
  }

  els.gateMessage.textContent = message;
}

function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function makeSessionId() {
  return `web_${randomHex(12)}`;
}

function makeCommandId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `cmd_${randomHex(16)}`;
}

function getSessionId() {
  if (!sessionId) {
    sessionId = makeSessionId();
    localStorage.setItem('gateSessionId', sessionId);
  }
  return sessionId;
}

function renderGateState() {
  if (!els.openGateBtn || !currentProfile) return;
  const now = Date.now();
  const accessOk = canUseGate(currentProfile);
  const health = deviceHealth(now);

  if (health.fresh) {
    setOnline(true, 'Gate online');
    els.deviceSeen.textContent = `${fmtTime(health.seen)} (${fmtAge(health.age)})`;
  } else if (health.seen) {
    setOnline(false, 'ESP stale');
    const parts = [`stale ${fmtAge(health.age)}`];
    if (health.ip) parts.push(`IP ${health.ip}`);
    if (health.lastCode) parts.push(`last Firebase ${health.lastCode}`);
    if (health.consecutiveFailures) parts.push(`${health.consecutiveFailures} current failures`);
    if (health.recovery) parts.push(`recovery: ${health.recovery}`);
    els.deviceSeen.textContent = parts.join(' - ');
  } else {
    setOnline(false, 'ESP unseen');
    els.deviceSeen.textContent = 'No heartbeat yet';
  }

  els.openGateBtn.classList.remove('idle', 'ready', 'lost');
  if (!accessOk) {
    els.openGateBtn.classList.add('lost');
  } else {
    els.openGateBtn.classList.add('ready');
  }
  if (!pendingCommandId) {
    if (!accessOk) {
      els.gateMessage.textContent = 'Access disabled or expired';
    } else if (!health.fresh) {
      els.gateMessage.textContent = 'ESP heartbeat stale; firmware recovery should be running';
    } else {
      els.gateMessage.textContent = 'Ready';
    }
  }
  els.openGateBtn.disabled = !accessOk;
}

function makeInviteCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function tomorrowAtEndOfDay() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(23, 59, 0, 0);
  return date.getTime();
}

function fullAccessExpiry() {
  return FULL_ACCESS_EXPIRES_AT;
}

function buildInviteLink(code) {
  return `${location.origin}${location.pathname}?invite=${code}`;
}

function buildInviteMessage(link, expiresAt) {
  return `Gate access link: ${link}\n\nUse this to create your family gate login.`;
}

function writeInviteAudit(code, event, details = {}) {
  if (!code || !currentUser) return Promise.resolve();
  return db.ref(`inviteAudits/${code}`).push().set({
    code,
    event,
    at: Date.now(),
    uid: currentUser.uid,
    email: currentUser.email || '',
    userAgent: navigator.userAgent.slice(0, 160),
    ...details
  }).catch((error) => {
    console.warn('Invite audit write failed', error);
  });
}

function normalizeUsername(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function usernameIsValid(username) {
  return /^[a-z0-9_]{3,24}$/.test(username);
}

function loadLook() {
  try {
    return JSON.parse(localStorage.getItem(LOOK_KEY)) || {};
  } catch (error) {
    return {};
  }
}

function saveLook(look) {
  localStorage.setItem(LOOK_KEY, JSON.stringify(look));
}

function applyLook() {
  const look = loadLook();
  document.body.dataset.theme = look.theme || 'fresh';
  document.body.style.setProperty('--user-bg', look.background ? `url("${look.background}")` : 'linear-gradient(transparent, transparent)');
  if (els.themeSelect) {
    els.themeSelect.value = look.theme || 'fresh';
  }
}

function resizeImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function chooseBackground(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const look = loadLook();
    look.background = await resizeImageToDataUrl(file);
    saveLook(look);
    applyLook();
  } catch (error) {
    els.gateMessage.textContent = 'Could not use that photo';
  } finally {
    els.backgroundInput.value = '';
  }
}

function changeTheme() {
  const look = loadLook();
  look.theme = els.themeSelect.value;
  saveLook(look);
  applyLook();
}

function clearBackground() {
  const look = loadLook();
  delete look.background;
  saveLook(look);
  applyLook();
}

async function signIn() {
  els.loginError.textContent = '';
  try {
    await auth.signInWithEmailAndPassword(els.email.value.trim(), els.password.value);
  } catch (error) {
    els.loginError.textContent = error.message;
  }
}

async function claimInvite() {
  els.inviteError.textContent = '';
  const name = els.inviteName.value.trim();
  const username = normalizeUsername(els.inviteUsername.value);
  const email = els.inviteEmail.value.trim();
  const password = els.invitePassword.value;
  const signedInUser = auth.currentUser;

  if (!inviteCode || !name || !username || !email || (!signedInUser && !password)) {
    els.inviteError.textContent = signedInUser
      ? 'Name, username, and email are required'
      : 'Name, username, email, and password are required';
    return;
  }

  if (!usernameIsValid(username)) {
    els.inviteError.textContent = 'Username must be 3-24 characters: letters, numbers, or underscore';
    return;
  }

  let credential = null;
  let createdAccount = false;
  let reservedUsername = false;

  try {
    if (signedInUser) {
      credential = { user: signedInUser };
    } else {
      try {
        credential = await auth.createUserWithEmailAndPassword(email, password);
        createdAccount = true;
      } catch (error) {
        if (error.code !== 'auth/email-already-in-use') {
          throw error;
        }
        credential = await auth.signInWithEmailAndPassword(email, password);
      }
    }

    const user = credential.user;
    currentUser = user;
    const claimEmail = user.email || email;
    await writeInviteAudit(inviteCode, 'claim_attempt', { email: claimEmail, name, username });
    const inviteRef = db.ref(`invites/${inviteCode}`);
    const inviteSnap = await inviteRef.get();

    if (!inviteSnap.exists()) {
      throw new Error('Invite not found');
    }

    const invite = inviteSnap.val();
    if (invite.claimedBy && invite.claimedBy !== user.uid) {
      throw new Error('Invite already used');
    }
    if (Number(invite.expiresAt || 0) <= Date.now()) {
      throw new Error('Invite expired');
    }

    const usernameRef = db.ref(`usernames/${username}`);
    const usernameSnap = await usernameRef.get();
    if (usernameSnap.exists() && usernameSnap.val() !== user.uid) {
      throw new Error('Username already taken');
    }
    if (!usernameSnap.exists()) {
      await usernameRef.set(user.uid);
      reservedUsername = true;
    }

    await inviteRef.update({
      claimedBy: user.uid,
      claimedByEmail: claimEmail,
      claimedByName: name,
      claimedAt: Date.now()
    });

    await db.ref(`users/${user.uid}`).set({
      name,
      username,
      email: claimEmail,
      role: 'user',
      accessGroup: invite.accessGroup || 'guest',
      enabled: true,
      expiresAt: Number(invite.accessExpiresAt || invite.expiresAt || 0),
      inviteCode
    });
    await writeInviteAudit(inviteCode, 'claim_success', {
      email: claimEmail,
      name,
      username,
      accessGroup: invite.accessGroup || 'guest',
      accessExpiresAt: Number(invite.accessExpiresAt || invite.expiresAt || 0)
    });

    location.replace(window.location.pathname);
  } catch (error) {
    els.inviteError.textContent = error.message;
    if (credential && credential.user) {
      currentUser = credential.user;
      writeInviteAudit(inviteCode, 'claim_failed', {
        email: credential.user.email || email,
        name,
        username,
        reason: error.message
      });
    }
    if (reservedUsername) {
      db.ref(`usernames/${username}`).remove().catch(() => {});
    }
    if (createdAccount && credential && credential.user) {
      credential.user.delete().catch(() => {});
    }
  }
}

async function loadProfile(user) {
  const snap = await db.ref(`users/${user.uid}`).get();
  if (!snap.exists()) {
    return {
      name: user.email || 'Unregistered user',
      email: user.email || '',
      role: 'none',
      enabled: false,
      expiresAt: 0,
      missingProfile: true
    };
  }
  return snap.val();
}

function buildGateCommandRequest(id, type) {
  return {
    id,
    type,
    status: 'pending',
    sessionId: getSessionId(),
    requestedBy: currentUser.uid,
    requestedByName: currentProfile.name || currentUser.email || 'User',
    pageVisibility: document.visibilityState,
    userAgent: navigator.userAgent.slice(0, 160),
    espLastSeenAtRequest: Number((latestState && latestState.deviceLastSeen) || (latestDevice && latestDevice.lastSeen) || 0),
    espLastFirebaseCodeAtRequest: Number((latestState && latestState.lastFirebaseCode) || (latestDevice && latestDevice.lastFirebaseCode) || 0),
    espRssiAtRequest: Number((latestDevice && latestDevice.rssi) || 0)
  };
}

function buildEmergencyCommandRequest(id) {
  return {
    ...buildGateCommandRequest(id, 'emergencyPulse'),
    durationMs: Number((els.configEmergencyPulseMs && els.configEmergencyPulseMs.value) || latestDesiredConfig.emergencyPulseMs || 10000)
  };
}

function watchSubmittedCommand(id) {
  const ref = db.ref(`gate/commandRequests/${id}`);
  ref.on('value', (snap) => {
    const request = snap.val();
    if (!request || pendingCommandId !== id) return;

    if (request.status === 'accepted') {
      setGateFeedback('processing', 'Waiting for ESP state');
    } else if (request.status === 'rejected') {
      pendingCommandId = '';
      ref.off();
      setGateFeedback('rejected', request.resultReason || 'Gate request rejected');
    }
  });
}

async function sendGateCommandRequest(command) {
  await db.ref(`gate/commandRequests/${command.id}`).set(command);
  watchSubmittedCommand(command.id);
}

function setGateButtonActive(active) {
  els.openGateBtn.classList.toggle('sent', active);
  els.openGateBtn.disabled = !canUseGate(currentProfile);
}

function sendGatePulse(event) {
  event.preventDefault();
  if (!canUseGate(currentProfile)) {
    setGateFeedback('rejected', 'Access disabled or expired');
    return;
  }
  const id = makeCommandId();
  const command = buildGateCommandRequest(id, 'pulse');
  pendingCommandId = id;
  setGateButtonActive(true);
  setGateFeedback('sent', 'Gate request sent');
  sendGateCommandRequest(command).then(() => {
    if (pendingCommandId === id) {
      setGateFeedback('processing', 'Waiting for Firebase/ESP state');
    }
  }).catch((error) => {
    if (pendingCommandId === id) {
      pendingCommandId = '';
    }
    setGateFeedback('rejected', error.message);
    setGateButtonActive(false);
  });
}

function watchGate() {
  db.ref('gate/liveCommand').on('value', (snap) => {
    const command = snap.val();
    latestLiveCommand = command || null;
    if (!command) {
      els.lastCommand.textContent = 'None';
      renderGateState();
      if (els.emergencyStatus) {
        els.emergencyStatus.textContent = 'Ready. Sends one 10 second pulse. ESP handles any rapid repeats safely.';
      }
      return;
    }
    els.lastCommand.textContent = `${command.status || 'unknown'} by ${command.requestedByName || 'unknown'} at ${fmtTime(command.requestedAt)}`;
    renderGateState();

    if (pendingCommandId === command.id && command.status === 'active') {
      setGateFeedback('accepted', 'Gate command ingested');
    } else if (pendingCommandId === command.id && command.status === 'done') {
      pendingCommandId = '';
      setGateFeedback('accepted', 'Gate command completed');
    } else if (pendingCommandId === command.id && (command.status === 'failed' || command.status === 'expired')) {
      pendingCommandId = '';
      setGateFeedback('rejected', command.resultReason || 'Gate command rejected');
    } else if (!pendingCommandId && command.status === 'failed') {
      setGateFeedback('rejected', 'Last command failed');
    }
    if (els.emergencyStatus && command.type === 'emergencyPulse') {
      els.emergencyStatus.textContent = command.status === 'done'
        ? `Emergency pulse released at ${fmtTime(command.doneAt)}`
        : `Emergency pulse ${command.status || 'pending'} from ${fmtTime(command.requestedAt)}`;
    }
  });

  db.ref('gate/device').on('value', (snap) => {
    latestDevice = snap.val() || {};
    renderGateState();
  });

  db.ref('gate/state').on('value', (snap) => {
    latestState = snap.val() || {};
    renderGateState();
  });
}

function renderUserLogs(logs) {
  const entries = Object.values(logs || {})
    .sort((a, b) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));

  els.userOpenCount.textContent = String(entries.length);
  els.userLastAccess.textContent = entries[0] ? fmtTime(entries[0].requestedAt) : 'None yet';
  els.userLogsList.innerHTML = '';

  if (entries.length === 0) {
    els.userLogsList.innerHTML = '<div class="timeline-entry"><span>No access history yet</span></div>';
    return;
  }

  entries.slice(0, 6).forEach((log) => {
    const displayStatus = log.status || 'pending';
    const displayLabel = displayStatus;
    const row = document.createElement('div');
    row.className = 'timeline-entry';
    row.innerHTML = `
      <div>
        <strong>${fmtTime(log.requestedAt)}</strong>
        <small>${log.accessGroup || 'access'} ${log.alertEligible ? '- admin alert eligible' : ''}</small>
      </div>
      <span class="status-chip ${displayStatus}">${displayLabel}</span>
    `;
    els.userLogsList.appendChild(row);
  });
}

function fillConfigForm(desired, reported) {
  latestDesiredConfig = desired || {};
  if (!els.configPulseMs) return;
  els.configPulseMs.value = desired.pulseMs || reported.pulseMs || 1000;
  els.configEmergencyPulseMs.value = desired.emergencyPulseMs || reported.emergencyPulseMs || 10000;
  els.configHeartbeatIdleMs.value = desired.heartbeatIdleMs || reported.heartbeatIdleMs || 10000;
  els.configPollMs.value = desired.pollMs || reported.pollMs || 500;
  els.configCommandTimeoutMs.value = desired.commandTimeoutMs || reported.commandTimeoutMs || 3000;
  els.reportedConfigSummary.textContent = `ESP reports pulse ${reported.pulseMs || '-'} ms, idle heartbeat ${reported.heartbeatIdleMs || '-'} ms, poll ${reported.pollMs || '-'} ms, revision ${reported.revision || 'default'}.`;
}

async function saveGateConfig() {
  if (!currentProfile || currentProfile.role !== 'admin') return;
  const now = Date.now();
  const nextRevision = Number(latestDesiredConfig.revision || 0) + 1 || now;
  const desired = {
    pulseMs: Number(els.configPulseMs.value || 1000),
    emergencyPulseMs: Number(els.configEmergencyPulseMs.value || 10000),
    heartbeatIdleMs: Number(els.configHeartbeatIdleMs.value || 10000),
    pollMs: Number(els.configPollMs.value || 500),
    commandTimeoutMs: Math.min(3000, Number(els.configCommandTimeoutMs.value || 3000)),
    revision: nextRevision,
    updatedAt: now,
    updatedBy: currentUser.uid,
    updatedByName: currentProfile.name || currentUser.email || 'Admin'
  };
  els.saveConfigBtn.disabled = true;
  els.configStatus.textContent = 'Saving config for ESP...';
  try {
    await db.ref('gate/config/desired').set(desired);
    latestDesiredConfig = desired;
    els.configStatus.textContent = `Saved revision ${desired.revision}. ESP will report it back after polling.`;
  } catch (error) {
    els.configStatus.textContent = error.message;
  } finally {
    els.saveConfigBtn.disabled = false;
  }
}

function renderCommandRecords(records) {
  if (!els.commandRecordsList) return;
  const entries = Object.values(records || {})
    .sort((a, b) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));
  els.commandRecordsList.innerHTML = '';
  if (!entries.length) {
    els.commandRecordsList.innerHTML = '<div class="timeline-entry"><span>No command traces yet</span></div>';
    return;
  }
  entries.slice(0, 50).forEach((record) => {
    const row = document.createElement('div');
    row.className = 'timeline-entry';
    row.innerHTML = `
      <div>
        <strong>${record.requestedByName || 'Unknown'} - ${record.status || 'unknown'}</strong>
        <small>${fmtTime(record.requestedAt)} / ${record.type || 'pulse'} / ${record.id || ''}</small>
        <small>${record.resultReason || 'no reason recorded'}${record.sessionId ? ` / ${record.sessionId}` : ''}</small>
      </div>
      <span class="status-chip ${record.status || 'pending'}">${record.status || 'unknown'}</span>
    `;
    els.commandRecordsList.appendChild(row);
  });
}

function watchUserLogs() {
  if (!currentUser) return;
  db.ref(`userLogs/${currentUser.uid}`).orderByChild('requestedAt').limitToLast(25).on('value', (snap) => {
    renderUserLogs(snap.val() || {});
  });
}

async function loadAdmin() {
  if (!currentProfile || currentProfile.role !== 'admin') return;

  try {
    const usersSnap = await db.ref('users').get();
  const users = usersSnap.val() || {};
  els.usersList.innerHTML = '';

  Object.entries(users).forEach(([uid, user]) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div>
        <strong>${user.name || user.email || uid}</strong>
        <small>${user.email || ''}</small>
        <small>${user.username ? `@${user.username}` : 'no username'}</small>
        <small>${user.role || 'user'} - ${user.accessGroup || 'guest'} - ${user.enabled ? 'enabled' : 'disabled'} - expires ${fmtTime(user.expiresAt)}</small>
        <small>${uid}</small>
      </div>
      <div class="row-actions">
        <button class="ghost edit-user" type="button">Edit</button>
        <button class="danger revoke-user" type="button">Revoke</button>
      </div>
    `;
    row.querySelector('.edit-user').addEventListener('click', () => {
      selectUserRow(row);
      els.editUid.value = uid;
      els.editName.value = user.name || '';
      els.editEmail.value = user.email || '';
      els.editRole.value = user.role || 'user';
      els.editAccessGroup.value = user.accessGroup || 'guest';
      els.editExpires.value = millisToDatetimeLocal(user.expiresAt);
      els.editEnabled.checked = user.enabled === true;
      show(els.userForm, true);
    });
    row.querySelector('.revoke-user').addEventListener('click', async () => {
      selectUserRow(row);
      await revokeUserAccess(uid);
    });
    els.usersList.appendChild(row);
  });

  els.adminEnabledUsers.textContent = String(Object.values(users).filter((user) => user.enabled === true && user.role !== 'device').length);

  const desiredConfigSnap = await db.ref('gate/config/desired').get();
  const reportedConfigSnap = await db.ref('gate/config/reported').get();
  fillConfigForm(desiredConfigSnap.val() || {}, reportedConfigSnap.val() || {});

  const recordsSnap = await db.ref('gate/commandRecords').orderByChild('requestedAt').limitToLast(50).get();
  renderCommandRecords(recordsSnap.val() || {});

  const logsSnap = await db.ref('gate/logs').orderByChild('requestedAt').limitToLast(50).get();
  const logs = logsSnap.val() || {};
  const logEntries = Object.values(logs).sort((a, b) => Number(b.requestedAt || 0) - Number(a.requestedAt || 0));
  els.adminTotalCommands.textContent = String(logEntries.length);
  els.adminNonFamily.textContent = String(logEntries.filter((log) => log.accessGroup !== 'family').length);
  els.adminLastCommand.textContent = logEntries[0] ? fmtTime(logEntries[0].requestedAt) : 'None';
  els.logsList.innerHTML = '';

  logEntries
    .forEach((log) => {
      const displayStatus = log.status || 'unknown';
      const displayLabel = displayStatus;
      const row = document.createElement('div');
      row.className = 'timeline-entry';
      row.innerHTML = `
        <div>
          <strong>${log.requestedByName || 'Unknown'}</strong>
          <small>${fmtTime(log.requestedAt)}</small>
          <small>${log.accessGroup || 'unknown'} access ${log.alertEligible ? '- alert sent' : ''}</small>
        </div>
        <span class="status-chip ${displayStatus}">${displayLabel}</span>
      `;
      els.logsList.appendChild(row);
    });

  const invitesSnap = await db.ref('invites').orderByChild('createdAt').limitToLast(30).get();
  const invites = invitesSnap.val() || {};
  const inviteEntries = Object.entries(invites).sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0));
  els.invitesList.innerHTML = '';

  inviteEntries.forEach(([code, invite]) => {
    const used = Boolean(invite.claimedBy);
    const expired = Number(invite.expiresAt || 0) <= Date.now();
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div>
        <strong>${invite.accessGroup || 'guest'} invite</strong>
        <small>${used ? `used by ${invite.claimedByName || invite.claimedByEmail || invite.claimedBy}` : expired ? 'expired' : 'unused'} - expires ${fmtTime(invite.expiresAt)}</small>
        <small>${buildInviteLink(code)}</small>
      </div>
      <button class="ghost" type="button">${used || expired ? 'Copy' : 'Copy link'}</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      const link = buildInviteLink(code);
      await navigator.clipboard.writeText(link);
    });
    els.invitesList.appendChild(row);
  });
  } catch (error) {
    console.error('[loadAdmin] Error loading admin data:', error.code, error.message);
  }
}

async function saveUser(event) {
  event.preventDefault();
  const uid = els.editUid.value.trim();
  if (!uid) return;

  await db.ref(`users/${uid}`).set({
    name: els.editName.value.trim(),
    email: els.editEmail.value.trim(),
    role: els.editRole.value,
    accessGroup: els.editAccessGroup.value,
    enabled: els.editEnabled.checked,
    expiresAt: datetimeLocalToMillis(els.editExpires.value)
  });

  await loadAdmin();
}

function selectUserRow(row) {
  els.usersList.querySelectorAll('.item.selected').forEach((item) => item.classList.remove('selected'));
  row.classList.add('selected');
}

async function revokeUserAccess(uid) {
  if (!uid) return;
  const userSnap = await db.ref(`users/${uid}`).get();
  const user = userSnap.val() || {};
  if (user.username) {
    const usernameRef = db.ref(`usernames/${user.username}`);
    const usernameSnap = await usernameRef.get();
    if (usernameSnap.val() === uid) {
      await usernameRef.remove();
    }
  }
  await db.ref(`users/${uid}`).remove();
  if (els.editUid.value.trim() === uid) {
    els.editUid.value = '';
    els.editName.value = '';
    els.editEmail.value = '';
  }
  await loadAdmin();
}

async function deleteUserProfile() {
  const uid = els.editUid.value.trim();
  await revokeUserAccess(uid);
}

async function createInviteWithOptions(accessGroup, expiresAt, asPasteMessage) {
  const code = makeInviteCode();
  const invite = {
    accessGroup,
    accessExpiresAt: expiresAt,
    expiresAt,
    createdAt: Date.now(),
    createdBy: currentUser.uid,
    createdByName: currentProfile.name || currentUser.email || 'Admin'
  };

  await db.ref(`invites/${code}`).set(invite);
  await writeInviteAudit(code, 'link_created', {
    accessGroup,
    accessExpiresAt: expiresAt
  });
  const link = buildInviteLink(code);
  const pasteText = asPasteMessage ? buildInviteMessage(link, expiresAt) : link;
  els.inviteLink.value = link;
  els.quickInviteText.value = pasteText;
  show(els.inviteResult, true);
  if (asPasteMessage && navigator.share) {
    await navigator.share({ title: 'Gate access', text: pasteText })
      .catch(() => navigator.clipboard.writeText(pasteText).catch(() => {}));
  } else {
    await navigator.clipboard.writeText(pasteText).catch(() => {});
  }
  await loadAdmin();
}

async function createQuickInvite() {
  console.log('[createQuickInvite] Add User clicked, currentProfile.role:', currentProfile?.role);

  // Always show the result area immediately with a working message
  els.quickInviteText.value = 'Creating invite...';
  show(els.inviteResult, true);

  // Role guard — rules reject non-admin writes, so catch it early
  if (!currentProfile || currentProfile.role !== 'admin') {
    const msg = `Invite error: current user is not admin (role: ${currentProfile?.role || 'none'}).`;
    console.warn('[createQuickInvite]', msg);
    els.quickInviteText.value = msg;
    return;
  }

  const originalText = els.quickInviteBtn.textContent;
  const expiresAt = fullAccessExpiry();

  els.quickInviteBtn.disabled = true;
  els.quickInviteBtn.textContent = 'Creating...';

  try {
    const accessGroup = els.inviteAccessGroup.value || 'family';
    console.log('[createQuickInvite] Writing to invites/...', { accessGroup, expiresAt });
    await createInviteWithOptions(accessGroup, expiresAt, true);
    els.quickInviteBtn.textContent = 'Invite Ready';
    setTimeout(() => {
      els.quickInviteBtn.textContent = originalText;
      els.quickInviteBtn.disabled = false;
    }, 1400);
  } catch (error) {
    console.error('[createQuickInvite] Firebase error:', error.code, error.message);
    els.quickInviteText.value = `Invite error: ${error.code} - ${error.message}`;
    show(els.inviteResult, true);
    els.quickInviteBtn.textContent = originalText;
    els.quickInviteBtn.disabled = false;
  }
}

async function sendEmergencyPulse() {
  if (!currentProfile || currentProfile.role !== 'admin') {
    els.emergencyStatus.textContent = 'Admin access required';
    return;
  }
  if (!canUseGate(currentProfile)) {
    els.emergencyStatus.textContent = 'Access disabled or expired';
    return;
  }

  const id = makeCommandId();
  const command = buildEmergencyCommandRequest(id);

  els.emergencyStatus.textContent = 'Emergency pulse sent. Waiting for ESP release.';

  try {
    await sendGateCommandRequest(command);
  } catch (error) {
    els.emergencyStatus.textContent = error.message;
  }
}

auth.onAuthStateChanged(async (user) => {
  currentUser = user;
  currentProfile = null;

  if (!user) {
    stopCameraPreview();
    setOnline(false);
    show(els.loginView, !inviteCode);
    show(els.inviteView, Boolean(inviteCode));
    show(els.gateView, false);
    show(els.adminView, false);
    els.subline.textContent = inviteCode ? 'Create your gate login' : 'Sign in to continue';
    return;
  }

  currentProfile = await loadProfile(user);
  if (inviteCode && (!currentProfile.enabled || currentProfile.role === 'none')) {
    stopCameraPreview();
    setOnline(true);
    show(els.loginView, false);
    show(els.inviteView, true);
    show(els.gateView, false);
    show(els.adminView, false);
    els.subline.textContent = 'Finish gate access';
    if (!els.inviteEmail.value) {
      els.inviteEmail.value = user.email || '';
    }
    return;
  }

  setOnline(true);
  show(els.loginView, false);
  show(els.inviteView, false);
  show(els.gateView, true);
  show(els.adminView, false);
  show(els.adminBtn, currentProfile.role === 'admin');

  els.userName.textContent = currentProfile.name || user.email || 'User';
  els.userRole.textContent = `${currentProfile.accessGroup || 'guest'} access`;
  if (currentProfile.missingProfile) {
    els.userSummary.textContent = 'This login exists, but no gate profile is attached. Sign out and use a fresh invite link.';
    els.subline.textContent = 'Gate profile missing';
  } else {
    els.userSummary.textContent = `${currentProfile.enabled ? 'Enabled' : 'Disabled'} until ${fmtTime(currentProfile.expiresAt)}`;
    els.subline.textContent = currentProfile.enabled ? 'Ready' : 'Access disabled';
  }
  els.openGateBtn.disabled = !canUseGate(currentProfile);

  initCameraPreview();
  watchGate();
  watchUserLogs();
  await loadAdmin();
});

els.loginBtn.addEventListener('click', signIn);
els.claimInviteBtn.addEventListener('click', claimInvite);
els.password.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') signIn();
});
els.invitePassword.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') claimInvite();
});
els.logoutBtn.addEventListener('click', () => auth.signOut());
els.adminBtn.addEventListener('click', () => {
  show(els.gateView, false);
  show(els.adminView, true);
  loadAdmin();
});
els.backToGateBtn.addEventListener('click', () => {
  show(els.adminView, false);
  show(els.gateView, true);
});
els.openGateBtn.addEventListener('click', sendGatePulse);
els.refreshAdminBtn.addEventListener('click', loadAdmin);
els.userForm.addEventListener('submit', saveUser);
els.deleteUserBtn.addEventListener('click', deleteUserProfile);
els.quickInviteBtn.addEventListener('click', createQuickInvite);
els.emergencyPulseBtn.addEventListener('click', sendEmergencyPulse);
if (els.saveConfigBtn) {
  els.saveConfigBtn.addEventListener('click', saveGateConfig);
}
els.themeSelect.addEventListener('change', changeTheme);
els.backgroundInput.addEventListener('change', chooseBackground);
els.clearBackgroundBtn.addEventListener('click', clearBackground);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkAppVersion();
  }
  renderGateState();
});

checkAppVersion();
setInterval(checkAppVersion, 300000);
applyLook();
if (els.inviteExpires) {
  els.inviteExpires.value = millisToDatetimeLocal(fullAccessExpiry());
}
