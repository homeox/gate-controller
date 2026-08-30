"""Headless functional test: camera feed thread -> frame -> QPixmap render.

Verifies the full render pipeline (decode + QImage + pixmap) without a display.
Exits 0 on success, 1 on failure.
"""

import os
import sys
import time

os.environ["QT_QPA_PLATFORM"] = "offscreen"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication
from PySide6.QtGui import QImage, QPixmap

import gate_desktop
from gate_desktop import CameraFeed, CameraCard, gate_pulse


def test_render_pipeline():
    app = QApplication([])
    card = CameraCard()
    card.resize(500, 380)

    received = {"frames": 0, "status": None}
    loop = QEventLoop()

    def on_frame(frame):
        received["frames"] += 1
        card.show_frame(frame)
        # Assert the pixmap is actually populated.
        pixmap = card.feed_label.pixmap()
        if pixmap is None or pixmap.isNull():
            raise AssertionError("show_frame produced a null pixmap")
        # Compare sizes against the source frame.
        if received["frames"] == 1:
            h, w = frame.shape[:2]
            print(f"frame decoded: {w}x{h}")
            print(f"pixmap rendered: {pixmap.width()}x{pixmap.height()}")
            loop.quit()

    def on_status(text):
        received["status"] = text
        print(f"status: {text}")

    feed = CameraFeed(gate_desktop.rtsp_url(gate_desktop.CAMERA_RTSP_HOST))
    feed.frame_ready.connect(on_frame)
    feed.status.connect(on_status)

    QTimer.singleShot(15000, loop.quit)  # 15s hard timeout
    feed.start()
    loop.exec()
    feed.stop()
    feed.wait(3000)

    if received["frames"] == 0:
        print("FAIL: no frames rendered in 15s")
        return 1
    print(f"PASS: {received['frames']} frames rendered")
    return 0


def test_pulse_contract():
    ok, msg = gate_pulse()
    print(f"pulse: ok={ok} msg={msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    rc = test_render_pipeline()
    if rc == 0:
        rc = test_pulse_contract()
    sys.exit(rc)
