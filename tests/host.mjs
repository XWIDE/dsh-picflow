// dsh-picflow 宿主半边冒烟测试：不需要 DSH，直接拿真附件库 + 真 HTTP 跑。
// 跑法：& <工作区>\dsh-node.cmd <本文件>
import http from 'node:http';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import * as picflow from '../index.js';

let pass = 0;
const ok = (label) => {
  pass += 1;
  console.log(`PASS ${label}`);
};
const root = picflow.attachmentsRoot();

// ---------- 1. 纯函数 ----------
assert.equal(picflow.attachmentsRoot({ DSH_HOME: 'C:\\x' }), join('C:\\x', 'attachments', 'v1'));
ok('attachmentsRoot 走 DSH_HOME');

assert.equal(picflow.sniffExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
assert.equal(picflow.sniffExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
assert.equal(picflow.sniffExt(Buffer.from('GIF89a', 'latin1')), 'gif');
assert.equal(picflow.sniffExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
assert.equal(picflow.sniffExt(Buffer.from('BM', 'latin1')), 'bmp');
assert.equal(picflow.sniffExt(Buffer.from('hello world!!', 'latin1')), undefined);
ok('sniffExt 认 png/jpg/gif/webp/bmp，其余 undefined');

assert.match(picflow.exportName({ modifiedMs: Date.UTC(2026, 9, 4, 22, 55), sha: 'a'.repeat(64), ext: 'png' }), /^pic-\d{4}-\d{4}-aaaaaaaa\.png$/);
ok('exportName 形如 pic-<stamp>-<sha8>.<ext>');

// ---------- 2. 假附件库目录 ----------
const fakeRoot = join(tmpdir(), `picflow-${Date.now()}`);
const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaJunk = 'c'.repeat(64);
for (const [sha, body] of [
  [shaA, Buffer.concat([pngHead, Buffer.alloc(64)])],
  [shaB, Buffer.concat([pngHead, Buffer.alloc(32)])],
  [shaJunk, Buffer.from('not an image at all', 'latin1')]
]) {
  const dir = join(fakeRoot, 'objects', sha.slice(0, 2));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, sha), body);
}
await fsp.writeFile(join(fakeRoot, 'objects', 'README'), 'ignored');
await fsp.writeFile(join(fakeRoot, 'objects', shaA.slice(0, 2), 'notes.txt'), 'x');
const scanned = await picflow.scanImages(fakeRoot, 10);
assert.equal(scanned.length, 2, '只列 magic 是图片的对象');
assert.deepEqual(scanned.map((row) => row.ext), ['png', 'png']);
ok('scanImages 过滤非图片、认 objects 分片目录');

// 幂等落盘
const work = join(tmpdir(), `picflow-work-${Date.now()}`);
await fsp.mkdir(work, { recursive: true });
const first = await picflow.materializeInto(work, scanned);
assert.equal(first.written, 2);
assert.ok(scanned.every((row) => typeof row.path === 'string' && row.path.endsWith(row.filename)));
const second = await picflow.materializeInto(work, scanned);
assert.equal(second.written, 0, '第二次不重复拷贝');
ok('materializeInto 落到 <cwd>/.dsh/pics 且幂等');

// ---------- 3. 真附件库 ----------
const real = await picflow.scanImages(root, 8);
assert.ok(real.length > 0, `真附件库里应能扫到用户贴的图（${root}）`);
for (let i = 1; i < real.length; i += 1) assert.ok(real[i - 1].modifiedMs >= real[i].modifiedMs, '按时间倒序');
assert.equal(real[0].ext, 'png');
ok(`scanImages(${root}) 扫到 ${real.length} 张（最新 ${real[0].label}，${real[0].bytes} B）`);

// ---------- 4. 真 HTTP 路由 ----------
const routes = [];
const sessions = {
  get: (id) => (id === 'with-cwd' ? { header: { cwd: work } } : undefined)
};
picflow.registerRoutes({ webServer: { register: (route) => routes.push(route) } }, { sessions, trustedHosts: [] });
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  const route = routes.find((entry) => entry.path === path);
  if (route === undefined) {
    res.writeHead(404);
    res.end('no route');
    return;
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const list = await fetch(`${origin}/plugins/dsh-picflow/images?limit=5&materialize=2&session=with-cwd`);
assert.equal(list.status, 200);
const payload = await list.json();
assert.equal(payload.rows.length, 5);
assert.ok(payload.total >= 5, 'total 是全库命中数，不是这一页');
assert.equal(payload.libraryTotal, payload.total, '不筛时命中数 = 库总量');
assert.ok(payload.totalBytes > 0);
assert.ok(Array.isArray(payload.days) && payload.days.length > 0, '要按天分桶');
assert.equal(payload.days.reduce((sum, entry) => sum + entry.count, 0), payload.libraryTotal, '日分桶计数之和 = 库总量');
assert.equal(payload.hasMore, true);
assert.equal(payload.nextOffset, 5);
assert.equal(payload.root, root);
assert.equal(payload.note, undefined, '有工作区时不该有 note');
assert.ok(payload.rows.slice(0, 2).every((row) => row.path !== undefined), '前 2 张应有落盘 path');
assert.ok(payload.rows.slice(2).every((row) => row.path === undefined), 'materialize 之外的没有 path');
assert.ok(payload.rows.every((row, index) => index === 0 || payload.rows[index - 1].ordinal > row.ordinal), '倒序时编号递减');
ok(`GET /images 返回 ${payload.rows.length}/${payload.total} 张（${payload.days.length} 天），前 2 张已落盘到工作区`);

// 固定编号 + 翻页
const asc = await (await fetch(`${origin}/plugins/dsh-picflow/images?limit=3&sort=old`)).json();
assert.deepEqual(asc.rows.map((row) => row.ordinal), [1, 2, 3], '最早的三张就是 图片1/2/3');
const page2 = await (await fetch(`${origin}/plugins/dsh-picflow/images?limit=3&offset=3&sort=old`)).json();
assert.deepEqual(page2.rows.map((row) => row.ordinal), [4, 5, 6], '第二页接着排，不重不漏');
ok(`编号固定：最早的是 图片1（${asc.rows[0].label}），翻页不重叠`);

// 搜索：编号 / 今天 / 日 / 格式
const byNumber = await (await fetch(`${origin}/plugins/dsh-picflow/images?limit=5&q=${encodeURIComponent('图片2')}`)).json();
assert.equal(byNumber.total, 1, '「图片2」只该命中一张');
assert.equal(byNumber.rows[0].ordinal, 2);
const today = await (await fetch(`${origin}/plugins/dsh-picflow/images?limit=5&q=${encodeURIComponent('今天')}`)).json();
assert.ok(today.rows.length > 0, '「今天」应该有图');
const byDay = await (await fetch(`${origin}/plugins/dsh-picflow/images?limit=5&day=${today.rows[0].day}`)).json();
assert.ok(byDay.total >= today.rows.length);
assert.ok(byDay.rows.every((row) => row.day === today.rows[0].day));
const byExt = await (await fetch(`${origin}/plugins/dsh-picflow/images?limit=5&q=jpg`)).json();
assert.ok(byExt.rows.every((row) => row.ext === 'jpg'));
ok(`搜索可用：图片2 → 1 张；今天 ${today.total} 张；${today.rows[0].day} ${byDay.total} 张；jpg ${byExt.total} 张`);

// 按需落盘：只拷点名的这一张
const target = payload.rows[4];
const pinned = await (await fetch(`${origin}/plugins/dsh-picflow/images?pin=${target.sha}&limit=1&session=with-cwd`)).json();
assert.equal(pinned.pinned.sha, target.sha);
assert.equal((await fsp.stat(pinned.pinned.path)).size, target.bytes);
assert.equal(pinned.rows.length, 1, 'pin 只是一次落盘请求，列表照旧');
ok(`GET /images?pin=<sha> 只给这一张落盘（${pinned.pinned.path.split(/[\\/]/).pop()}）`);

const raw = await fetch(`${origin}${payload.rows[0].url}`);
assert.equal(raw.status, 200);
assert.equal(raw.headers.get('content-type'), 'image/png');
const bytes = Buffer.from(await raw.arrayBuffer());
assert.equal(bytes.length, payload.rows[0].bytes);
assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
ok(`GET /raw 回真图字节（${bytes.length} B，content-type image/png）`);

const noWorkspace = await (await fetch(`${origin}/plugins/dsh-picflow/images?session=unknown&materialize=2`)).json();
assert.match(String(noWorkspace.note), /工作区/);
ok('无工作区的会话给出 note（正文引用会退化）');

const bad = await fetch(`${origin}/plugins/dsh-picflow/raw?ref=sha256:zz`);
assert.equal(bad.status, 400);
assert.equal((await bad.json()).error, 'invalid-ref');
const missing = await fetch(`${origin}/plugins/dsh-picflow/raw?ref=sha256:${'f'.repeat(64)}`);
assert.equal(missing.status, 404);
assert.equal((await missing.json()).error, 'image-not-found');
ok('非法 ref → 400 invalid-ref；库里没有 → 404 image-not-found');

const posted = await fetch(`${origin}/plugins/dsh-picflow/raw?ref=sha256:${'a'.repeat(64)}`, { method: 'POST' });
assert.equal(posted.status, 405);
ok('POST /raw → 405（只读）');

// host 栅栏：伪造 Host 头
function rawRequestWithHostOn(server, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET', headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const rawRequestWithHost = (path, host) => rawRequestWithHostOn(server, path, host);
const fenced = await rawRequestWithHost('/plugins/dsh-picflow/images', 'evil.example');
assert.equal(fenced.status, 403);
assert.equal(JSON.parse(fenced.body).error, 'host-not-trusted');
const allowed = await rawRequestWithHost('/plugins/dsh-picflow/images?limit=1', 'localhost:52962');
assert.equal(allowed.status, 200);
ok('host 栅栏：evil.example → 403 host-not-trusted，localhost:52962 → 200');

// ---------- 5. /version + /admit（在假库里跑，别碰真附件库） ----------
// 前面的夹具文件名只是为了好写，内容哈希对不上；这里按内容寻址再放两张，并固定 mtime，
// 编号才是确定的（这两张最早 ⇒ hashA = 图片1，hashB = 图片2）。
const imgA = Buffer.concat([pngHead, Buffer.alloc(64)]);
const imgB = Buffer.concat([pngHead, Buffer.alloc(32)]);
const hashA = createHash('sha256').update(imgA).digest('hex');
const hashB = createHash('sha256').update(imgB).digest('hex');
for (const [hash, body, when] of [
  [hashA, imgA, '2026-01-01T00:00:00Z'],
  [hashB, imgB, '2026-01-02T00:00:00Z']
]) {
  const dir = join(fakeRoot, 'objects', hash.slice(0, 2));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, hash), body);
  await fsp.utimes(join(dir, hash), new Date(when), new Date(when));
}

assert.match(await picflow.libraryStamp(fakeRoot), /^\d+:\d+$/, '指纹是「分片 mtime:分片数」');
assert.ok(Number((await picflow.libraryStamp(fakeRoot)).split(':')[1]) >= 3, '每个 sha 前缀一个分片目录');
assert.equal((await picflow.ordinalOf(fakeRoot, hashA)).ordinal, 1, '最早的那张就是图片1');
assert.equal((await picflow.ordinalOf(fakeRoot, hashB)).ordinal, 2);
assert.equal(await picflow.ordinalOf(fakeRoot, 'z'.repeat(64)), undefined, '库里没有的 sha 给 undefined');
assert.equal(await picflow.ordinalOf(fakeRoot, 'nope'), undefined, '非法 sha 给 undefined');
ok('libraryStamp / ordinalOf：分片指纹 + 固定编号（图片1 = 最早的那张）');

// 假附件服务：只实现 saveImage 那点契约（官方实现会规范化，这里原样落盘）。
const admitted = [];
const attachmentStore = {
  async saveImage({ data, mediaType, name }) {
    const sha = createHash('sha256').update(data).digest('hex');
    const dir = join(fakeRoot, 'objects', sha.slice(0, 2));
    const file = join(dir, sha);
    await fsp.mkdir(dir, { recursive: true });
    // 内容寻址：同一份字节已经在库里就不再重写（真实现也是同一个 sha 同一个对象），
    // 这样重贴一张老图不会把它顶成「最新」，编号才稳定。
    if (!(await fsp.stat(file).then(() => true, () => false))) await fsp.writeFile(file, data);
    admitted.push({ sha, mediaType, name, bytes: data.byteLength });
    return { attachmentId: `sha256:${sha}`, mediaType, width: 1, height: 1, bytes: data.byteLength, ...(name === undefined ? {} : { name }) };
  }
};
let storeOnline = true;
const routes2 = [];
const ctx2 = {
  webServer: { register: (route) => routes2.push(route) },
  get: (name) => (name === 'attachments' && storeOnline ? attachmentStore : undefined)
};
picflow.registerRoutes(ctx2, { sessions, trustedHosts: [], root: fakeRoot });
const server2 = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  const route = routes2.find((entry) => entry.path === path);
  if (route === undefined) {
    res.writeHead(404);
    res.end('no route');
    return;
  }
  Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
});
await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
const origin2 = `http://127.0.0.1:${server2.address().port}`;

