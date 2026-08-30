#!/bin/sh

PORT="${PORT:-8080}"
HLS_DIR="/tmp/hls"
mkdir -p "$HLS_DIR"

node /server.js &
SERVER_PID=$!

while true; do
  ffmpeg -nostdin -hide_banner -loglevel warning -stats \
    -rtsp_transport tcp \
    -i "rtsp://rick:2017@101.188.140.245:10554/h264/ch1/main/av_stream" \
    -c:v libx264 -preset ultrafast -crf 28 -profile:v baseline -level 3.0 \
    -vf "scale=640:360" \
    -c:a aac -b:a 32k -ac 1 \
    -f hls \
    -hls_time 2 -hls_list_size 6 -hls_flags delete_segments \
    -hls_segment_filename "$HLS_DIR/seg_%03d.ts" \
    "$HLS_DIR/index.m3u8"
  sleep 3
done
