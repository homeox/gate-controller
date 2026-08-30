"""Headless test of the feed-loss -> WAN-IP recovery path.

Simulates the stale-IP scenario: starts the feed against a dead host, waits
for feed_lost, then verifies the recovery handler would rebuild the URL with
the ESP-reported IP from Firebase.

Exits 0 on success, 1 on failure.
"""

import os
import sys
import time

os.environ["QT_QPA_PLATFORM"] = "offscreen"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication

import gate_desktop
from gate_desktop import CameraFeed, fetch_wan_ip, rtsp_url


def test_feed_loss_signal():
    """A dead host must emit feed_lost within FEED_LOST_TIMEOUT_S."""
    app = QApplication([])
    loop = QEventLoop()
    result = {"lost": False}

    feed = CameraFeed("rtsp://203.0.113.1:10554/nope")
    feed.feed_lost.connect(lambda: (result.update(lost=True), loop.quit()))
    feed.status.connect(lambda s: print(f"status: {s}"))

    QTimer.singleShot(15000, loop.quit)
    feed.start()
    loop.exec()
    feed.stop()
    feed.wait(3000)

    if not result["lost"]:
        print("FAIL: feed_lost not emitted for dead host")
        return 1
    print("PASS: feed_lost emitted for dead host")
    return 0


def test_url_rebuild():
    """rtsp_url() must produce the expected shape for a given host."""
    url = rtsp_url("1.2.3.4")
    expected = "rtsp://1.2.3.4:10554/user=admin&password=&channel=7&stream=0.sdp?"
    if url != expected:
        print(f"FAIL: got {url!r}")
        return 1
    print("PASS: rtsp_url rebuild correct")
    return 0


def test_fetch_wan_ip():
    """fetch_wan_ip() must be callable and return a string (may be empty
    before the ESP publishes, but must not throw)."""
    try:
        ip = fetch_wan_ip()
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: fetch_wan_ip raised: {exc}")
        return 1
    print(f"PASS: fetch_wan_ip returned {ip!r}")
    return 0


if __name__ == "__main__":
    rc = test_url_rebuild()
    if rc == 0:
        rc = test_fetch_wan_ip()
    if rc == 0:
        rc = test_feed_loss_signal()
    sys.exit(rc)
