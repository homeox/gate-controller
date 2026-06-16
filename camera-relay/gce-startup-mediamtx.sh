#!/usr/bin/env bash
set -euo pipefail

RTSP_SOURCE="$(curl -fsS -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/rtsp-source')"

if [[ -z "$RTSP_SOURCE" ]]; then
  echo "Missing rtsp-source VM metadata."
  exit 1
fi

apt-get update
apt-get install -y curl ca-certificates tar

install -d -m 0755 /etc/mediamtx /opt/mediamtx

LATEST_TAG="$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest \
  | sed -n 's/.*"tag_name": "\(v[^"]*\)".*/\1/p' \
  | head -n 1)"

if [[ -z "$LATEST_TAG" ]]; then
  echo "Could not resolve latest MediaMTX release."
  exit 1
fi

VERSION="${LATEST_TAG#v}"
ARCHIVE="/tmp/mediamtx.tar.gz"
URL="https://github.com/bluenviron/mediamtx/releases/download/${LATEST_TAG}/mediamtx_${VERSION}_linux_amd64.tar.gz"

curl -fL "$URL" -o "$ARCHIVE"
tar -xzf "$ARCHIVE" -C /opt/mediamtx
install -m 0755 /opt/mediamtx/mediamtx /usr/local/bin/mediamtx

cat >/etc/mediamtx/mediamtx.yml <<EOF
logLevel: info

hls: true
hlsAddress: :8888
hlsAllowOrigins: ["*"]
hlsVariant: lowLatency

webrtc: false

paths:
  gate:
    source: ${RTSP_SOURCE}
    sourceOnDemand: true
EOF

cat >/etc/systemd/system/mediamtx.service <<'SERVICE'
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

systemctl daemon-reload
systemctl enable --now mediamtx
