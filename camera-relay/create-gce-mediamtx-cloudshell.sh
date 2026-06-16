#!/usr/bin/env bash
set -euo pipefail

# Run this in Google Cloud Shell, not on the local PC.
# It creates a small Compute Engine VM that pulls the DVR RTSP substream and
# exposes a browser-friendly MediaMTX HLS feed at /gate/index.m3u8.

PROJECT_ID="${PROJECT_ID:-gate-controller-1b092}"
VM_NAME="${VM_NAME:-gate-camera-relay}"
ZONE="${ZONE:-australia-southeast1-b}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
NETWORK_TAG="${NETWORK_TAG:-gate-camera-relay}"
RTSP_SOURCE="${RTSP_SOURCE:-rtsp://101.188.140.245:10554/user=admin&password=&channel=7&stream=1.sdp}"
FIREWALL_RULE="${FIREWALL_RULE:-allow-gate-camera-hls-8888}"

gcloud config set project "$PROJECT_ID"

echo "Enabling Compute Engine API..."
gcloud services enable compute.googleapis.com

if ! gcloud compute firewall-rules describe "$FIREWALL_RULE" >/dev/null 2>&1; then
  echo "Creating firewall rule $FIREWALL_RULE for HLS port 8888..."
  gcloud compute firewall-rules create "$FIREWALL_RULE" \
    --allow=tcp:8888 \
    --target-tags="$NETWORK_TAG" \
    --description="Allow MediaMTX HLS preview for gate camera"
else
  echo "Firewall rule $FIREWALL_RULE already exists."
fi

if gcloud compute instances describe "$VM_NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "VM $VM_NAME already exists in $ZONE. Updating metadata and restarting..."
  gcloud compute instances add-metadata "$VM_NAME" \
    --zone "$ZONE" \
    --metadata="rtsp-source=${RTSP_SOURCE}" \
    --metadata-from-file=startup-script=camera-relay/gce-startup-mediamtx.sh
  gcloud compute instances reset "$VM_NAME" --zone "$ZONE"
else
  echo "Creating VM $VM_NAME in $ZONE..."
  gcloud compute instances create "$VM_NAME" \
    --zone "$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=10GB \
    --tags="$NETWORK_TAG" \
    --metadata="rtsp-source=${RTSP_SOURCE}" \
    --metadata-from-file=startup-script=camera-relay/gce-startup-mediamtx.sh
fi

echo "Waiting for external IP..."
EXTERNAL_IP=""
for _ in {1..30}; do
  EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" \
    --zone "$ZONE" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
  if [[ -n "$EXTERNAL_IP" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$EXTERNAL_IP" ]]; then
  echo "VM was created but no external IP was found."
  exit 1
fi

echo
echo "MediaMTX relay VM:"
echo "  VM:        $VM_NAME"
echo "  Zone:      $ZONE"
echo "  Public IP: $EXTERNAL_IP"
echo
echo "HLS URL for gate-cloud/public/camera-config.js:"
echo "  http://${EXTERNAL_IP}:8888/gate/index.m3u8"
echo
echo "It can take 1-3 minutes after first boot before HLS responds."
echo "Check service logs with:"
echo "  gcloud compute ssh ${VM_NAME} --zone ${ZONE} --command 'sudo journalctl -u mediamtx -n 80 --no-pager'"
