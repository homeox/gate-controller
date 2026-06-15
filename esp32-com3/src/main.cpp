#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <sys/time.h>
#include <time.h>

#include "secrets.h"

constexpr int STATUS_LED_PIN = 2;
// GPIO32 drives the PC817/817C optocoupler input for the gate trigger.
// GPIO34 reads OPEN and GPIO35 reads CLOSE raw detector feeds. GPIO34 is input-only.
constexpr int GATE_SIGNAL_PIN = 32;
constexpr int OPEN_DETECTOR_PIN = 34;
constexpr int CLOSE_DETECTOR_PIN = 35;

constexpr unsigned long WIFI_RETRY_MS = 10000;
constexpr unsigned long DEFAULT_PULSE_MS = 1600;
constexpr unsigned long MIN_PULSE_MS = 100;
constexpr unsigned long MAX_PULSE_MS = 5000;
constexpr unsigned long MAX_CLOUD_PULSE_MS = 10000;
constexpr unsigned long DEFAULT_SMART_TIMEOUT_MS = 3000;
constexpr unsigned long MIN_SMART_TIMEOUT_MS = 100;
constexpr unsigned long MAX_SMART_TIMEOUT_MS = 10000;
constexpr unsigned long DEFAULT_CLOUD_POLL_MS = 300;
constexpr unsigned long DEFAULT_CLOUD_HEARTBEAT_IDLE_MS = 10000;
constexpr unsigned long CLOUD_CONFIG_POLL_MS = 5000;
constexpr unsigned long FIREBASE_TOKEN_REFRESH_MS = 3300000;
constexpr unsigned long FIREBASE_AUTH_RECOVERY_MS = 45000;
constexpr unsigned long FIREBASE_WIFI_RECOVERY_MS = 120000;
constexpr unsigned long FIREBASE_REBOOT_RECOVERY_MS = 300000;
constexpr unsigned long FIREBASE_RECOVERY_COOLDOWN_MS = 30000;
constexpr uint64_t DEFAULT_CLOUD_COMMAND_MAX_AGE_MS = 3000;

const char *HOSTNAME = "gate-controller";
const char *AP_SSID = "GateController";
const char *FIREBASE_DEVICE_EMAIL = "gate-device@gate-controller.local";
const char *FIRMWARE_VERSION = "0.2.1+20260615";

WebServer server(80);
DNSServer dnsServer;

bool gateSignalActive = false;
bool mdnsStarted = false;
bool otaStarted = false;
bool apStarted = false;
bool dnsStarted = false;
bool smartPulseActive = false;
bool timeStarted = false;
bool cloudCommandActive = false;

unsigned long gateSignalStartedMs = 0;
unsigned long lastWifiRetryMs = 0;
unsigned long lastCloudPollMs = 0;
unsigned long lastCloudHeartbeatMs = 0;
unsigned long lastCloudConfigPollMs = 0;
unsigned long lastFirebaseOkMs = 0;
unsigned long lastCloudRecoveryMs = 0;
unsigned long wifiConnectedSinceMs = 0;
unsigned long firebaseTokenMs = 0;
unsigned long pulseMs = DEFAULT_PULSE_MS;
unsigned long activePulseMs = DEFAULT_PULSE_MS;
unsigned long smartTimeoutMs = DEFAULT_SMART_TIMEOUT_MS;
unsigned long cloudPollMs = DEFAULT_CLOUD_POLL_MS;
unsigned long cloudHeartbeatIdleMs = DEFAULT_CLOUD_HEARTBEAT_IDLE_MS;
uint64_t cloudCommandMaxAgeMs = DEFAULT_CLOUD_COMMAND_MAX_AGE_MS;
uint64_t lastGateReleasedEpochMs = 0;
int smartCloseTrigger = 800;
int smartOpenTrigger = 800;
int smartCloseMin = 4095;
int smartCloseMax = 0;
int smartOpenMin = 4095;
int smartOpenMax = 0;
String firebaseIdToken;
String cloudCommandId;
String cloudCommandRequestedBy;
String cloudCommandSessionId;
String lastCloudReason;
uint64_t configRevision = 0;
int lastFirebaseCode = 0;
int lastCommandPollCode = 0;
uint32_t firebaseRequestCount = 0;
uint32_t firebaseAuthFailureCount = 0;
uint32_t firebaseRequestFailureCount = 0;
uint32_t firebaseConsecutiveFailureCount = 0;
uint32_t firebaseAuthRecoveryCount = 0;
uint32_t firebaseWifiRecoveryCount = 0;
uint32_t firebaseRebootRecoveryCount = 0;
uint64_t lastCommandPollAt = 0;
uint64_t lastCommandPollOkAt = 0;
String lastFirebasePath;
String lastFirebaseMethod;
String lastFirebaseFailurePath;
String lastFirebaseFailureMethod;
String lastCloudRecoveryReason;

uint64_t nowEpochMs();

void gateSignalOff() {
  const bool wasActive = gateSignalActive;
  digitalWrite(GATE_SIGNAL_PIN, LOW);
  digitalWrite(STATUS_LED_PIN, LOW);
  gateSignalActive = false;
  smartPulseActive = false;
  if (wasActive) {
    lastGateReleasedEpochMs = nowEpochMs();
  }
}

void gateSignalOn() {
  digitalWrite(GATE_SIGNAL_PIN, HIGH);
  digitalWrite(STATUS_LED_PIN, HIGH);
  gateSignalActive = true;
  gateSignalStartedMs = millis();
}

void startGatePulse() {
  if (gateSignalActive) {
    return;
  }

  smartPulseActive = false;
  activePulseMs = pulseMs;
  gateSignalOn();
  Serial.println("gate_signal=on");
}

void startSmartGatePulse() {
  if (gateSignalActive) {
    return;
  }

  const int closeRaw = analogRead(CLOSE_DETECTOR_PIN);
  const int openRaw = analogRead(OPEN_DETECTOR_PIN);
  smartCloseMin = closeRaw;
  smartCloseMax = closeRaw;
  smartOpenMin = openRaw;
  smartOpenMax = openRaw;
  smartPulseActive = true;
  gateSignalOn();
  Serial.println("smart_gate_signal=on");
}

bool cloudEnabled() {
  return FIREBASE_DEVICE_PASSWORD[0] != '\0';
}

uint64_t nowEpochMs() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < 1700000000) {
    return 0;
  }

  return (static_cast<uint64_t>(tv.tv_sec) * 1000ULL) + (static_cast<uint64_t>(tv.tv_usec) / 1000ULL);
}

String u64ToString(uint64_t value) {
  char buffer[24];
  snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
  return String(buffer);
}

