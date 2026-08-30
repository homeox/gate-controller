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
