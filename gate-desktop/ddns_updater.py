"""DuckDNS WAN-IP updater for the GateCam feed.

Keeps a free DuckDNS hostname pointing at the current home WAN IP, so the
apps never hardcode a stale IP. Runs every few minutes via Task Scheduler.

Behavior:
- Fetch current WAN IP from ipify (no account needed).
- If it differs from the last recorded IP, call the DuckDNS update API.
- Never touch DuckDNS when the IP is unchanged (keeps the free quota happy).

Config lives in ddns_config.py (gitignored) - create from ddns_config.example.py.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.parse

import ddns_config  # local module: domain + token (gitignored)

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ddns_state.json")
IPIFY_URL = "https://api.ipify.org?format=json"
DUCKDNS_URL = "https://www.duckdns.org/update"


def current_wan_ip() -> str:
    """Ask ipify for the current public IP."""
    with urllib.request.urlopen(IPIFY_URL, timeout=15) as resp:
        return json.loads(resp.read().decode()).get("ip", "").strip()


def last_known_ip() -> str:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh).get("ip", "")
    except (OSError, ValueError):
        return ""


def save_ip(ip: str) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as fh:
        json.dump({"ip": ip, "updatedAt": int(time.time())}, fh)


def update_duckdns(ip: str) -> str:
    """Tell DuckDNS to point the domain at ip. Returns the response text."""
    query = urllib.parse.urlencode(
        {"domains": ddns_config.DOMAIN, "token": ddns_config.TOKEN, "ip": ip}
    )
    with urllib.request.urlopen(f"{DUCKDNS_URL}?{query}", timeout=15) as resp:
        return resp.read().decode().strip()


def main() -> int:
    try:
        ip = current_wan_ip()
    except Exception as exc:  # noqa: BLE001 - transient network, report and exit
        print(f"WAN IP lookup failed: {exc}")
        return 1

    if not ip:
        print("Empty WAN IP response")
        return 1

    if ip == last_known_ip():
        print(f"IP unchanged ({ip}) - no update needed")
        return 0

    try:
        result = update_duckdns(ip)
    except Exception as exc:  # noqa: BLE001
        print(f"DuckDNS update failed: {exc}")
        return 1

    if result == "OK":
        save_ip(ip)
        print(f"DuckDNS updated: {ddns_config.DOMAIN}.duckdns.org -> {ip}")
        return 0

    print(f"DuckDNS rejected update: {result!r}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