String firebasePathUrl(const char *path) {
  String url = FIREBASE_DB_URL;
  url += "/";
  url += path;
  url += ".json?auth=";
  url += firebaseIdToken;
  return url;
}

bool firebaseSignIn() {
  if (!cloudEnabled() || WiFi.status() != WL_CONNECTED) {
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=";
  url += FIREBASE_API_KEY;

  if (!http.begin(client, url)) {
    return false;
  }

  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");

  JsonDocument request;
  request["email"] = FIREBASE_DEVICE_EMAIL;
  request["password"] = FIREBASE_DEVICE_PASSWORD;
  request["returnSecureToken"] = true;

  String body;
  serializeJson(request, body);
  const int code = http.POST(body);
  const String response = http.getString();
  http.end();

  if (code != 200) {
    Serial.print("firebase_signin_failed=");
    Serial.println(code);
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    return false;
  }

  firebaseIdToken = doc["idToken"].as<String>();
  firebaseTokenMs = millis();
  lastFirebaseOkMs = firebaseTokenMs;
  firebaseConsecutiveFailureCount = 0;
  Serial.println("firebase_signed_in");
  return firebaseIdToken.length() > 0;
}

bool ensureFirebaseAuth() {
  if (!cloudEnabled()) {
    return false;
  }

  if (firebaseIdToken.length() > 0 && millis() - firebaseTokenMs < FIREBASE_TOKEN_REFRESH_MS) {
    return true;
  }

  return firebaseSignIn();
}

int firebaseRequest(const char *method, const char *path, const String &body, String *response = nullptr) {
  firebaseRequestCount++;
  lastFirebaseMethod = method;
  lastFirebasePath = path;
  if (!ensureFirebaseAuth()) {
    firebaseRequestFailureCount++;
    firebaseConsecutiveFailureCount++;
    lastFirebaseFailureMethod = method;
    lastFirebaseFailurePath = path;
    return -1;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, firebasePathUrl(path))) {
    firebaseRequestFailureCount++;
    firebaseConsecutiveFailureCount++;
    lastFirebaseFailureMethod = method;
    lastFirebaseFailurePath = path;
    return -1;
  }

  http.setTimeout(5000);
  if (body.length() > 0 || strcmp(method, "PUT") == 0 || strcmp(method, "PATCH") == 0) {
    http.addHeader("Content-Type", "application/json");
  }

  int code = -1;
  if (strcmp(method, "GET") == 0) {
    code = http.GET();
  } else if (strcmp(method, "PUT") == 0) {
    code = http.PUT(body);
  } else if (strcmp(method, "PATCH") == 0) {
    code = http.PATCH(body);
  }

  if (response) {
    *response = http.getString();
  }

  http.end();

  if (code == 401 || code == 403) {
    firebaseIdToken = "";
    firebaseAuthFailureCount++;
  }

  if (code < 200 || code >= 300) {
    firebaseRequestFailureCount++;
    firebaseConsecutiveFailureCount++;
    lastFirebaseFailureMethod = method;
    lastFirebaseFailurePath = path;
  } else {
    lastFirebaseOkMs = millis();
    firebaseConsecutiveFailureCount = 0;
  }

  lastFirebaseCode = code;

  return code;
}

void firebasePutString(const char *path, const char *value) {
  String body = "\"";
  body += value;
  body += "\"";
  firebaseRequest("PUT", path, body);
}

void firebasePutNumber(const char *path, uint64_t value) {
  firebaseRequest("PUT", path, String(value));
}

void forceFirebaseRelogin(const char *reason) {
  firebaseIdToken = "";
  firebaseTokenMs = 0;
  firebaseAuthRecoveryCount++;
  lastCloudRecoveryReason = reason;
  lastCloudRecoveryMs = millis();
  Serial.print("firebase_reauth_recovery=");
  Serial.println(reason);
}

