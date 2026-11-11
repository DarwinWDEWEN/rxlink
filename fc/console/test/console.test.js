// 控制台静态站回归测试：node --test fc/console/test/
// 起真实 index.js 子进程（CONSOLE_ROOT 指向临时目录），断言 DB-IP 署名注入行为。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'index.js');

let root;
let child;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${urlPath}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          raw: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rxlink-console-test-'));
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><title>rxlink</title></head><body><app-root></app-root></body></html>',
  );
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("app");\n');

  const port = await freePort();
  child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, CONSOLE_ROOT: root, FC_SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('console start timeout')), 10000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('console listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`console exited: ${code}`)));
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child) child.kill();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 署名注入

test('首页注入 DB-IP 署名：文本 + 指向 db-ip.com 的链接', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /IP Geolocation by/);
  assert.match(res.body, /DB-IP/);
  assert.match(res.body, /href="https:\/\/db-ip\.com"/);
});

test('署名块落在 </body> 之前，且样式进 <head>', async () => {
  const res = await get('/');
  const footerAt = res.body.indexOf('rxlink-attribution');
  const bodyCloseAt = res.body.lastIndexOf('</body>');
  assert.ok(footerAt > -1, 'footer 未注入');
  assert.ok(footerAt < bodyCloseAt, '署名应在 </body> 之前');
  assert.match(res.body, /<style>[\s\S]*rxlink-attribution/);
});

test('注入后 Content-Length 与实际字节数一致（不被截断）', async () => {
  const res = await get('/');
  assert.equal(Number(res.headers['content-length']), res.raw.length);
  assert.ok(res.body.endsWith('</body></html>'));
});

test('SPA 路由回退到 index.html 时同样带署名', async () => {
  const res = await get('/visits/42');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /IP Geolocation by/);
});

test('静态资源不被注入署名', async () => {
  const res = await get('/assets/app.js');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'console.log("app");\n');
  assert.doesNotMatch(res.body, /IP Geolocation by/);
});

test('HTML 里已有署名时不重复注入', async () => {
  fs.writeFileSync(
    path.join(root, 'pre.html'),
    '<!doctype html><html><head></head><body><div class="rxlink-attribution">IP Geolocation by DB-IP</div></body></html>',
  );
  const res = await get('/pre.html');
  assert.equal((res.body.match(/IP Geolocation by/g) || []).length, 1);
});

test('带扩展名的不存在资源仍是 404（不被 SPA 回退吞掉）', async () => {
  const res = await get('/assets/missing.js');
  assert.equal(res.status, 404);
});
