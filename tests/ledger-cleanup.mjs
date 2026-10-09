/**
 * tests/ledger-cleanup.mjs —— 账本、四态判定、回收站的离线测试。
 *   node tests/ledger-cleanup.mjs
 * 用内存文件系统，不碰真实附件库。
 */
import assert from 'node:assert/strict';
import {
  BIG_BYTES, DAY_MS, NOISE_BYTES, TIME_BUCKETS, aggregate, classify, decorate,
  entryOf, inTimeBucket, isPinned, ledgerPath, matchesState, pinsPath, readJson, togglePin, touch, writeJson
} from '../ledger.js';
import {
  TRASH_KEEP_DAYS, candidates, cleanMaterialized, listTrash, moveToTrash, purgeTrash, restoreFromTrash, trashRootFor
} from '../cleanup.js';

let checks = 0;
const ok = async (label, fn) => {
  await fn();
  checks += 1;
  console.log(`ok   ${label}`);
};
const shaOf = (seed) => String(seed).padStart(64, '0');
// 内存 fs 的键一律按正斜杠归一化，path.join 在 Windows 上给的是反斜杠
const P = (p) => String(p).replace(/\\/g, '/');
const NOW = Date.parse('2026-10-08T10:00:00Z');
const daysAgo = (days) => NOW - days * DAY_MS;
const LEDGER_PATH = ledgerPath('/home/u/.dsh');
const PINS_PATH = pinsPath('/home/u/.dsh');
const TRASH = trashRootFor('/home/u/.dsh');

// ---- 账本 ----
await ok('账本/置顶文件路径挂在插件自己的目录下，不碰附件库', () => {
  assert.ok(LEDGER_PATH.includes('dsh-picflow'));
  assert.ok(LEDGER_PATH.endsWith('usage.json'));
  assert.ok(PINS_PATH.endsWith('pins.json'));
  assert.ok(TRASH.includes('trash'));
});

await ok('touch 记次数、最近时间、会话（去重、限量）', () => {
  const ledger = {};
  touch(ledger, shaOf(1), { sessionId: 's1', kind: 'insert', nowMs: NOW });
  touch(ledger, shaOf(1), { sessionId: 's1', kind: 'attach', nowMs: NOW + 1000 });
  touch(ledger, shaOf(1), { sessionId: 's2', kind: 'auto', nowMs: NOW + 2000 });
  const entry = entryOf(ledger, shaOf(1));
  assert.equal(entry.uses, 3);
  assert.equal(entry.lastMs, NOW + 2000);
  assert.equal(entry.sessions.length, 2);
  assert.deepEqual(entry.kinds.slice().sort(), ['attach', 'auto', 'insert']);
  assert.equal(touch(ledger, 'nope', {}), undefined);
});

await ok('账本条目数超过上限时淘汰最老的，不会无限长', () => {
  const ledger = {};
  for (let i = 1; i <= 20001; i += 1) touch(ledger, shaOf(i), { nowMs: NOW - i });
  assert.equal(Object.keys(ledger.entries).length, 20000);
});

// ---- 四态判定 ----
const row = (seed, { bytes = 100 * 1024, ageDays = 20 } = {}) => ({
  sha: shaOf(seed), bytes, modifiedMs: daysAgo(ageDays), source: 'objects'
});

await ok('从未被引用 + 满 14 天 = cold，且进清理候选', () => {
  const info = classify(row(7), { nowMs: NOW, sessionId: 's1' });
  assert.equal(info.state, 'cold');
  assert.equal(info.cleanable, true);
  assert.ok(info.reasons.some((r) => r.includes('从未被引用')));
});

await ok('刚入库的未引用图是 fresh，不进候选', () => {
  const info = classify(row(8, { ageDays: 2 }), { nowMs: NOW });
  assert.equal(info.state, 'fresh');
  assert.equal(info.cleanable, false);
});

