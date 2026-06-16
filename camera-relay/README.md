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

## Cloud Shell VM Setup

Run this from Google Cloud Shell in the Firebase/Google project account, not from the local PC:

```bash
git clone https://github.com/homeox/gate-controller.git
cd gate-controller
bash camera-relay/create-gce-mediamtx-cloudshell.sh
```

The script:

- enables the Compute Engine API
- creates a small Ubuntu VM
- installs MediaMTX directly with systemd, without Docker
- pulls the external DVR RTSP substream
- opens TCP port 8888 for the HLS preview
- prints the HLS URL to paste into the Firebase web app camera config

Expected output URL:

```text
http://VM_PUBLIC_IP:8888/gate/index.m3u8
```

Put that value in:

```text
gate-cloud/public/camera-config.js
```

Example:

```js
window.gateCameraConfig = {
  hlsUrl: 'http://VM_PUBLIC_IP:8888/gate/index.m3u8',
  label: 'Gate camera'
};
```

## Manual VM Setup

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