void forceWifiReconnect(const char *reason) {
  firebaseIdToken = "";
  firebaseTokenMs = 0;
  firebaseWifiRecoveryCount++;
  lastCloudRecoveryReason = reason;
  lastCloudRecoveryMs = millis();
  wifiConnectedSinceMs = 0;
  mdnsStarted = false;
  Serial.print("wifi_reconnect_recovery=");
  Serial.println(reason);

  WiFi.disconnect(false, false);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setHostname(HOSTNAME);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void cloudRecoveryWatchdog(unsigned long now) {
  if (!cloudEnabled() || gateSignalActive) {
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    wifiConnectedSinceMs = 0;
    return;
  }

  if (wifiConnectedSinceMs == 0) {
    wifiConnectedSinceMs = now;
  }

  const unsigned long lastGoodMs = lastFirebaseOkMs > 0 ? lastFirebaseOkMs : wifiConnectedSinceMs;
  const unsigned long staleMs = now - lastGoodMs;
  if (staleMs < FIREBASE_AUTH_RECOVERY_MS || now - lastCloudRecoveryMs < FIREBASE_RECOVERY_COOLDOWN_MS) {
    return;
  }

  if (staleMs >= FIREBASE_REBOOT_RECOVERY_MS) {
    firebaseRebootRecoveryCount++;
    lastCloudRecoveryReason = "firebase_stale_reboot";
    Serial.println("firebase_stale_reboot");
    delay(100);
    ESP.restart();
  }

  if (staleMs >= FIREBASE_WIFI_RECOVERY_MS) {
    forceWifiReconnect("firebase_stale_wifi_reconnect");
    return;
  }

  if (firebaseConsecutiveFailureCount > 0 || lastFirebaseOkMs == 0) {
    forceFirebaseRelogin("firebase_stale_reauth");
  }
}

void markCloudLogField(const String &path, const char *value) {
  firebasePutString(path.c_str(), value);
}

int firebasePatchJson(const String &path, JsonDocument &doc) {
  String body;
  serializeJson(doc, body);
  return firebaseRequest("PATCH", path.c_str(), body);
}

void writeCloudEvent(const String &id, const char *event, const char *reason) {
  if (id.length() == 0) {
    return;
  }
  const uint64_t nowMs = nowEpochMs();
  if (nowMs == 0) {
    return;
  }

  JsonDocument doc;
  doc["commandId"] = id;
  doc["event"] = event;
  doc["at"] = nowMs;
  doc["actor"] = "esp32";
  doc["sessionId"] = cloudCommandSessionId;
  doc["status"] = event;
  doc["reason"] = reason;

  String path = "gate/commandEvents/" + id + "/" + u64ToString(nowMs) + "_esp_" + event;
  String body;
  serializeJson(doc, body);
  firebaseRequest("PUT", path.c_str(), body);
}

void patchCommandSummary(const String &id, const String &requestedBy, const char *status, uint64_t doneAt, const char *reason) {
  JsonDocument doc;
  doc["status"] = status;
  doc["resultReason"] = reason;
  if (doneAt > 0) {
    doc["doneAt"] = doneAt;
  }

  String recordPath = "gate/commandRecords/" + id;
  firebasePatchJson(recordPath, doc);

  String logPath = "gate/logs/" + id;
  firebasePatchJson(logPath, doc);

  if (requestedBy.length() > 0) {
    String userLogPath = "userLogs/" + requestedBy + "/" + id;
    firebasePatchJson(userLogPath, doc);
  }
}

void publishCloudState(const char *reason) {
  const uint64_t nowMs = nowEpochMs();
  if (nowMs == 0) {
    return;
  }

  JsonDocument doc;
  doc["updatedAt"] = nowMs;
  doc["deviceLastSeen"] = nowMs;
  doc["liveCommandId"] = cloudCommandId;
  doc["lastCommandStatus"] = cloudCommandActive ? "active" : "";
  doc["lastReason"] = reason;
  doc["configRevision"] = configRevision;
  doc["lastFirebaseCode"] = lastFirebaseCode;
  doc["lastCommandPollCode"] = lastCommandPollCode;
  doc["lastCommandPollAt"] = lastCommandPollAt;
  doc["lastCommandPollOkAt"] = lastCommandPollOkAt;
  doc["firebaseRequestCount"] = firebaseRequestCount;
  doc["firebaseAuthFailureCount"] = firebaseAuthFailureCount;
  doc["firebaseRequestFailureCount"] = firebaseRequestFailureCount;
  doc["firebaseConsecutiveFailureCount"] = firebaseConsecutiveFailureCount;
  doc["firebaseAuthRecoveryCount"] = firebaseAuthRecoveryCount;
  doc["firebaseWifiRecoveryCount"] = firebaseWifiRecoveryCount;
  doc["firebaseRebootRecoveryCount"] = firebaseRebootRecoveryCount;
  doc["lastCloudRecoveryReason"] = lastCloudRecoveryReason;
  doc["lastFirebaseMethod"] = lastFirebaseMethod;
  doc["lastFirebasePath"] = lastFirebasePath;
  doc["lastFirebaseFailureMethod"] = lastFirebaseFailureMethod;
  doc["lastFirebaseFailurePath"] = lastFirebaseFailurePath;

  String body;
  serializeJson(doc, body);
  firebaseRequest("PATCH", "gate/state", body);
}

void finishCloudCommand(const char *status, const char *reason = "relay_finished") {
  if (!cloudCommandActive || cloudCommandId.length() == 0) {
    return;
  }

  const uint64_t nowMs = nowEpochMs();

  JsonDocument livePatch;
  livePatch["status"] = status;
  livePatch["resultReason"] = reason;
  if (nowMs > 0) {
    livePatch["doneAt"] = nowMs;
    livePatch["closedAt"] = nowMs;
  }
  firebasePatchJson("gate/liveCommand", livePatch);

  patchCommandSummary(cloudCommandId, cloudCommandRequestedBy, status, nowMs, reason);
  writeCloudEvent(cloudCommandId, status, reason);
  publishCloudState(reason);

  cloudCommandActive = false;
  cloudCommandId = "";
  cloudCommandRequestedBy = "";
  cloudCommandSessionId = "";
}

void updateCloudHeartbeat() {
  const uint64_t nowMs = nowEpochMs();
  if (nowMs == 0) {
    return;
  }

  JsonDocument doc;
  doc["lastSeen"] = nowMs;
  doc["ip"] = WiFi.localIP().toString();
  doc["firmware"] = FIRMWARE_VERSION;
  doc["lastFirebaseCode"] = lastFirebaseCode;
  doc["lastCommandPollCode"] = lastCommandPollCode;
  doc["lastCommandPollAt"] = lastCommandPollAt;
  doc["lastCommandPollOkAt"] = lastCommandPollOkAt;
  doc["firebaseRequestCount"] = firebaseRequestCount;
  doc["firebaseAuthFailureCount"] = firebaseAuthFailureCount;
  doc["firebaseRequestFailureCount"] = firebaseRequestFailureCount;
  doc["firebaseConsecutiveFailureCount"] = firebaseConsecutiveFailureCount;
  doc["firebaseAuthRecoveryCount"] = firebaseAuthRecoveryCount;
  doc["firebaseWifiRecoveryCount"] = firebaseWifiRecoveryCount;
  doc["firebaseRebootRecoveryCount"] = firebaseRebootRecoveryCount;
  doc["lastCloudRecoveryReason"] = lastCloudRecoveryReason;
  doc["lastFirebaseMethod"] = lastFirebaseMethod;
  doc["lastFirebasePath"] = lastFirebasePath;
  doc["lastFirebaseFailureMethod"] = lastFirebaseFailureMethod;
  doc["lastFirebaseFailurePath"] = lastFirebaseFailurePath;
  doc["configRevision"] = configRevision;
  doc["pulseMs"] = pulseMs;
  doc["heartbeatIdleMs"] = cloudHeartbeatIdleMs;
  doc["pollMs"] = cloudPollMs;
  doc["commandTimeoutMs"] = cloudCommandMaxAgeMs;
  doc["rssi"] = WiFi.RSSI();

  String body;
  serializeJson(doc, body);
  firebaseRequest("PATCH", "gate/device", body);
  publishCloudState(lastCloudReason.c_str());
}

void pollCloudConfig() {
  String response;
  const int code = firebaseRequest("GET", "gate/config/desired", "", &response);
  if (code != 200 || response == "null") {
    return;
  }

  JsonDocument desired;
  if (deserializeJson(desired, response)) {
    return;
  }

  const uint64_t revision = desired["revision"] | 0ULL;
  pulseMs = static_cast<unsigned long>(constrain(desired["pulseMs"] | DEFAULT_PULSE_MS, MIN_PULSE_MS, MAX_PULSE_MS));
  cloudHeartbeatIdleMs = static_cast<unsigned long>(constrain(desired["heartbeatIdleMs"] | DEFAULT_CLOUD_HEARTBEAT_IDLE_MS, 2000UL, 60000UL));
  cloudPollMs = static_cast<unsigned long>(constrain(desired["pollMs"] | DEFAULT_CLOUD_POLL_MS, 100UL, 5000UL));
  const unsigned long requestedTimeoutMs = desired["commandTimeoutMs"] | static_cast<unsigned long>(DEFAULT_CLOUD_COMMAND_MAX_AGE_MS);
  cloudCommandMaxAgeMs = static_cast<uint64_t>(constrain(requestedTimeoutMs, 500UL, 3000UL));
  configRevision = revision;

  JsonDocument reported;
  reported["pulseMs"] = pulseMs;
  reported["emergencyPulseMs"] = static_cast<unsigned long>(constrain(desired["emergencyPulseMs"] | MAX_CLOUD_PULSE_MS, MIN_PULSE_MS, MAX_CLOUD_PULSE_MS));
  reported["heartbeatIdleMs"] = cloudHeartbeatIdleMs;
  reported["pollMs"] = cloudPollMs;
  reported["commandTimeoutMs"] = cloudCommandMaxAgeMs;
  reported["revision"] = configRevision;
  reported["reportedAt"] = nowEpochMs();
  reported["firmware"] = FIRMWARE_VERSION;
  firebasePatchJson("gate/config/reported", reported);
}

void discardCloudCommand(const String &id, const String &requestedBy, const char *reason) {
  cloudCommandId = id;
  cloudCommandRequestedBy = requestedBy;
  cloudCommandSessionId = "";
  cloudCommandActive = true;
  finishCloudCommand("failed", reason);
  lastCloudReason = reason;
  Serial.println("cloud_command_discarded_busy");
}

void startCloudPulse(const JsonDocument &command) {
  cloudCommandId = command["id"].as<String>();
  cloudCommandRequestedBy = command["requestedBy"].as<String>();
  cloudCommandSessionId = command["sessionId"].as<String>();
  cloudCommandActive = true;

  const unsigned long duration = command["durationMs"] | pulseMs;
  activePulseMs = static_cast<unsigned long>(constrain(static_cast<long>(duration), MIN_PULSE_MS, MAX_CLOUD_PULSE_MS));

  const uint64_t nowMs = nowEpochMs();
  JsonDocument claimPatch;
  claimPatch["status"] = "active";
  claimPatch["resultReason"] = "esp_claimed";
  if (nowMs > 0) {
    claimPatch["espSeenAt"] = nowMs;
    claimPatch["activeAt"] = nowMs;
    claimPatch["relayOnAt"] = nowMs;
  }

  const int claimCode = firebasePatchJson("gate/liveCommand", claimPatch);
  if (claimCode < 200 || claimCode >= 300) {
    patchCommandSummary(cloudCommandId, cloudCommandRequestedBy, "failed", nowMs, "esp_claim_write_failed");
    writeCloudEvent(cloudCommandId, "failed", "esp_claim_write_failed");
    cloudCommandActive = false;
    cloudCommandId = "";
    cloudCommandRequestedBy = "";
    cloudCommandSessionId = "";
    lastCloudReason = "esp_claim_write_failed";
    return;
  }

  startGatePulse();
  Serial.println("cloud_gate_signal=on");
  lastCloudReason = "relay_on";
}

void pollCloudGate() {
  if (!cloudEnabled() || WiFi.status() != WL_CONNECTED) {
    return;
  }

  String response;
  lastCommandPollAt = nowEpochMs();
  const int code = firebaseRequest("GET", "gate/liveCommand", "", &response);
  lastCommandPollCode = code;
  if (code == 200) {
    lastCommandPollOkAt = lastCommandPollAt;
  }
  if (code != 200 || response == "null") {
    return;
  }

  JsonDocument command;
  if (deserializeJson(command, response)) {
    return;
  }

  const char *status = command["status"] | "";
  if (strcmp(status, "pending") != 0) {
    return;
  }

  const uint64_t nowMs = nowEpochMs();
  const uint64_t requestedAt = command["requestedAt"] | (command["requestedAtEsp"] | 0ULL);
  uint32_t ttlMs = command["ttlMs"] | cloudCommandMaxAgeMs;
  if (ttlMs == 0 || ttlMs > cloudCommandMaxAgeMs) {
    ttlMs = cloudCommandMaxAgeMs;
  }
  const uint64_t expiresAt = requestedAt + ttlMs;
  const String id = command["id"].as<String>();
  const String requestedBy = command["requestedBy"].as<String>();

  if (id.length() == 0 || requestedBy.length() == 0 || requestedAt == 0 || expiresAt == 0 ||
      (nowMs > 0 && (expiresAt <= nowMs || requestedAt > nowMs || nowMs - requestedAt > cloudCommandMaxAgeMs))) {
    discardCloudCommand(id, requestedBy, "expired_or_bad_timestamp");
    return;
  }

  // Commands created during the previous pulse are discarded after release.
  if (!cloudCommandActive && lastGateReleasedEpochMs > 0 && requestedAt > 0 && requestedAt <= lastGateReleasedEpochMs) {
    discardCloudCommand(id, requestedBy, "older_than_last_release");
    return;
  }

  if (gateSignalActive || cloudCommandActive) {
    discardCloudCommand(id, requestedBy, "relay_busy");
    return;
  }

  startCloudPulse(command);
}

bool scanWifi() {
  Serial.println("Scanning WiFi...");
  const int networkCount = WiFi.scanNetworks();

  if (networkCount <= 0) {
    Serial.println("No WiFi networks found");
    return false;
  }

  bool targetFound = false;
  for (int i = 0; i < networkCount; ++i) {
    Serial.print("WiFi network: ");
    Serial.print(WiFi.SSID(i));
    Serial.print(" RSSI=");
    Serial.print(WiFi.RSSI(i));
    Serial.print(" channel=");
    Serial.println(WiFi.channel(i));

    if (WiFi.SSID(i) == WIFI_SSID) {
      targetFound = true;
    }
  }

  return targetFound;
}

void startBackupAp() {
  if (apStarted) {
    return;
  }

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  apStarted = true;
  dnsServer.start(53, "*", WiFi.softAPIP());
  dnsStarted = true;

  Serial.print("Backup AP: ");
  Serial.println(AP_SSID);
  Serial.print("AP IP: ");
  Serial.println(WiFi.softAPIP());
}

void stopBackupAp() {
  if (!apStarted) {
    return;
  }

  dnsServer.stop();
  dnsStarted = false;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apStarted = false;
  mdnsStarted = false;
  Serial.println("Backup AP stopped; house WiFi connected");
}

const char WEBPAGE[] = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <title>Gate Local</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: Arial, sans-serif;
      text-align: center;
      margin: 0;
      padding: 48px 18px;
      background: #f5f7fb;
      color: #111827;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 34px;
    }

    .online {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 28px;
      font-size: 18px;
    }

    .dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #ef4444;
    }

    .dot.ok {
      background: #22c55e;
    }

    button {
      width: min(320px, 90vw);
      height: 132px;
      font-size: 34px;
      font-weight: 700;
      border-radius: 18px;
      border: 2px solid #111827;
      background: #e5e7eb;
      color: #111827;
      touch-action: manipulation;
    }

    button.active {
      background: #22c55e;
      color: white;
    }

    button.reboot {
      width: min(220px, 82vw);
      height: 58px;
      margin-top: 16px;
      font-size: 18px;
      border-color: #991b1b;
      background: #fee2e2;
      color: #991b1b;
    }

    button:disabled {
      opacity: 0.8;
    }

    .button-row {
      display: flex;
      justify-content: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .panel {
      max-width: 760px;
      margin: 26px auto 0;
      padding: 18px;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      background: white;
      text-align: left;
      font-size: 18px;
      line-height: 1.7;
    }

    .row {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      border-bottom: 1px solid #eef0f4;
      padding: 6px 0;
    }

    .row:last-child {
      border-bottom: 0;
    }

    canvas {
      display: block;
      width: 100%;
      height: 180px;
      margin-top: 10px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #0f172a;
    }

    .graph-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 16px;
      font-size: 15px;
      color: #4b5563;
    }

    .lamp {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #4b5563;
    }

    .lamp::before {
      content: "";
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #9ca3af;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
    }

    .lamp.active::before {
      background: #22c55e;
      box-shadow: 0 0 12px rgba(34,197,94,0.8);
    }

    input {
      width: 110px;
      font-size: 18px;
      padding: 6px;
    }

    .graph-wrap {
      position: relative;
    }

    .graph-tools {
      display: grid;
      grid-template-columns: 1fr 120px;
      gap: 12px;
      align-items: center;
      margin-top: 8px;
      font-size: 14px;
      color: #4b5563;
    }

    .graph-tools input[type="range"] {
      width: 100%;
    }

    .slider-stack {
      display: grid;
      gap: 4px;
      text-align: right;
    }

    .slider-stack strong {
      font-size: 13px;
      color: #111827;
    }

    .control-pair {
      display: grid;
      grid-template-columns: minmax(130px, 1fr) 90px;
      gap: 10px;
      align-items: center;
      width: min(280px, 48vw);
    }

    .control-pair input[type="range"] {
      width: 100%;
    }

    .control-pair input[type="number"] {
      width: 78px;
    }

    .scale {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-top: 6px;
      font-size: 13px;
      color: #6b7280;
    }

    .scale span:nth-child(2) {
      text-align: center;
    }

    .scale span:nth-child(3) {
      text-align: right;
    }
  </style>
