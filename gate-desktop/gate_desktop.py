"""GateCam desktop - standalone gate controller.

Single-window app: live DVR camera feed (RTSP via OpenCV) + one-tap gate pulse
that talks directly to Firebase. No web shell, no relay server.

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

CAMERA_RTSP_URL = "rtsp://101.183.193.134:10554/user=admin&password=&channel=7&stream=0.sdp?"


class CameraFeed(QThread):
    """Decodes the RTSP stream in a background thread and emits frames."""

    frame_ready = Signal(object)  # numpy BGR frame
    status = Signal(str)

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
        cap = cv2.VideoCapture(self._url, cv2.CAP_FFMPEG)
        self._cap = cap
        if not cap.isOpened():
            self.status.emit("CAMERA OFFLINE")
            return
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.status.emit("CONNECTING")
        while self._running:
            try:
                ok, frame = cap.read()
            except cv2.error:
                ok = False
                frame = None
            if not ok or frame is None:
                if not self._running:
                    break
                time.sleep(0.5)
                continue
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


def gate_pulse() -> tuple[bool, str]:
    """Sign in to Firebase and write a command intent.

    Contract (mirrors the Android app / cloud functions):
    - POST to identitytoolkit signInWithPassword
    - PUT command intent to /gate/commandRequests/{id} with id == path key
    - Never authors timing fields; Firebase stamps requestedAt/expiresAt.
    """
    # 1. Sign in.
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
        auth = json.loads(resp.read().decode())

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
        self.feed_thread = CameraFeed(CAMERA_RTSP_URL, self)
        self.feed_thread.frame_ready.connect(self.camera.show_frame)
        self.feed_thread.status.connect(self.camera.show_status)
        self.feed_thread.start()

        # Gate pulse worker (reused).
        self.pulse_thread: GatePulseThread | None = None

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
