const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const HLS_DIR = '/tmp/hls';

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts':   'video/mp2t',
  '.mp4':  'video/mp4',
};

http.createServer((req, res) => {
  const file = path.join(HLS_DIR, req.url === '/' ? '/index.m3u8' : req.url);
  const ext = path.extname(file);
  
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT);
