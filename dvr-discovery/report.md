# DVR/XVR Discovery Report

## Device Identity

| Field | Value |
|-------|-------|
| Model | TVB3708BS_F |
| Type | 8-channel CCTV DVR/XVR |
| MAC | c8:22:02:61:15:97 |
| IP | 192.168.0.245 |
| Firmware | 1.03.05ac05ab.47820161.T140.2 (build 1.45.240907, 2024-08-05) |
| Web Server | APPWebs/ |
| RTSP Server | Topsvision Server v2.1 |
| Platform | XM/XMEye/NetSurveillance (TaoShi OEM) |
| NAT Status | Connected (P2P active) |

## Open Ports

| Port | Protocol | Service | Status |
|------|----------|---------|--------|
| 80 | TCP | HTTP | Web interface (APPWebs) |
| 554 | TCP | RTSP | Live video streaming |
| 9527 | TCP | Proprietary | DVR binary protocol |
| 34567 | TCP | XM/XMEye | NetSurveillance ecosystem |

UDP: None detected.

## Streaming Capabilities

### 1. Native HLS — NOT AVAILABLE

CGI endpoints `/CGI/Streaming/hls` and `/CGI/HLS/1.m3u8` exist but return empty (0-byte, content-type text/html). The DVR firmware does not generate HLS playlists natively.

### 2. RTSP — AVAILABLE (all 8 channels)

**Working URL pattern:**
```
rtsp://rick:2017@192.168.0.245:554/h264/ch{1-8}/{main|sub}/av_stream
```

**Channel 1 main stream SDP:**
```
v=0
o=- 38990265062388 38990265062388 IN IP4 192.168.0.245
a=range:npt=0-
m=video 0 RTP/AVP 96
c=IN IP4 0.0.0.0
a=rtpmap:96 H265/90000
a=fmtp:96 sprop-vps=...; sprop-sps=...; sprop-pps=...
a=control:trackID=3
m=audio 0 RTP/AVP 8
a=control:trackID=4
a=rtpmap:8 PCMA/8000
```

**Codec:**
- Video: **H.265** (HEVC)
- Audio: **PCMA** (G.711 A-law, 8kHz)

**Channels discovered:**

| Channel | Main Stream | Sub Stream |
|---------|-------------|------------|
| 1 | /h264/ch1/main/av_stream | /h264/ch1/sub/av_stream |
| 2 | /h264/ch2/main/av_stream | /h264/ch2/sub/av_stream |
| 3 | /h264/ch3/main/av_stream | /h264/ch3/sub/av_stream |
| 4 | /h264/ch4/main/av_stream | /h264/ch4/sub/av_stream |
| 5 | /h264/ch5/main/av_stream | /h264/ch5/sub/av_stream |
| 6 | /h264/ch6/main/av_stream | /h264/ch6/sub/av_stream |
| 7 | /h264/ch7/main/av_stream | /h264/ch7/sub/av_stream |
| 8 | /h264/ch8/main/av_stream | /h264/ch8/sub/av_stream |

**Encoding (from DVR settings):**
- Main: H.265, 1080N (944x1080), 14fps, VBR 1053 Kbps, I-frame 2
- Sub: H.265, CIF (352x288), 8fps, VBR 107 Kbps, I-frame 2

### 3. ONVIF — NOT AVAILABLE

No ONVIF device service detected on any port. WS-Discovery probe returned no responses. This DVR does not implement ONVIF.

### 4. Proprietary Protocols — AVAILABLE

| Port | Protocol | Notes |
|------|----------|-------|
| 34567 | XM/XMEye NetSurveillance | Client-initiated binary protocol, server waits for client |
| 9527 | DVR proprietary | Binary service, likely used by mobile apps (TSEye/Camsee) |

The P2P NAT status ("2:Connected") confirms the DVR uses XM-style P2P relay for remote access via mobile apps.

### 5. HTTP Video Endpoints — NONE

No HTTP-based video streaming (MJPEG, FLV, WebSocket) found in the web interface or JavaScript code.

### 6. WebSocket — NONE

No WebSocket endpoints found.

## Vendor/OEM Identification

The combination of:
- Port 34567 (XM/XMEye)
- Port 9527 (DVR proprietary)
- "Topsvision Server" RTSP banner
- "APPWebs" HTTP server
- P2P NAT status
- CGI structure `/CGI/Security/sessionLogin`
- JavaScript with `g_address`, `g_httpPort`, `g_port` (RTSP), `g_hostport` (TCP)

...identifies this as an **XM/XMEye/NetSurveillance** platform device, manufactured by Hangzhou TaoShi (or a TaoShi OEM) under the Camsee/TSEye ecosystem. This is a HiSilicon-based embedded Linux DVR.

## Recommended Solution

**RTSP-to-HLS bridge using MediaMTX** is the practical path since the DVR lacks native HLS and ONVIF.

### Architecture

```
DVR (192.168.0.245:554)
    │ RTSP (TCP)
    ▼
MediaMTX (on local machine or public VPS)
    │ HLS (HTTP)
    ▼
Firebase cameraHlsProxy (or direct browser)
    │
    ▼
Web App (HLS.js player)
```

### Configuration

See `mediamtx.yml` in this directory. Key changes needed:

1. **Install MediaMTX** on a machine with LAN access to the DVR (or on the public server at 34.151.126.55 if it can reach 192.168.0.245:554).
2. **Update `camera-config.js`** to point `hlsUrl` to MediaMTX instead of the old proxy.
3. **Update `CAMERA_HLS_BASE`** in Firebase Functions if still proxying.
4. **Router port forward**: Forward port 8888 → MediaMTX host:8888 for public HLS access.

### Browser H.265 Compatibility

| Browser | H.265 Support | Notes |
|---------|--------------|-------|
| Safari (macOS/iOS) | ✅ Native | Best experience |
| Edge (Win 10+) | ✅ With HEVC codec pack | Free codec from MS Store |
| Chrome | ⛔ No | Requires transcoding to H.264 |
| Firefox | ⛔ No | Requires transcoding to H.264 |

If Chrome/Firefox support is needed, MediaMTX can transcode H.265 to H.264, or use an alternative player (h265web.js, etc.).

### Quick Start

```powershell
# Download MediaMTX from https://github.com/bluenviron/mediamtx/releases
# Edit mediamtx.yml with credentials
# Run:
mediamtx.exe mediamtx.yml

# Test HLS:
curl http://localhost:8888/cam1_main/index.m3u8
```

## Files Created

| File | Purpose |
|------|---------|
| `mediamtx.yml` | MediaMTX config for all 16 RTSP sources |
| `discover-dvr.ps1` | Automated discovery script |
| `report.md` | This report |
| `findings.json` | Machine-readable results |
| `discovery-output/` | Raw HTTP pages, JS, SDP files |

## Troubleshooting

- **RTSP auth issues**: The DVR uses MD5 digest auth. Verify credentials in `mediamtx.yml`.
- **H.265 not playing in browser**: Use Safari/Edge, or enable MediaMTX transcoding with `sourceOnDemand: yes` and a transcode pipeline.
- **Port 8888 already in use**: Change `hlsAddress` in `mediamtx.yml` to another port.
- **RTSP stream drop**: Set `sourceProtocol: tcp` (already configured) and `sourceOnDemand: yes` to reduce connection overhead.