await ok('近 7 天用过 = hot；30 天内用过 = warm；用过就不进候选', () => {
  const ledger = {};
  touch(ledger, shaOf(9), { nowMs: NOW - 2 * DAY_MS });
  touch(ledger, shaOf(10), { nowMs: NOW - 20 * DAY_MS });
  assert.equal(classify(row(9), { ledger, nowMs: NOW }).state, 'hot');
  assert.equal(classify(row(9), { ledger, nowMs: NOW }).cleanable, false);
  assert.equal(classify(row(10), { ledger, nowMs: NOW }).state, 'warm');
  assert.equal(classify(row(10), { ledger, nowMs: NOW }).cleanable, false);
});

await ok('用过但都在 30 天前 = cold，理由写清"几次使用都在多少天前"', () => {
  const ledger = {};
  touch(ledger, shaOf(11), { nowMs: NOW - 60 * DAY_MS });
  const info = classify(row(11, { ageDays: 70 }), { ledger, nowMs: NOW });
  assert.equal(info.state, 'cold');
  assert.ok(info.reasons.some((r) => r.includes('60 天前')));
});

await ok('置顶压倒一切：未引用 100 天也不进候选', () => {
  const pins = { shas: [shaOf(12)] };
  const info = classify(row(12, { ageDays: 100 }), { pins, nowMs: NOW });
  assert.equal(info.state, 'hot');
  assert.equal(info.cleanable, false);
  assert.ok(info.reasons[0].includes('已置顶'));
  assert.equal(isPinned(pins, shaOf(12)), true);
  const toggled = togglePin(pins, shaOf(12), NOW);
  assert.equal(toggled.pinned, false);
  assert.equal(toggled.pins.shas.length, 0);
});

await ok('属于当前会话 = hot（刚粘贴还没发送的图不能被清走）', () => {
  const ledger = {};
  touch(ledger, shaOf(13), { sessionId: 'cur', nowMs: NOW - 40 * DAY_MS });
  const info = classify(row(13, { ageDays: 40 }), { ledger, nowMs: NOW, sessionId: 'cur' });
  assert.equal(info.state, 'hot');
  assert.ok(info.reasons.some((r) => r.includes('当前会话')));
});

await ok('小噪音是正交标记：<20 KB 标 noise 并照判四态；>500 KB 标 big', () => {
  const info = classify(row(14, { bytes: NOISE_BYTES - 1, ageDays: 30 }), { nowMs: NOW });
  assert.equal(info.noise, true);
  assert.equal(info.state, 'cold');
  assert.ok(info.reasons.some((r) => r.includes('小噪音')));
  const big = classify(row(15, { bytes: BIG_BYTES + 10, ageDays: 30 }), { nowMs: NOW });
  assert.equal(big.big, true);
  assert.equal(big.noise, false);
});

// ---- 时间桶 / 状态桶 ----
await ok('时间桶恒定 5 个，"更早"= 30 天以外', () => {
  assert.equal(TIME_BUCKETS.length, 5);
  const old = row(16, { ageDays: 45 });
  const mid = row(17, { ageDays: 10 });
  const fresh = row(18, { ageDays: 1 });
  assert.equal(inTimeBucket(old, '3d', NOW), false);
  assert.equal(inTimeBucket(mid, '7d', NOW), false);
  assert.equal(inTimeBucket(mid, '30d', NOW), true);
  assert.equal(inTimeBucket(fresh, 'all', NOW), true);
  assert.equal(inTimeBucket(old, 'older', NOW), true);
  assert.equal(inTimeBucket(mid, 'older', NOW), false);
});

await ok('状态桶：used / pinned / big / noise / cleanable / unused 各归各位', () => {
  const ledger = {};
  touch(ledger, shaOf(19), { nowMs: NOW - DAY_MS });
  const pins = { shas: [shaOf(20)] };
  const opts = { ledger, pins, nowMs: NOW };
  const rows = decorate([
    row(19, { ageDays: 2 }),
    row(20, { ageDays: 90 }),
    row(21, { ageDays: 20 }),
    row(22, { bytes: BIG_BYTES + 5, ageDays: 20 })
  ], opts);
  const pick = (state) => rows.filter((r) => matchesState(r, state, opts)).map((r) => r.sha);
  assert.deepEqual(pick('used'), [shaOf(19)]);
  assert.deepEqual(pick('pinned'), [shaOf(20)]);
  assert.deepEqual(pick('big'), [shaOf(22)]);
  assert.deepEqual(rows.filter((r) => matchesState(r, 'cleanable', opts)).map((r) => r.sha).sort(), [shaOf(21), shaOf(22)].sort());
  assert.equal(rows.filter((r) => matchesState(r, 'unused', opts)).length, 3);
  assert.equal(rows.filter((r) => matchesState(r, 'hot', opts)).length, 2);
});

