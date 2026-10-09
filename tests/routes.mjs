// dsh-picflow 新路由的端到端测试：stats / ledger / pin / cleanup / trash。
// 用临时 DSH_HOME + 临时附件库，绝不碰用户真库。
// 跑法：& <工作区>\dsh-node.cmd <本文件>
import http from 'node:http';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import * as picflow from '../index.js';

const DAY_MS = 86400000;
const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shaOf = (seed) => String(seed).padStart(64, seed === 7 ? '0' : 'f');

let pass = 0;
const ok = (label) => {
  pass += 1;
  console.log(`PASS ${label}`);
};

// ---------- 临时家目录 + 临时附件库 ----------
const home = join(tmpdir(), `picflow-home-${Date.now()}`);
const root = join(home, 'attachments', 'v1');
const work = join(home, 'workspace');
process.env.DSH_HOME = home;

const writeObject = async (sha, source, bytes, ageDays) => {
  const dir = join(root, source, sha.slice(0, 2));
  await fsp.mkdir(dir, { recursive: true });
  const file = join(dir, sha);
  await fsp.writeFile(file, Buffer.concat([pngHead, Buffer.alloc(bytes)]));
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await fsp.utimes(file, when, when);
  return file;
};

const old1 = shaOf(1);
const old2 = shaOf(2);
const fresh = shaOf(3);
const big = shaOf(4);
for (const [sha, age, size] of [[old1, 30, 40], [old2, 20, 60], [fresh, 1, 50], [big, 40, 700 * 1024]]) {
  await writeObject(sha, 'objects', size, age);
}
await fsp.mkdir(join(work, '.dsh', 'pics'), { recursive: true });
await fsp.writeFile(join(work, '.dsh', 'pics', `pic-1001-0000-${old1.slice(0, 8)}.png`), 'thumb');