const version = await (await fetch(`${origin2}/plugins/dsh-picflow/version`)).json();
assert.equal(version.root, fakeRoot);
const stamp0 = version.stamp;
assert.match(stamp0, /^\d+:\d+$/);
ok(`GET /version 给出库指纹（${stamp0}）`);

// 新图落进库里 ⇒ 指纹必须变（客户端靠这个发现「别的窗口贴了图」）。
const imgC = Buffer.concat([pngHead, Buffer.alloc(96)]);
const hashC = createHash('sha256').update(imgC).digest('hex');
const late = join(fakeRoot, 'objects', hashC.slice(0, 2), hashC);
await fsp.mkdir(join(fakeRoot, 'objects', hashC.slice(0, 2)), { recursive: true });
await fsp.writeFile(late, imgC);
await fsp.utimes(late, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
const stamp1 = (await (await fetch(`${origin2}/plugins/dsh-picflow/version`)).json()).stamp;
assert.notEqual(stamp1, stamp0, '新图入库后指纹要变');
ok(`库里有新增后指纹变化（${stamp0} → ${stamp1}）`);

// 真正的贴图入库：body 就是字节，宿主落进附件库、编号、再拷一份到工作区。
const admittedRes = await fetch(`${origin2}/plugins/dsh-picflow/admit?session=with-cwd&name=${encodeURIComponent('微信截图.png')}`, {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: imgA
});
assert.equal(admittedRes.status, 200);
const admitPayload = await admittedRes.json();
assert.equal(admitPayload.ok, true);
assert.equal(admitPayload.sha, hashA);
assert.equal(admitPayload.ordinal, 1, '同一张图重贴也还是同一个号（和发送时的副本天然去重）');
assert.equal(admitPayload.label, '图片1');
assert.equal(admitPayload.ext, 'png');
assert.deepEqual(admitted.at(-1), { sha: hashA, mediaType: 'image/png', name: '微信截图.png', bytes: imgA.byteLength });
assert.equal(admitPayload.row.path, join(work, '.dsh', 'pics', admitPayload.row.filename));
assert.equal((await fsp.stat(admitPayload.row.path)).size, imgA.byteLength);
assert.ok(admitPayload.row.filename.endsWith('.png'), '落盘的副本要带扩展名，芯片才读得到');
assert.equal(admitPayload.row.ref, `sha256:${hashA}`);
ok(`POST /admit 入库并编号（${admitPayload.label}，副本 ${admitPayload.row.filename}）`);

// 声明错 content-type 也照样入库：格式以字节为准，不看请求头。
const mistyped = await fetch(`${origin2}/plugins/dsh-picflow/admit?session=with-cwd`, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: pngHead
});
assert.equal(mistyped.status, 200);
assert.equal((await mistyped.json()).ext, 'png');
ok('POST /admit 以字节嗅探格式（content-type 声明错也能入库）');

