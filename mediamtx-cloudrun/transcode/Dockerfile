FROM alpine:latest
RUN apk add --no-cache ffmpeg nodejs
COPY server.js /server.js
COPY start.sh /start.sh
RUN chmod +x /start.sh
ENTRYPOINT ["/start.sh"]
