const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const host = '0.0.0.0';
const port = 4180;
const root = __dirname;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const wifiAddress = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address || '电脑局域网地址';

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filename = path.resolve(root, relative);

  if (!filename.startsWith(root + path.sep)) {
    response.writeHead(403);
    return response.end('Forbidden');
  }

  fs.readFile(filename, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      return response.end('Not found');
    }
    response.writeHead(200, {
      'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    response.end(data);
  });
}).listen(port, host, () => {
  console.log(`账务管家已启动：http://${wifiAddress}:${port}/`);
  console.log('请保持此窗口开启。按 Ctrl+C 可以停止服务。');
});
