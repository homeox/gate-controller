"""GateCam desktop - standalone gate controller.

Single-window app: live DVR camera feed (RTSP via OpenCV) + one-tap gate pulse
that talks directly to Firebase. No web shell, no relay server.

The RTSP feed self-heals: if the feed is lost (e.g. the ISP reassigns the home
WAN IP), the app asks the ESP32 via Firebase (gate/network/wanIp), rebuilds the
feed URL with the current WAN IP, and reconnects.

Credits: PySide6 (UI) + OpenCV (RTSP/H.265 decode).

Run:  python gate_desktop.py
"""

from __future__ import annotations

import threading
import time
import urllib.request
import urllib.parse
import uuid
import json

import cv2
from PySide6.QtCore import Qt, QTimer, Signal, QThread
from PySide6.QtGui import QImage, QPixmap, QColor, QFont
from PySide6.QtWidgets import (
    QApplication,
    QWidget,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QHBoxLayout,
    QFrame,
    QSizePolicy,
)

import secrets  # local module: Firebase credentials (gitignored)

# Fallback home WAN IP for the DVR RTSP feed. The app replaces the IP with the
# ESP-reported value from Firebase whenever the feed is lost.
CAMERA_RTSP_HOST = "101.183.230.99"
CAMERA_RTSP_PATH = "/user=admin&password=&channel=7&stream=0.sdp?"
CAMERA_RTSP_PORT = "10554"


def rtsp_url(host: str) -> str:
    return f"rtsp://{host}:{CAMERA_RTSP_PORT}{CAMERA_RTSP_PATH}"


class CameraFeed(QThread):
    """Decodes the RTSP stream in a background thread and emits frames.

    If the stream cannot be opened, or stops delivering frames for longer
    than FEED_LOST_TIMEOUT_S, emits feed_lost and exits so the app can
    re-discover the WAN IP and reconnect.
    """

    frame_ready = Signal(object)  # numpy BGR frame
    status = Signal(str)
    feed_lost = Signal()

    FEED_LOST_TIMEOUT_S = 8.0
    OPEN_TIMEOUT_MS = 4000
    READ_TIMEOUT_MS = 4000

    def __init__(self, url: str, parent=None) -> None:
        super().__init__(parent)
        self._url = url
        self._running = True
        self._cap: cv2.VideoCapture | None = None

    def stop(self) -> None:
        """Signal the thread to stop and unblock a pending read().

        cap.release() forces any blocked cap.read() to return immediately,
        so the thread never hangs on a dead RTSP connection during shutdown.
        """
        self._running = False
        cap = self._cap
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass

    def run(self) -> None:
        # Bounded open/read timeouts: a dead or stale RTSP host (e.g. after
        # the ISP reassigns the WAN IP) must return within a few seconds so
        # the app can re-discover the IP and reconnect. Without these, the
        # ffmpeg stack can block read() for 20s+.
        cap = cv2.VideoCapture(
            self._url,
            cv2.CAP_FFMPEG,
            [
                cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, self.OPEN_TIMEOUT_MS,
                cv2.CAP_PROP_READ_TIMEOUT_MSEC, self.READ_TIMEOUT_MS,
            ],
        )
        self._cap = cap
        if not cap.isOpened():
            self.status.emit("CAMERA OFFLINE")
            self.feed_lost.emit()
            return
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.status.emit("CONNECTING")
        last_frame_at = time.monotonic()
        while self._running:
            try:
                ok, frame = cap.read()
            except cv2.error:
                ok = False
                frame = None
            if not ok or frame is None:
                if not self._running:
                    break
                if time.monotonic() - last_frame_at > self.FEED_LOST_TIMEOUT_S:
                    self.status.emit("CAMERA OFFLINE")
                    self.feed_lost.emit()
                    break
                time.sleep(0.5)
                continue
            last_frame_at = time.monotonic()
            # Keep a modest frame rate for the UI.
            self.frame_ready.emit(frame)
            time.sleep(0.05)
        cap.release()
        self._cap = None


