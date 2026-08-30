# Deploy via Cloud Shell

## 1. Open Cloud Console & Cloud Shell

1. Go to https://console.cloud.google.com
2. Click the terminal icon (`>_`) in the top toolbar
3. Run each step below

## 2. Set your project

```bash
gcloud config set project YOUR_PROJECT_ID
# ^ replace with your Firebase/GCP project ID
```

## 3. Create files

```bash
mkdir -p ~/mediamtx-cloudrun && cd ~/mediamtx-cloudrun

cat > Dockerfile << 'EOF'
FROM bluenviron/mediamtx:latest
COPY mediamtx.yml /mediamtx.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
EOF

cat > entrypoint.sh << 'EOF'
#!/bin/sh
set -e
PORT="${PORT:-8080}"
exec /mediamtx \
  --rtspDisable yes \
  --pprofDisable yes \
  --metricsDisable yes \
  --webrtcDisable yes \
  --hlsAddress :$PORT \
  --hlsAllowOrigin "*"
EOF

cat > mediamtx.yml << 'EOF'
rtsp: no
hls: yes
hlsSegmentCount: 6
hlsSegmentDuration: 2
hlsAllowOrigin: "*"
metrics: no
pprof: no
webrtc: no
paths:
  cam1_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch1/main/av_stream
    sourceProtocol: tcp
  cam1_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch1/sub/av_stream
    sourceProtocol: tcp
  cam2_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch2/main/av_stream
    sourceProtocol: tcp
  cam2_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch2/sub/av_stream
    sourceProtocol: tcp
  cam3_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch3/main/av_stream
    sourceProtocol: tcp
  cam3_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch3/sub/av_stream
    sourceProtocol: tcp
  cam4_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch4/main/av_stream
    sourceProtocol: tcp
  cam4_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch4/sub/av_stream
    sourceProtocol: tcp
  cam5_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch5/main/av_stream
    sourceProtocol: tcp
  cam5_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch5/sub/av_stream
    sourceProtocol: tcp
  cam6_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch6/main/av_stream
    sourceProtocol: tcp
  cam6_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch6/sub/av_stream
    sourceProtocol: tcp
  cam7_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch7/main/av_stream
    sourceProtocol: tcp
  cam7_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch7/sub/av_stream
    sourceProtocol: tcp
  cam8_main:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch8/main/av_stream
    sourceProtocol: tcp
  cam8_sub:
    source: rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_HOST}:${RTSP_PORT}/h264/ch8/sub/av_stream
    sourceProtocol: tcp
EOF
```

## 4. Build & push to Artifact Registry

```bash
# Enable APIs (first time only)
gcloud services enable artifactregistry.googleapis.com run.googleapis.com

# Create repo (first time only)
gcloud artifacts repositories create mediamtx \
  --repository-format=docker --location=us-central1

# Build and push
gcloud builds submit --tag us-central1-docker.pkg.dev/$(gcloud config get-value project)/mediamtx/mediamtx-cloudrun:latest .
```

## 5. Deploy to Cloud Run

```bash
gcloud run deploy mediamtx-cloudrun \
  --image=us-central1-docker.pkg.dev/$(gcloud config get-value project)/mediamtx/mediamtx-cloudrun:latest \
  --region=us-central1 \
  --allow-unauthenticated \
  --memory=256Mi --cpu=1 --timeout=300 --concurrency=100 \
  --no-cpu-throttling \
  --set-env-vars="RTSP_HOST=101.188.140.245,RTSP_PORT=10554,RTSP_USER=rick,RTSP_PASS=2017"
```

## 6. Get the URL

```bash
gcloud run services describe mediamtx-cloudrun --region=us-central1 --format="value(status.url)"
```

## 7. Update web app

Edit `gate-cloud/public/camera-config.js` — replace the `hlsUrl` value with:
```
https://MEDIAMTX_CLOUDRUN_URL/cam1_main/index.m3u8
```

Then redeploy hosting:
```bash
cd gate-cloud
firebase deploy --only hosting
```