await ok('聚合给出真实体积、可清量、最近使用时间（面板顶部数字的来源）', () => {
  const ledger = {};
  touch(ledger, shaOf(23), { nowMs: NOW - 3 * DAY_MS });
  const rows = [row(23, { bytes: 200 * 1024, ageDays: 40 }), row(24, { bytes: 1024, ageDays: 20 }), row(25, { bytes: 600 * 1024, ageDays: 2 })];
  const stats = aggregate(rows, { ledger, nowMs: NOW });
  assert.equal(stats.total, 3);
  assert.equal(stats.totalBytes, 200 * 1024 + 1024 + 600 * 1024);
  assert.equal(stats.cleanable.count, 1);
  assert.equal(stats.cleanable.bytes, 1024);
  assert.equal(stats.lastUsedMs, NOW - 3 * DAY_MS);
  assert.equal(stats.buckets.find((entry) => entry.id === '3d').count, 1);
  assert.equal(stats.buckets.find((entry) => entry.id === 'older').count, 1);
  assert.equal(stats.states.noise, 1);
  assert.equal(stats.stateBytes.big, 600 * 1024);
});

await ok('账本读写走 JSON；读不到就用空账本，写失败不抛（附件库只读的约束）', async () => {
  const io = memIo(new Map());
  assert.deepEqual(await readJson(io, LEDGER_PATH, {}), {});
  const ledger = {};
  touch(ledger, shaOf(30), { sessionId: 's9', nowMs: NOW });
  assert.equal(await writeJson(io, LEDGER_PATH, ledger), true);
  const back = await readJson(io, LEDGER_PATH, {});
  assert.equal(back.entries[shaOf(30)].uses, 1);
});

// ---- 清理候选 ----
await ok('候选 = 未引用 && 满 14 天 && 未置顶 && 非当前会话，按最老排', () => {
  const ledger = {};
  touch(ledger, shaOf(31), { nowMs: NOW - DAY_MS });
  const pins = { shas: [shaOf(32)] };
  const rows = decorate([row(31, { ageDays: 30 }), row(32, { ageDays: 40 }), row(33, { ageDays: 45 }), row(34, { ageDays: 5 })], { ledger, pins, nowMs: NOW });
  const found = candidates(rows, { classifyRow: (r) => r });
  assert.deepEqual(found.candidates.map((c) => c.sha), [shaOf(33)]);
  assert.equal(found.count, 1);
  assert.equal(found.bytes, 100 * 1024);
});

// ---- 回收站：搬走 / 撤销 / 到期真删 ----
await ok('moveToTrash 搬对象 + 写清单 + 清工作区缩略副本；置顶拒绝；可撤销；到期才真删', async () => {
  const files = new Map();
  const io = memIo(files);
  const root = '/home/u/.dsh/attachments/v1';
  const a = shaOf(41);
  const b = shaOf(42);
  const c = shaOf(43);
  for (const sha of [a, b, c]) files.set(`${root}/objects/${sha.slice(0, 2)}/${sha}`, { size: 1000 });
  files.set(`/w/.dsh/pics/pic-1008-1000-${a.slice(0, 8)}.png`, { size: 10 });
  const pins = { shas: [c] };
  const result = await moveToTrash({ root, trashRoot: TRASH, shas: [a, b, c], io, nowMs: NOW, pinnedCheck: (sha) => isPinned(pins, sha), cwds: ['/w'] });
  assert.equal(result.moved.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].reason.includes('置顶'));
  assert.equal(result.removedThumbs, 1);
  assert.equal(files.has(`${P(TRASH)}/objects/${a.slice(0, 2)}/${a}`), true);
  assert.equal(files.has(`${root}/objects/${a.slice(0, 2)}/${a}`), false);

  const list = await listTrash({ trashRoot: TRASH, io, nowMs: NOW });
  assert.equal(list.count, 2);
  assert.equal(list.bytes, 2000);
  assert.equal(list.entries[0].daysInTrash, 0);
  assert.equal(list.entries[0].purgeAfterMs, NOW + TRASH_KEEP_DAYS * DAY_MS);

  const back = await restoreFromTrash({ root, trashRoot: TRASH, ids: [list.entries[0].id], io });
  assert.equal(back.restored.length, 1);
  const movedBack = list.entries[0];
  assert.equal(files.has(`${root}/objects/${movedBack.sha.slice(0, 2)}/${movedBack.sha}`), true);
  assert.equal((await listTrash({ trashRoot: TRASH, io, nowMs: NOW })).count, 1);

  const kept = await purgeTrash({ trashRoot: TRASH, io, nowMs: NOW });
  assert.equal(kept.purged.length, 0);
  assert.equal(kept.kept, 1);
  const purged = await purgeTrash({ trashRoot: TRASH, io, nowMs: NOW + (TRASH_KEEP_DAYS + 1) * DAY_MS });
  assert.equal(purged.purged.length, 1);
  assert.equal(purged.bytes, 1000);
});

