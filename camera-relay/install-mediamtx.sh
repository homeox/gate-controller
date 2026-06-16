#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_DIR="$(mktemp -d)"
trap 'rm -rf "$ARCHIVE_DIR"' EXIT

if [[ ! -f /etc/mediamtx/mediamtx.yml ]]; then
  echo "Missing /etc/mediamtx/mediamtx.yml"
  echo "Copy camera-relay/mediamtx.yml.example there and set the RTSP source first."
  exit 1
fi

LATEST_TAG="$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest | sed -n 's/.*"tag_name": "\(v[^"]*\)".*/\1/p' | head -n 1)"
if [[ -z "$LATEST_TAG" ]]; then
  echo "Could not find latest MediaMTX release tag."
  exit 1
fi

VERSION="${LATEST_TAG#v}"
URL="https://github.com/bluenviron/mediamtx/releases/download/${LATEST_TAG}/mediamtx_${VERSION}_linux_amd64.tar.gz"

curl -fL "$URL" -o "$ARCHIVE_DIR/mediamtx.tar.gz"
tar -xzf "$ARCHIVE_DIR/mediamtx.tar.gz" -C "$ARCHIVE_DIR"

sudo install -m 0755 "$ARCHIVE_DIR/mediamtx" /usr/local/bin/mediamtx

sudo tee /etc/systemd/system/mediamtx.service >/dev/null <<'SERVICE'
[Unit]
Description=MediaMTX gate camera relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx
sudo systemctl status mediamtx --no-pager