const junk = await fetch(`${origin2}/plugins/dsh-picflow/admit`, { method: 'POST', body: Buffer.from('not an image', 'latin1') });
assert.equal(junk.status, 400);
assert.equal((await junk.json()).error, 'unsupported-image');
const empty = await fetch(`${origin2}/plugins/dsh-picflow/admit`, { method: 'POST', body: Buffer.alloc(0) });
assert.equal(empty.status, 400);
assert.equal((await empty.json()).error, 'empty-body');
const wrongMethod = await fetch(`${origin2}/plugins/dsh-picflow/admit`);
assert.equal(wrongMethod.status, 405);
assert.equal((await wrongMethod.json()).error, 'method-not-allowed');
ok('POST /admit 挡住非图片 → 400 unsupported-image、空体 → 400 empty-body、GET → 405');

storeOnline = false;
const noStore = await fetch(`${origin2}/plugins/dsh-picflow/admit`, { method: 'POST', body: pngHead });
assert.equal(noStore.status, 501);
assert.equal((await noStore.json()).error, 'attachments-unavailable');
storeOnline = true;
ok('没有附件服务时 → 501 attachments-unavailable（客户端据此降级）');

// 没有工作区的会话：照样入库、照样给编号，只是不落副本。
const noCwd = await (await fetch(`${origin2}/plugins/dsh-picflow/admit?session=unknown`, { method: 'POST', body: pngHead })).json();
assert.equal(noCwd.ok, true);
assert.ok(typeof noCwd.ordinal === 'number' && noCwd.ordinal >= 1);
assert.equal(noCwd.row.path, undefined, '没有工作区就没有 path，只有编号');
ok(`没有工作区时只给编号（${noCwd.label}），不落副本`);

// 栅栏对新路由同样有效
const fenced2 = await rawRequestWithHostOn(server2, '/plugins/dsh-picflow/version', 'evil.example');
assert.equal(fenced2.status, 403);
assert.equal(JSON.parse(fenced2.body).error, 'host-not-trusted');
ok('/version 也走 host 栅栏（evil.example → 403）');

server2.close();
server.close();
await fsp.rm(fakeRoot, { recursive: true, force: true });
await fsp.rm(work, { recursive: true, force: true });

console.log(`\n${pass}/${pass} PASS`);
