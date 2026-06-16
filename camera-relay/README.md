# Gate Camera Relay

This folder documents the no-Docker MediaMTX relay used to turn the DVR RTSP feed into a browser-friendly HLS feed for the Firebase gate web app.

The browser must not load the DVR RTSP URL directly. The web app should only use the MediaMTX HLS URL, for example:

```text
https://YOUR_MEDIAMTX_DOMAIN/gate/index.m3u8
```

## Expected Flow

```text
DVR RTSP feed -> Google Compute Engine VM -> MediaMTX -> HLS -> Firebase web app
```

## VM Setup

Use a small Ubuntu VM close to Australia/Singapore. Open the HLS port only as needed while testing.

1. Copy `mediamtx.yml.example` to `/etc/mediamtx/mediamtx.yml`.
2. Replace `REPLACE_WITH_EXTERNAL_DVR_RTSP_URL` with the working external RTSP URL.
3. Run `install-mediamtx.sh` on the VM.
4. Confirm the HLS URL loads:

```text
http://VM_PUBLIC_IP:8888/gate/index.m3u8
```

5. Put the final HTTPS HLS URL into:

```text
gate-cloud/public/camera-config.js
```

## Notes

- The low-bandwidth DVR substream is preferred.
- The relay can be secured later with a domain, TLS, firewall rules, or MediaMTX authentication.
- Keep the raw DVR RTSP URL out of frontend code.