class GatePulseThread(QThread):
    """Sends one gate command intent to Firebase on a worker thread."""

    result = Signal(bool, str)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)

    def run(self) -> None:
        try:
            ok, msg = gate_pulse()
            self.result.emit(ok, msg)
        except Exception as exc:  # noqa: BLE001 - surface anything to the UI
            self.result.emit(False, str(exc)[:120])


def firebase_sign_in() -> dict:
    """Sign in to Firebase Identity Toolkit and return the auth payload."""
    signin_body = json.dumps(
        {
            "email": secrets.EMAIL,
            "password": secrets.PASSWORD,
            "returnSecureToken": True,
        }
    ).encode()
    signin_url = (
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
        f"?key={secrets.FIREBASE_API_KEY}"
    )
    req = urllib.request.Request(
        signin_url,
        data=signin_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def fetch_wan_ip() -> str:
    """Ask the ESP (via Firebase) for the current home WAN IP.

    The ESP publishes gate/network/wanIp on a slow timer. Returns "" if the
    ESP has not reported yet or the read fails.
    """
    auth = firebase_sign_in()
    db_url = (
        f"{secrets.RTDB_URL}/gate/network/wanIp.json"
        f"?auth={urllib.parse.quote(auth['idToken'])}"
    )
    req = urllib.request.Request(db_url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        text = resp.read().decode().strip()
    if not text or text == "null":
        return ""
    value = json.loads(text)
    return str(value).strip() if value else ""


def gate_pulse() -> tuple[bool, str]:
    """Sign in to Firebase and write a command intent.

    Contract (mirrors the Android app / cloud functions):
    - POST to identitytoolkit signInWithPassword
    - PUT command intent to /gate/commandRequests/{id} with id == path key
    - Never authors timing fields; Firebase stamps requestedAt/expiresAt.
    """
    auth = firebase_sign_in()
    id_token = auth["idToken"]
    uid = auth["localId"]

    # 2. Write the command intent.
    command_id = uuid.uuid4().hex
    request = {
        "id": command_id,
        "type": "pulse",
        "status": "pending",
        "sessionId": "gatecam-desktop",
        "requestedBy": uid,
        "requestedByName": "Richard",
    }
    db_url = (
        f"{secrets.RTDB_URL}/gate/commandRequests/{command_id}.json"
        f"?auth={urllib.parse.quote(id_token)}"
    )
    req = urllib.request.Request(
        db_url,
        data=json.dumps(request).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()
    return True, "PULSE SENT"


class CameraCard(QFrame):
    """Rounded dark card holding the camera feed."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("cameraCard")
        self.setMinimumHeight(320)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)

        self.feed_label = QLabel("CAMERA VIEW")
        self.feed_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.feed_label.setStyleSheet("color: #8CA0B3; font-size: 14px;")
        layout.addWidget(self.feed_label, 1)

        self.status_label = QLabel("CONNECTING")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_label.setStyleSheet("color: #8CA0B3; font-size: 11px;")
        layout.addWidget(self.status_label)

    def show_frame(self, frame) -> None:
        h, w, _ = frame.shape
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = QImage(rgb.data, w, h, rgb.strides[0], QImage.Format.Format_RGB888)
        # Scale to the label while keeping aspect ratio.
        label_size = self.feed_label.size()
        if label_size.width() > 0 and label_size.height() > 0:
            scaled = image.scaled(
                label_size,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        else:
            scaled = image
        self.feed_label.setPixmap(QPixmap.fromImage(scaled))

    def show_status(self, text: str) -> None:
        self.status_label.setText(text)


class MainWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("GATE CONTROLLER")
        self.resize(560, 760)
        self.setMinimumSize(420, 600)
        self.setStyleSheet("background-color: #10161E;")

        self.camera = CameraCard(self)
        self.gate_button = QPushButton("GATE")
        self.gate_button.setFixedSize(170, 170)
        self.gate_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.gate_button.setFont(QFont("Segoe UI", 13, QFont.Weight.Bold))
        self.gate_button.setStyleSheet(
            """
            QPushButton {
                background-color: #22C55E;
                color: white;
                border: none;
                border-radius: 85px;
            }
            QPushButton:hover { background-color: #27D96A; }
            QPushButton:pressed { background-color: #1A9C49; }
            QPushButton:disabled { background-color: #166534; }
            """
        )
        self.gate_button.clicked.connect(self.send_pulse)

        title = QLabel("GATE CONTROLLER")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setStyleSheet("color: white; font-size: 17px; font-weight: 600; letter-spacing: 3px;")
        title.setContentsMargins(0, 8, 0, 0)

        button_row = QHBoxLayout()
        button_row.addStretch(1)
        button_row.addWidget(self.gate_button)
        button_row.addStretch(1)

        root = QVBoxLayout(self)
        root.setContentsMargins(20, 20, 20, 24)
        root.addWidget(title)
        root.addSpacing(12)
        root.addWidget(self.camera, 1)
        root.addSpacing(8)
        root.addLayout(button_row)

        # Camera thread.
        self.current_wan_ip = CAMERA_RTSP_HOST
        self.feed_thread = CameraFeed(rtsp_url(self.current_wan_ip), self)
        self.feed_thread.frame_ready.connect(self.camera.show_frame)
        self.feed_thread.status.connect(self.camera.show_status)
        self.feed_thread.feed_lost.connect(self.recover_feed)
        self.feed_thread.start()

        # Gate pulse worker (reused).
        self.pulse_thread: GatePulseThread | None = None
        self.recovering = False

    def recover_feed(self) -> None:
        """Called when the camera feed is lost: ask the ESP (via Firebase) for
        the current WAN IP, rebuild the feed URL, and reconnect."""
        if self.recovering:
            return
        self.recovering = True
        self.camera.show_status("RECONNECTING…")

        def do_recover() -> None:
            try:
                new_ip = fetch_wan_ip()
            except Exception as exc:  # noqa: BLE001
                self.camera.show_status(f"IP CHECK FAILED: {str(exc)[:60]}")
                self.recovering = False
                return
            if new_ip and new_ip != self.current_wan_ip:
                self.current_wan_ip = new_ip
            # Restart the feed against the (possibly refreshed) IP.
            self.feed_thread.stop()
            self.feed_thread.wait(3000)
            self.feed_thread = CameraFeed(rtsp_url(self.current_wan_ip), self)
            self.feed_thread.frame_ready.connect(self.camera.show_frame)
            self.feed_thread.status.connect(self.camera.show_status)
            self.feed_thread.feed_lost.connect(self.recover_feed)
            self.feed_thread.start()
            self.recovering = False

        QTimer.singleShot(0, do_recover)

    def send_pulse(self) -> None:
        if self.pulse_thread is not None and self.pulse_thread.isRunning():
            return
        self.gate_button.setEnabled(False)
        self.camera.show_status("SENDING PULSE")
        self.pulse_thread = GatePulseThread(self)
        self.pulse_thread.result.connect(self.on_pulse_result)
        self.pulse_thread.start()

    def on_pulse_result(self, ok: bool, message: str) -> None:
        self.gate_button.setEnabled(True)
        text = message if ok else f"PULSE FAILED: {message}"
        self.camera.show_status(text)

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt naming
        # Stop the camera thread and unblock any pending read().
        self.feed_thread.stop()
        self.feed_thread.wait(3000)
        if self.pulse_thread is not None:
            self.pulse_thread.wait(3000)
        super().closeEvent(event)
        # Hard-exit so no thread ever survives the window close. If the camera
        # thread is stuck inside the ffmpeg stack, os._exit is the only
        # guaranteed way to avoid a hanging pythonw process.
        import os

        os._exit(0)


def main() -> None:
    app = QApplication([])
    window = MainWindow()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