</head>
<body>
  <h1>Gate Local</h1>
  <div class="online">
    <span id="onlineDot" class="dot"></span>
    <span id="onlineText">Offline</span>
  </div>
  <br>
  <div class="button-row">
    <button id="gate">GATE</button>
    <button id="smartGate">SMART GATE</button>
  </div>
  <button id="rebootEsp" class="reboot" type="button">Reboot ESP</button>

  <div class="panel">
    <div class="row"><span>Optocoupler GPIO32</span><strong id="gateSignal">--</strong></div>
    <div class="row"><span>Last command</span><strong id="lastCommand">--</strong></div>
    <div class="row"><span>OPEN raw GPIO34</span><strong id="openRaw">--</strong></div>
    <div class="row"><span>CLOSE raw GPIO35</span><strong id="closeRaw">--</strong></div>
    <div class="row"><span>Pulse length ms</span><input id="pulseInput" type="number" min="100" max="5000" step="50" value="1000"></div>
    <div class="row"><span>Smart timeout ms</span><input id="smartTimeoutInput" type="number" min="100" max="10000" step="50" value="3000"></div>
    <div class="row"><span>Poll ms</span><div class="control-pair"><input id="pollSlider" type="range" min="25" max="1000" step="25" value="100"><input id="pollInput" type="number" min="25" max="2000" step="25" value="100"></div></div>
    <div class="row"><span>CLOSE noise trigger</span><input id="closeNoiseTriggerInput" type="number" min="0" max="4095" step="25" value="800"></div>
    <div class="row"><span>OPEN noise trigger</span><input id="openNoiseTriggerInput" type="number" min="0" max="4095" step="25" value="800"></div>
    <div class="row"><span>Graph bottom value</span><input id="graphMinInput" type="number" min="0" max="4095" step="25" value="0"></div>
    <div class="row"><span>Graph top value</span><input id="graphMaxInput" type="number" min="0" max="4095" step="25" value="4095"></div>
    <div class="row"><span>CLOSE min / max / noise</span><strong id="closeStats">--</strong></div>
    <div class="row"><span>CLOSE active</span><strong id="closeActiveText">NO</strong></div>
    <div class="row"><span>OPEN min / max / noise</span><strong id="openStats">--</strong></div>
    <div class="row"><span>OPEN active</span><strong id="openActiveText">NO</strong></div>
    <div class="graph-label"><span>CLOSE GPIO35 raw feed</span><span id="closeLamp" class="lamp">active</span></div>
    <div class="graph-wrap">
      <canvas id="closeGraph" width="720" height="180"></canvas>
      <div id="closeScale" class="scale"><span>0</span><span>2048</span><span>4095</span></div>
      <div class="graph-tools">
        <label for="closeCenterInput">Move CLOSE worm up/down</label>
        <div class="slider-stack">
          <input id="closeCenterInput" type="range" min="0" max="4095" step="25" value="2048">
          <strong id="closeOffsetValue">offset 0</strong>
        </div>
      </div>
    </div>
    <div class="graph-label"><span>OPEN GPIO34 raw feed</span><span id="openLamp" class="lamp">active</span></div>
    <div class="graph-wrap">
      <canvas id="openGraph" width="720" height="180"></canvas>
      <div id="openScale" class="scale"><span>0</span><span>2048</span><span>4095</span></div>
      <div class="graph-tools">
        <label for="openCenterInput">Move OPEN worm up/down</label>
        <div class="slider-stack">
          <input id="openCenterInput" type="range" min="0" max="4095" step="25" value="2048">
          <strong id="openOffsetValue">offset 0</strong>
        </div>
      </div>
    </div>
  </div>

  <script>
    const gate = document.getElementById('gate');
    const smartGate = document.getElementById('smartGate');
    const rebootEsp = document.getElementById('rebootEsp');
    const onlineDot = document.getElementById('onlineDot');
    const onlineText = document.getElementById('onlineText');
    const gateSignal = document.getElementById('gateSignal');
    const lastCommand = document.getElementById('lastCommand');
    const closeRaw = document.getElementById('closeRaw');
    const openRaw = document.getElementById('openRaw');
    const pulseInput = document.getElementById('pulseInput');
    const smartTimeoutInput = document.getElementById('smartTimeoutInput');
    const pollSlider = document.getElementById('pollSlider');
    const pollInput = document.getElementById('pollInput');
    const closeGraph = document.getElementById('closeGraph');
    const openGraph = document.getElementById('openGraph');
    const closeScale = document.getElementById('closeScale');
    const openScale = document.getElementById('openScale');
    const closeLamp = document.getElementById('closeLamp');
    const openLamp = document.getElementById('openLamp');
    const closeNoiseTriggerInput = document.getElementById('closeNoiseTriggerInput');
    const openNoiseTriggerInput = document.getElementById('openNoiseTriggerInput');
    const graphMinInput = document.getElementById('graphMinInput');
    const graphMaxInput = document.getElementById('graphMaxInput');
    const closeStats = document.getElementById('closeStats');
    const openStats = document.getElementById('openStats');
    const closeActiveText = document.getElementById('closeActiveText');
    const openActiveText = document.getElementById('openActiveText');
    const closeCenterInput = document.getElementById('closeCenterInput');
    const openCenterInput = document.getElementById('openCenterInput');
    const closeOffsetValue = document.getElementById('closeOffsetValue');
    const openOffsetValue = document.getElementById('openOffsetValue');
    const closeSamples = [];
    const openSamples = [];
    const maxSamples = 180;
    let closeActive = false;
    let openActive = false;
    let closeActiveUntilMs = 0;
    let openActiveUntilMs = 0;
    let pollTimer = 0;

    function setOnline(on) {
      onlineDot.classList.toggle('ok', on);
      onlineText.textContent = on ? 'Online' : 'Offline';
    }

    function setGateActive(on) {
      gate.classList.toggle('active', on);
      smartGate.classList.toggle('active', on);
    }

    function clampPoll(value) {
      return Math.max(25, Math.min(2000, Number(value) || 100));
    }

    function syncPollFromSlider() {
      pollInput.value = String(clampPoll(pollSlider.value));
    }

    function syncPollFromInput() {
      const value = clampPoll(pollInput.value);
      pollInput.value = String(value);
      pollSlider.value = String(Math.max(25, Math.min(1000, value)));
    }

    function readGraphSpan() {
      let min = Math.max(0, Math.min(4095, Number(graphMinInput.value) || 0));
      let max = Math.max(0, Math.min(4095, Number(graphMaxInput.value) || 4095));
      if (max <= min) max = Math.min(4095, min + 1);
      return Math.max(1, max - min);
    }

    function readGraphScale() {
      let min = Math.max(0, Math.min(4095, Number(graphMinInput.value) || 0));
      let max = Math.max(0, Math.min(4095, Number(graphMaxInput.value) || 4095));
      if (max <= min) max = Math.min(4095, min + 1);
      return { min, max, mid: Math.round((min + max) / 2) };
    }

    function readNoiseTrigger(input) {
      const value = Number(input.value);
      if (Number.isNaN(value)) return 800;
      return Math.max(0, Math.min(4095, value));
    }

    function sampleStats(samples, currentRaw) {
      const pollMs = clampPoll(pollInput.value);
      const windowSamples = Math.max(2, Math.ceil(500 / pollMs));
      const recentSamples = samples.slice(-windowSamples);
      const values = recentSamples.length ? recentSamples : [Math.max(0, Math.min(4095, Number(currentRaw) || 0))];
      const minRaw = Math.min(...values);
      const maxRaw = Math.max(...values);
      return { currentRaw, minRaw, maxRaw, noiseAmount: maxRaw - minRaw };
    }

    function updateDetectorDisplay(stats, triggerInput, lamp, textEl, statsEl, activeUntilMs) {
      const trigger = readNoiseTrigger(triggerInput);
      const now = Date.now();
      if (stats.noiseAmount >= trigger) activeUntilMs = now + 500;
      const active = now < activeUntilMs;
      lamp.classList.toggle('active', active);
      textEl.textContent = active ? 'YES' : 'NO';
      statsEl.textContent = stats.minRaw + ' / ' + stats.maxRaw + ' / ' + stats.noiseAmount + ' trigger ' + trigger;
      return { active, activeUntilMs };
    }

    function pushSample(samples, value) {
      samples.push(Math.max(0, Math.min(4095, Number(value) || 0)));
      while (samples.length > maxSamples) samples.shift();
    }

    function drawGraph(canvas, scaleEl, centerInput, samples, color, currentValue) {
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      const scale = readGraphScale();
      const offsetControl = Math.max(0, Math.min(4095, Number(centerInput.value) || 2048));
      const offsetAdc = offsetControl - 2048;
      const wormOffsetY = -(offsetAdc / 2048) * (height * 0.45);
      if (centerInput === closeCenterInput) closeOffsetValue.textContent = 'offset ' + offsetAdc;
      if (centerInput === openCenterInput) openOffsetValue.textContent = 'offset ' + offsetAdc;
      scaleEl.children[0].textContent = String(scale.min);
      scaleEl.children[1].textContent = String(scale.mid);
      scaleEl.children[2].textContent = String(scale.max);

      function yFor(value, moveWorm) {
        const clamped = Math.max(scale.min, Math.min(scale.max, Number(value) || 0));
        const y = height - ((clamped - scale.min) / (scale.max - scale.min)) * height;
        return moveWorm ? Math.max(0, Math.min(height, y + wormOffsetY)) : y;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = Math.round((height / 4) * i);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '13px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(String(scale.max), 8, 15);
      ctx.fillText(String(scale.mid), 8, Math.round(height / 2) - 5);
      ctx.fillText(String(scale.min), 8, height - 8);
      ctx.textAlign = 'right';
      ctx.fillText(String(scale.max), width - 8, 15);
      ctx.fillText(String(scale.mid), width - 8, Math.round(height / 2) - 5);
      ctx.fillText(String(scale.min), width - 8, height - 8);
      ctx.textAlign = 'left';
      if (samples.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      samples.forEach((value, index) => {
        const x = (index / (maxSamples - 1)) * width;
        const y = yFor(value, true);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px Arial';
      ctx.fillText('now ' + currentValue, width - 92, 22);
    }

    async function sendPulse() {
      setGateActive(true);
      try {
        const value = Math.max(100, Math.min(5000, Number(pulseInput.value) || 1000));
        pulseInput.value = String(value);
        lastCommand.textContent = 'sending normal ' + value + ' ms';
        const response = await fetch('/pulse?ms=' + encodeURIComponent(String(value)), { cache: 'no-store' });
        const text = await response.text();
        lastCommand.textContent = 'normal ' + response.status + ' ' + text;
      } catch (error) {
        lastCommand.textContent = 'normal send failed';
        setGateActive(false);
      }
    }

    async function sendSmartPulse() {
      setGateActive(true);
      try {
        const timeout = Math.max(100, Math.min(10000, Number(smartTimeoutInput.value) || 3000));
        const closeTrigger = readNoiseTrigger(closeNoiseTriggerInput);
        const openTrigger = readNoiseTrigger(openNoiseTriggerInput);
        smartTimeoutInput.value = String(timeout);
        lastCommand.textContent = 'sending smart timeout ' + timeout + ' ms';
        const response = await fetch('/smart-pulse?timeout=' + encodeURIComponent(String(timeout)) + '&closeTrigger=' + encodeURIComponent(String(closeTrigger)) + '&openTrigger=' + encodeURIComponent(String(openTrigger)), { cache: 'no-store' });
        const text = await response.text();
        lastCommand.textContent = 'smart ' + response.status + ' ' + text;
      } catch (error) {
        lastCommand.textContent = 'smart send failed';
        setGateActive(false);
      }
    }

    async function rebootController() {
      if (!confirm('Reboot the ESP now?')) return;
      rebootEsp.disabled = true;
      lastCommand.textContent = 'rebooting ESP';
      try {
        const response = await fetch('/reboot', { method: 'POST', cache: 'no-store' });
        const text = await response.text();
        lastCommand.textContent = response.status + ' ' + text;
        setOnline(false);
      } catch (error) {
        lastCommand.textContent = 'reboot command sent';
        setOnline(false);
      }
    }

    async function updateStatus() {
      try {
        const response = await fetch('/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('status failed');
        const status = await response.json();
        setOnline(true);
        gateSignal.textContent = status.gateSignal ? 'ON' : 'OFF';
        closeRaw.textContent = String(status.closeDetectorRaw);
        openRaw.textContent = String(status.openDetectorRaw);
        pushSample(closeSamples, status.closeDetectorRaw);
        pushSample(openSamples, status.openDetectorRaw);
        drawGraph(closeGraph, closeScale, closeCenterInput, closeSamples, '#38bdf8', status.closeDetectorRaw);
        drawGraph(openGraph, openScale, openCenterInput, openSamples, '#f472b6', status.openDetectorRaw);
        const closeDetector = updateDetectorDisplay(sampleStats(closeSamples, status.closeDetectorRaw), closeNoiseTriggerInput, closeLamp, closeActiveText, closeStats, closeActiveUntilMs);
        const openDetector = updateDetectorDisplay(sampleStats(openSamples, status.openDetectorRaw), openNoiseTriggerInput, openLamp, openActiveText, openStats, openActiveUntilMs);
        closeActive = closeDetector.active;
        openActive = openDetector.active;
        closeActiveUntilMs = closeDetector.activeUntilMs;
        openActiveUntilMs = openDetector.activeUntilMs;
        if (document.activeElement !== pulseInput && Number(status.pulseMs) !== Number(pulseInput.value)) {
          pulseInput.value = String(status.pulseMs);
        }
        setGateActive(Boolean(status.gateSignal));
      } catch (error) {
        setOnline(false);
        gateSignal.textContent = 'offline';
        closeRaw.textContent = 'offline';
        openRaw.textContent = 'offline';
        setGateActive(false);
      } finally {
        const nextPoll = clampPoll(pollInput.value);
        pollTimer = setTimeout(updateStatus, nextPoll);
      }
    }

    gate.addEventListener('click', sendPulse);
    smartGate.addEventListener('click', sendSmartPulse);
    rebootEsp.addEventListener('click', rebootController);
    pollSlider.addEventListener('input', syncPollFromSlider);
    pollInput.addEventListener('change', syncPollFromInput);
    closeNoiseTriggerInput.addEventListener('input', () => {
      closeActiveUntilMs = 0;
    });
    openNoiseTriggerInput.addEventListener('input', () => {
      openActiveUntilMs = 0;
    });
    closeCenterInput.addEventListener('input', () => drawGraph(closeGraph, closeScale, closeCenterInput, closeSamples, '#38bdf8', closeRaw.textContent));
    openCenterInput.addEventListener('input', () => drawGraph(openGraph, openScale, openCenterInput, openSamples, '#f472b6', openRaw.textContent));
    pulseInput.addEventListener('change', async () => {
      const value = Math.max(100, Math.min(5000, Number(pulseInput.value) || 1000));
      pulseInput.value = String(value);
      try {
        await fetch('/pulse-ms?value=' + encodeURIComponent(String(value)), { cache: 'no-store' });
      } catch (error) {}
    });

    updateStatus();
  </script>
</body>
</html>
)rawliteral";

void handleRoot() {
  server.send(200, "text/html", WEBPAGE);
}

void handleCaptiveProbe() {
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

void handleReboot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "text/plain", "REBOOTING");
  delay(250);
  ESP.restart();
}

void handlePulse() {
  if (gateSignalActive) {
    server.send(409, "text/plain", "BUSY");
    return;
  }

  if (server.hasArg("ms")) {
    const long requested = server.arg("ms").toInt();
    pulseMs = static_cast<unsigned long>(constrain(requested, MIN_PULSE_MS, MAX_PULSE_MS));
  }

  startGatePulse();
  server.send(200, "text/plain", "PULSE");
}

void handlePulseMs() {
  if (server.hasArg("value")) {
    const long requested = server.arg("value").toInt();
    pulseMs = static_cast<unsigned long>(constrain(requested, MIN_PULSE_MS, MAX_PULSE_MS));
  }

  String json = "{\"pulseMs\":";
  json += pulseMs;
  json += "}";
  server.send(200, "application/json", json);
}

void handleSmartPulse() {
  if (gateSignalActive) {
    server.send(409, "text/plain", "BUSY");
    return;
  }

  if (server.hasArg("timeout")) {
    const long requested = server.arg("timeout").toInt();
    smartTimeoutMs = static_cast<unsigned long>(constrain(requested, MIN_SMART_TIMEOUT_MS, MAX_SMART_TIMEOUT_MS));
  }

  if (server.hasArg("closeTrigger")) {
    smartCloseTrigger = constrain(server.arg("closeTrigger").toInt(), 0, 4095);
  }

  if (server.hasArg("openTrigger")) {
    smartOpenTrigger = constrain(server.arg("openTrigger").toInt(), 0, 4095);
  }

  startSmartGatePulse();
  server.send(200, "text/plain", "SMART_PULSE");
}

void handleStatus() {
  const int closeRaw = analogRead(CLOSE_DETECTOR_PIN);
  const int openRaw = analogRead(OPEN_DETECTOR_PIN);

  String json = "{\"wifi\":";
  json += WiFi.status() == WL_CONNECTED ? "true" : "false";
  json += ",\"ip\":\"";
  json += WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
  json += "\",\"apIp\":\"";
  json += apStarted ? WiFi.softAPIP().toString() : "";
  json += "\",\"gateSignal\":";
  json += gateSignalActive ? "true" : "false";
  json += ",\"smartPulse\":";
  json += smartPulseActive ? "true" : "false";
  json += ",\"pulseMs\":";
  json += pulseMs;
  json += ",\"closeDetectorRaw\":";
  json += closeRaw;
  json += ",\"openDetectorRaw\":";
  json += openRaw;
  json += "}";
  server.send(200, "application/json", json);
}

void connectWifi() {
  if (apStarted) {
    WiFi.mode(WIFI_AP_STA);
    WiFi.disconnect(false, false);
    delay(100);
  } else {
    WiFi.disconnect(true, true);
    delay(300);
    WiFi.mode(WIFI_OFF);
    delay(300);
    WiFi.mode(WIFI_STA);
  }
  WiFi.persistent(false);
  WiFi.setHostname(HOSTNAME);
  WiFi.setSleep(false);

  if (!scanWifi()) {
    Serial.print("Target WiFi not visible: ");
    Serial.println(WIFI_SSID);
    startBackupAp();
    return;
  }

  WiFi.mode(apStarted ? WIFI_AP_STA : WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
}

void startNetworkServices() {
  if (WiFi.status() != WL_CONNECTED && !apStarted) {
    return;
  }

  if (WiFi.status() == WL_CONNECTED && !timeStarted) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    timeStarted = true;
    Serial.println("NTP requested");
  }

  if (!mdnsStarted) {
    mdnsStarted = apStarted || MDNS.begin(HOSTNAME);
    Serial.print("IP: ");
    Serial.println(apStarted ? WiFi.softAPIP() : WiFi.localIP());

    if (mdnsStarted) {
      Serial.print("mDNS: http://");
      Serial.print(HOSTNAME);
      Serial.println(".local");
    } else {
      Serial.println("mDNS failed");
    }
  }

  if (!otaStarted) {
    ArduinoOTA.setHostname(HOSTNAME);
    ArduinoOTA.begin();
    otaStarted = true;
    Serial.println("OTA ready");
  }
}

void setup() {
  pinMode(STATUS_LED_PIN, OUTPUT);
  pinMode(GATE_SIGNAL_PIN, OUTPUT);
  pinMode(CLOSE_DETECTOR_PIN, INPUT);
  pinMode(OPEN_DETECTOR_PIN, INPUT);

  digitalWrite(STATUS_LED_PIN, LOW);
  gateSignalOff();

  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("Gate local firmware");
  Serial.println("GPIO32 is the optocoupler gate signal output");

  connectWifi();

  server.on("/", handleRoot);
  server.on("/pulse", handlePulse);
  server.on("/open", handlePulse);
  server.on("/gate", handlePulse);
  server.on("/cycle", handlePulse);
  server.on("/smart-pulse", handleSmartPulse);
  server.on("/status", handleStatus);
  server.on("/pulse-ms", handlePulseMs);
  server.on("/reboot", HTTP_POST, handleReboot);
  server.on("/generate_204", handleCaptiveProbe);
  server.on("/gen_204", handleCaptiveProbe);
  server.on("/hotspot-detect.html", handleCaptiveProbe);
  server.on("/connecttest.txt", handleCaptiveProbe);
  server.on("/ncsi.txt", handleCaptiveProbe);
  server.on("/fwlink", handleCaptiveProbe);
  server.onNotFound(handleRoot);
  server.begin();
  Serial.println("Web server ready");
}

void loop() {
  const unsigned long now = millis();

  if (gateSignalActive) {
    if (smartPulseActive) {
      const int closeRaw = analogRead(CLOSE_DETECTOR_PIN);
      const int openRaw = analogRead(OPEN_DETECTOR_PIN);
      smartCloseMin = min(smartCloseMin, closeRaw);
      smartCloseMax = max(smartCloseMax, closeRaw);
      smartOpenMin = min(smartOpenMin, openRaw);
      smartOpenMax = max(smartOpenMax, openRaw);

      const bool closeStarted = smartCloseMax - smartCloseMin >= smartCloseTrigger;
      const bool openStarted = smartOpenMax - smartOpenMin >= smartOpenTrigger;
      const bool timedOut = now - gateSignalStartedMs >= smartTimeoutMs;

      if (closeStarted || openStarted || timedOut) {
        gateSignalOff();
        Serial.println("smart_gate_signal=off");
        finishCloudCommand(timedOut && !closeStarted && !openStarted ? "failed" : "done",
                           timedOut && !closeStarted && !openStarted ? "smart_timeout" : "smart_detector_moved");
      }
    } else if (now - gateSignalStartedMs >= activePulseMs) {
      gateSignalOff();
      Serial.println("gate_signal=off");
      finishCloudCommand("done", "relay_pulse_complete");
    }
  }

  if (WiFi.status() == WL_CONNECTED || apStarted) {
    if (WiFi.status() == WL_CONNECTED && apStarted) {
      stopBackupAp();
    }

    startNetworkServices();

    if (dnsStarted) {
      dnsServer.processNextRequest();
    }

    server.handleClient();

    if (otaStarted) {
      ArduinoOTA.handle();
    }

    if (WiFi.status() == WL_CONNECTED && now - lastCloudConfigPollMs >= CLOUD_CONFIG_POLL_MS) {
      lastCloudConfigPollMs = now;
      pollCloudConfig();
    }

    if (WiFi.status() == WL_CONNECTED && now - lastCloudHeartbeatMs >= cloudHeartbeatIdleMs) {
      lastCloudHeartbeatMs = now;
      updateCloudHeartbeat();
    }

    if (WiFi.status() == WL_CONNECTED && !gateSignalActive && now - lastCloudPollMs >= cloudPollMs) {
      lastCloudPollMs = now;
      pollCloudGate();
    }

    cloudRecoveryWatchdog(now);

    if (WiFi.status() != WL_CONNECTED && apStarted && now - lastWifiRetryMs >= WIFI_RETRY_MS) {
      lastWifiRetryMs = now;
      connectWifi();
    }
  } else if (!apStarted && now - lastWifiRetryMs >= WIFI_RETRY_MS) {
    lastWifiRetryMs = now;
    connectWifi();
  }
}