await ok('moveToTrash 对不存在的 sha / 非法 sha 只报不动作，不抛', async () => {
  const files = new Map();
  const io = memIo(files);
  const result = await moveToTrash({ root: '/r', trashRoot: TRASH, shas: [shaOf(51), 'zz'], io });
  assert.equal(result.moved.length, 0);
  assert.equal(result.skipped.length, 2);
});

await ok('已在回收站里的 sha 不会被二次搬走', async () => {
  const files = new Map();
  const io = memIo(files);
  const root = '/r';
  const sha = shaOf(55);
  files.set(`${root}/objects/${sha.slice(0, 2)}/${sha}`, { size: 10 });
  const first = await moveToTrash({ root, trashRoot: TRASH, shas: [sha], io });
  const second = await moveToTrash({ root, trashRoot: TRASH, shas: [sha], io });
  assert.equal(first.moved.length, 1);
  assert.equal(second.moved.length, 0);
  assert.ok(second.skipped[0].reason.includes('回收站'));
});

await ok('cleanMaterialized 只删带这段 sha8 的缩略副本，别的不碰', async () => {
  const files = new Map();
  const io = memIo(files);
  const sha = shaOf(61);
  files.set(`/w/.dsh/pics/pic-1008-1000-${sha.slice(0, 8)}.png`, { size: 1 });
  files.set('/w/.dsh/pics/pic-1008-1000-ffffffff.png', { size: 1 });
  const out = await cleanMaterialized({ cwds: ['/w'], shas: [sha], io });
  assert.equal(out.removed, 1);
  assert.equal(files.has('/w/.dsh/pics/pic-1008-1000-ffffffff.png'), true);
});

console.log(`\n${checks} checks passed`);

/** 内存文件系统：只实现 cleanup.js / ledger.js 用到的那几个调用。 */
function memIo(files) {
  const norm = (p) => String(p).replace(/\\/g, '/');
  return {
    async stat(p) {
      const key = norm(p);
      const hit = files.get(key);
      if (hit !== undefined) return { size: hit.size ?? 0, isFile: () => true };
      throw new Error(`ENOENT ${key}`);
    },
    async mkdir(p) {
      files.set(norm(p) + '/', { size: 0 });
    },
    async readFile(p) {
      const hit = files.get(norm(p));
      if (hit?.text !== undefined) return hit.text;
      throw new Error(`ENOENT ${norm(p)}`);
    },
    async writeFile(p, text) {
      files.set(norm(p), { size: String(text).length, text });
    },
    async rename(from, to) {
      const hit = files.get(norm(from));
      if (hit === undefined) throw new Error(`ENOENT ${norm(from)}`);
      files.delete(norm(from));
      files.set(norm(to), hit);
    },
    async rm(p) {
      files.delete(norm(p));
    },
    async readdir(p) {
      const prefix = norm(p) + '/';
      const out = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) out.push(rest);
      }
      return out;
    }
  };
}
