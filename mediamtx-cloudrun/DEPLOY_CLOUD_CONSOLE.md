# Deploy MediaMTX to Cloud Run via Cloud Console

## Prerequisites

- DVR RTSP accessible on `101.188.140.245:10554` (already forwarded)
- GCP project with billing enabled
- Artifact Registry API + Cloud Run API enabled

## Steps

### 1. Open Cloud Shell

Go to https://console.cloud.google.com → click the terminal icon (>_) in the top bar.

### 2. Clone or create files

```bash
# Create directory
mkdir -p ~/mediamtx-cloudrun && cd ~/mediamtx-cloudrun

# Create each file
cat > Dockerfile << 'DOCKEREOF'
FROM bluenviron/mediamtx:latest

COPY mediamtx.yml /mediamtx.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
DOCKEREOF

cat > mediamtx.yml << 'YAMLEOF'
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
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch1/main/av_stream
    sourceProtocol: tcp
  cam1_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch1/sub/av_stream
    sourceProtocol: tcp
  cam2_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch2/main/av_stream
    sourceProtocol: tcp
  cam2_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch2/sub/av_stream
    sourceProtocol: tcp
  cam3_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch3/main/av_stream
    sourceProtocol: tcp
  cam3_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch3/sub/av_stream
    sourceProtocol: tcp
  cam4_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch4/main/av_stream
    sourceProtocol: tcp
  cam4_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch4/sub/av_stream
    sourceProtocol: tcp
  cam5_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch5/main/av_stream
    sourceProtocol: tcp
  cam5_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch5/sub/av_stream
    sourceProtocol: tcp
  cam6_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch6/main/av_stream
    sourceProtocol: tcp
  cam6_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch6/sub/av_stream
    sourceProtocol: tcp
  cam7_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch7/main/av_stream
    sourceProtocol: tcp
  cam7_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch7/sub/av_stream
    sourceProtocol: tcp
  cam8_main:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch8/main/av_stream
    sourceProtocol: tcp
  cam8_sub:
    source: rtsp://rick:2017@101.188.140.245:10554/h264/ch8/sub/av_stream
    sourceProtocol: tcp
YAMLEOF

cat > entrypoint.sh << 'ENTRYEOF'
#!/bin/sh
set -e
PORT="${PORT:-8080}"
exec /mediamtx \
  --config /mediamtx.yml \
  --rtspDisable yes \
  --pprofDisable yes \
  --metricsDisable yes \
  --webrtcDisable yes \
  --hlsAddress :$PORT \
  --hlsAllowOrigin "*"
ENTRYEOF
```

### 3. Build and push to Artifact Registry

```bash
# Create Artifact Registry repo
gcloud artifacts repositories create mediamtx \
  --repository-format=docker \
  --location=us-central1

# Build and push
gcloud builds submit --tag us-central1-docker.pkg.dev/$(gcloud config get-value project)/mediamtx/mediamtx-cloudrun:latest
```

### 4. Deploy to Cloud Run

```bash
gcloud run deploy mediamtx-cloudrun \
  --image=us-central1-docker.pkg.dev/$(gcloud config get-value project)/mediamtx/mediamtx-cloudrun:latest \
  --region=us-central1 \
  --platform=managed \
  --allow-unauthenticated \
  --memory=256Mi \
  --cpu=1 \
  --timeout=300 \
  --concurrency=100 \
  --no-cpu-throttling
```

### 5. Get the URL

```bash
gcloud run services describe mediamtx-cloudrun \
  --region=us-central1 \
  --format="value(status.url)"
```

### 6. Update web app

Edit `gate-cloud/public/camera-config.js` and replace the `hlsUrl` with:
```
https://MEDIAMTX_CLOUDRUN_URL/cam1_main/index.m3u8
```

Then redeploy Firebase:
```bash
cd gate-cloud
firebase deploy --only hosting
```

## Testing

Visit `https://MEDIAMTX_CLOUDRUN_URL/cam1_main/index.m3u8` in a browser — it should download an m3u8 playlist if MediaMTX is connected to the DVR.