const routes = [];
const sessions = { get: (id) => (id === 's1' ? { header: { cwd: work } } : undefined) };
picflow.registerRoutes({ webServer: { register: (route) => routes.push(route) } }, { sessions, trustedHosts: [], root });
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
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const get = async (suffix) => {
  const res = await fetch(`${origin}/plugins/dsh-picflow${suffix}`);
  return { status: res.status, body: await res.json() };
};
const post = async (suffix, payload) => {
  const res = await fetch(`${origin}/plugins/dsh-picflow${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json() };
};

// ---------- GET /images 带状态与桶 ----------
{
  const res = await get('/images?limit=100&session=s1');
  assert.equal(res.status, 200);
  const rows = res.body.rows;
  assert.ok(rows.length >= 4, `临时库应列出 ${rows.length} 张`);
  assert.ok(rows.every((row) => row.state !== undefined), '每行都该带四态标记');
  assert.ok(Array.isArray(res.body.stats.buckets) && res.body.stats.buckets.length === 5, 'stats.buckets 恒定 5 个');
  assert.ok(res.body.stats.totalBytes > 0, '顶部数字是磁盘真实体积');
  const byOld = rows.find((row) => row.sha === old1);
  assert.equal(byOld.cleanable, true, '入库 30 天且从未引用 = 可清');
  assert.ok(byOld.reasons.some((text) => text.includes('从未被引用')), '理由要说清为什么可清');
  const byFresh = rows.find((row) => row.sha === fresh);
  assert.equal(byFresh.cleanable, false, '刚入库的不进候选');
  const bigRow = rows.find((row) => row.sha === big);
  assert.equal(bigRow.big, true, '>500 KB 标 big');
  const bucket3 = await get('/images?limit=100&bucket=3d');
  assert.equal(bucket3.body.bucket, '3d');
  assert.ok(bucket3.body.rows.every((row) => Date.now() - row.modifiedMs <= 3 * DAY_MS), '近 3 天桶里不能有 3 天前的图');
  const stateUnused = await get('/images?limit=100&state=unused');
  assert.ok(stateUnused.body.rows.every((row) => row.uses === 0), '「没用过」桶里 uses 必须为 0');
  ok(`GET /images 带四态 + 时间桶 + 真实体积（${res.body.total} 张，可清 ${res.body.stats.cleanable.count} 张）`);
}

// ---------- POST /ledger 记账 ----------
{
  const res = await post(`/ledger?session=s1&kind=insert`, { sha: old1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.saved, true, '账本要落盘');
  assert.equal(res.body.entry.uses, 1);
  const ledgerFile = join(home, 'dsh-picflow', 'usage.json');
  const raw = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'));
  assert.equal(raw.entries[old1].uses, 1, '账本文件里就该有这条');
  const bad = await post('/ledger', { sha: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid-sha');
  const after = await get('/images?limit=100&state=unused');
  assert.ok(!after.body.rows.some((row) => row.sha === old1), '记过账的图不该再出现在「没用过」里');
  const cleanable = await get('/cleanup?days=14&session=s1');
  assert.ok(!cleanable.body.rows.some((row) => row.sha === old1), '用过的图一律不清');
  ok('POST /ledger 记账生效：用过就不进「没用过」，也不进清理候选');
}

// ---------- POST /pin 置顶 ----------
{
  const res = await post('/pin', { sha: old2 });
  assert.equal(res.body.pinned, true);
  const listed = await get('/images?limit=100&state=pinned');
  assert.deepEqual(listed.body.rows.map((row) => row.sha), [old2]);
  const cleanable = await get('/cleanup?days=14&session=s1');
  assert.ok(!cleanable.body.rows.some((row) => row.sha === old2), '置顶的图不进清理候选');
  const stats = await get('/stats');
  assert.deepEqual(stats.body.pinned, [old2], 'stats 要带置顶清单');
  const off = await post('/pin', { sha: old2 });
  assert.equal(off.body.pinned, false, '再点一次取消置顶');
  ok('POST /pin 置顶/取消生效，且置顶压倒清理候选');
}

// ---------- GET /cleanup 候选 ----------
{
  const res = await get('/cleanup?days=14&session=s1');
  assert.equal(res.status, 200);
  assert.equal(res.body.ageDays, 14);
  const shas = res.body.rows.map((row) => row.sha);
  assert.ok(shas.includes(big), '入库 40 天未引用的大图应在候选里');
  assert.ok(!shas.includes(fresh), '刚入库的不该进候选');
  assert.ok(res.body.bytes > 0);
  ok(`GET /cleanup 给出候选 ${res.body.count} 张 / ${res.body.bytes} B（共 ${res.body.total} 张）`);
}

// ---------- 回收站：搬走 → 撤销 → 到期真删 ----------
{
  const move = await post('/trash', { op: 'move', shas: [big] });
  assert.equal(move.status, 200);
  assert.equal(move.body.moved.length, 1);
  assert.ok(move.body.removedThumbs >= 0, '缩略副本清理计数应为数字');
  await assert.rejects(() => fsp.stat(join(root, 'objects', big.slice(0, 2), big)), '对象应已离开附件库');
  const list = await get('/trash');
  assert.equal(list.body.count, 1);
  assert.equal(list.body.entries[0].sha, big);
  assert.equal(list.body.entries[0].daysInTrash, 0);
  const ghost = await post('/trash', { op: 'move', shas: ['d'.repeat(64)] });
  assert.equal(ghost.body.moved.length, 0);
  assert.equal(ghost.body.skipped[0].reason.includes('找不到'), true);
  const restore = await post('/trash', { op: 'restore', ids: [] });
  assert.equal(restore.body.restored.length, 1);
  const back = await fsp.stat(join(root, 'objects', big.slice(0, 2), big));
  assert.ok(back.size > 0, '撤销后对象回到附件库');
  assert.equal((await get('/trash')).body.count, 0);
  const purgeNow = await post('/trash', { op: 'move', shas: [big] });
  assert.equal(purgeNow.body.moved.length, 1);
  const kept = await post('/trash', { op: 'purge' });
  assert.equal(kept.body.purged.length, 0, '没满 7 天不许真删');
  assert.equal((await get('/trash')).body.count, 1);
  ok('回收站：搬走 → 撤销回库；未满 7 天 purge 不删任何东西');
}

// ---------- GET /stats ----------
{
  const res = await get('/stats?session=s1');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // 此刻 big 那张在回收站里，库里剩 3 张
  assert.ok(res.body.total >= 3);
  assert.ok(res.body.root === root && res.body.trashRoot.includes('trash'), 'stats 报出库目录与回收站目录');
  assert.equal(res.body.trashCount, 1);
  const labels = res.body.buckets.map((entry) => entry.label);
  assert.deepEqual(labels, ['全部', '近3天', '近7天', '近30天', '更早']);
  const badMethod = await fetch(`${origin}/plugins/dsh-picflow/stats`, { method: 'POST', body: '{}' });
  assert.equal(badMethod.status, 405);
  ok(`GET /stats 聚合可用（${res.body.total} 张 / ${res.body.totalBytes} B，桶标签 ${labels.join('·')}）`);
}

server.close();
console.log(`\nall ${pass} checks passed`);
