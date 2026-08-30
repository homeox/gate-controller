param(
  [string]$ProjectId = $(gcloud config get-value project),
  [string]$Region = "us-central1",
  [string]$RtspHost = $(Read-Host "Enter public IP of the DVR (forward port 554 to 192.168.0.245)"),
  [string]$RtspPort = "554",
  [string]$RtspUser = "rick",
  [string]$RtspPass = "2017"
)

if (-not $ProjectId) {
  Write-Error "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
}

Write-Host "== Building and deploying mediamtx-cloudrun for project $ProjectId" -ForegroundColor Cyan
Write-Host "RTSP source: rtsp://$RtspUser@$RtspHost`:$RtspPort/ch1/main/av_stream" -ForegroundColor Yellow
Write-Host ""

gcloud builds submit `
  --project $ProjectId `
  --config cloudbuild.yaml `
  --substitutions "_REGION=$Region,_ARTIFACT_REGISTRY=$Region-docker.pkg.dev/$ProjectId/mediamtx,_RTSP_HOST=$RtspHost,_RTSP_PORT=$RtspPort,_RTSP_USER=$RtspUser,_RTSP_PASS=$RtspPass"

if ($LASTEXITCODE -eq 0) {
  $url = gcloud run services describe mediamtx-cloudrun --region $Region --format="value(status.url)"
  Write-Host "`n=== Deployed! ===" -ForegroundColor Green
  Write-Host "Service URL: $url" -ForegroundColor Green
  Write-Host "HLS endpoint: $url/cam1_main/index.m3u8" -ForegroundColor Yellow
}
