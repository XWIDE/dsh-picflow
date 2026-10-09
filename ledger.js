// 使用账本 + 状态判定。纯逻辑，无依赖，可脱离插件单独跑测试。
//
// 为什么要账本：面板要回答「哪些图我用过了、哪些再也不会用」，
// 而附件库只有 mtime（入库时间），没有任何"被用过"的信号。
// 实测过 request-images 不能逐图对齐（发给模型的是重编码副本，sha 变了），
// 所以"用过"只能由插件自己记：谁被插进正文、谁被挂上，就记谁。
//
// 四态（state）：
//   hot   近 hotDays 天用过 / 置顶 / 属于当前会话  —— 永不清
//   warm  近 warmDays 天用过                      —— 默认不清
//   cold  从未被引用，且入库超过 ageDays 天        —— 清理候选
//   fresh 从未被引用，但还在 ageDays 天内          —— 观望
// 噪音（noise）是与四态正交的标记：体积小于 NOISE_BYTES 的小图。
import { join } from 'node:path';

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 小于这个体积的图算噪音（实测：库里 <20 KB 的 60 张合计只有 0.5 MB）。 */
export const NOISE_BYTES = 20 * 1024;
/** 大文件门槛（实测：>500 KB 的 103 张占了全部体积的 70%）。 */
export const BIG_BYTES = 500 * 1024;

export const DEFAULT_AGE_DAYS = 14;
export const DEFAULT_HOT_DAYS = 7;
export const DEFAULT_WARM_DAYS = 30;

const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_SESSIONS_PER_ENTRY = 8;
const MAX_LEDGER_ENTRIES = 20000;

/** 插件自己的数据目录（附件库只读，账本必须放自己的地方）。 */
export function dataDir(home) {
  return join(home, 'dsh-picflow');
}

export function ledgerPath(home) {
  return join(dataDir(home), 'usage.json');
}

export function pinsPath(home) {
  return join(dataDir(home), 'pins.json');
}

export async function readJson(io, path, fallback = {}) {
  try {
    const text = await io.readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJson(io, path, value) {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
  try {
    await io.mkdir(dir, { recursive: true });
    await io.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false; // 账本写不进去不该让面板报错
  }
}

/** 记一次"用过"。kind 只用于人读（insert / attach / auto / pin）。 */
export function touch(ledger, sha, { sessionId = '', kind = 'insert', nowMs = Date.now() } = {}) {
  const key = String(sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(key)) return undefined;
  if (ledger.entries === null || typeof ledger.entries !== 'object') ledger.entries = {};
  const names = Object.keys(ledger.entries);
  if (names.length >= MAX_LEDGER_ENTRIES && ledger.entries[key] === undefined) {
    // 账本只会越用越准，不做淘汰；真到上限时丢掉最老的一条，避免文件失控。
    const oldest = names.sort((a, b) => (ledger.entries[a]?.lastMs ?? 0) - (ledger.entries[b]?.lastMs ?? 0))[0];
    if (oldest !== undefined) delete ledger.entries[oldest];
  }
  const prev = ledger.entries[key] ?? { firstMs: nowMs, uses: 0, sessions: [] };
  const entry = {
    firstMs: prev.firstMs ?? nowMs,
    lastMs: nowMs,
    uses: (prev.uses ?? 0) + 1,
    kinds: Array.from(new Set([...(prev.kinds ?? []), String(kind)])).slice(0, 6),
    sessions: Array.from(new Set([sessionId, ...(prev.sessions ?? [])].filter((id) => typeof id === 'string' && id !== ''))).slice(0, MAX_SESSIONS_PER_ENTRY)
  };
  ledger.entries[key] = entry;
  ledger.updatedMs = nowMs;
  return entry;
}

export function entryOf(ledger, sha) {
  const key = String(sha ?? '').trim().toLowerCase();
  return ledger?.entries?.[key];
}

/** 置顶是用户意志，优先于任何统计判定。 */
export function isPinned(pins, sha) {
  const key = String(sha ?? '').trim().toLowerCase();
  const list = Array.isArray(pins?.shas) ? pins.shas : [];
  return list.some((entry) => String(entry).toLowerCase() === key);
}

export function togglePin(pins, sha, nowMs = Date.now()) {
  const key = String(sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(key)) return { pinned: false, pins };
  const list = Array.isArray(pins?.shas) ? pins.shas.map((e) => String(e).toLowerCase()) : [];
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1);
  else list.unshift(key);
  pins.shas = list;
  pins.updatedMs = nowMs;
  return { pinned: at < 0, pins };
}

/**
 * 一行图属于哪一态。reasons 是给面板写的"为什么"，清理向导要展示它，
 * 否则用户面对一堆勾选框只能瞎选。
 */
export function classify(row, { ledger = {}, pins = {}, nowMs = Date.now(), ageDays = DEFAULT_AGE_DAYS, hotDays = DEFAULT_HOT_DAYS, warmDays = DEFAULT_WARM_DAYS, sessionId = '' } = {}) {
  const entry = entryOf(ledger, row.sha);
  const pinned = isPinned(pins, row.sha);
  const uses = entry?.uses ?? 0;
  const lastUsedMs = entry?.lastMs ?? null;
  const inSession = sessionId !== '' && Array.isArray(entry?.sessions) && entry.sessions.includes(sessionId);
  const ageDays_ = Math.max(0, Math.floor((nowMs - row.modifiedMs) / DAY_MS));
  const noise = row.bytes < NOISE_BYTES;
  const reasons = [];

  let state = 'fresh';
  if (uses > 0) {
    const usedDays = Math.floor((nowMs - lastUsedMs) / DAY_MS);
    if (usedDays <= hotDays) {
      state = 'hot';
      reasons.push(`近 ${Math.max(usedDays, 0)} 天用过 ${uses} 次`);
    } else if (usedDays <= warmDays) {
      state = 'warm';
      reasons.push(`${usedDays} 天前用过（共 ${uses} 次）`);
    } else {
      state = 'cold';
      reasons.push(`${uses} 次使用都在 ${usedDays} 天前`);
    }
  } else {
    // 从未被引用：满清理边界天数才算冷，刚入库的不算（否则新图会被建议清走）
    state = ageDays_ >= ageDays ? 'cold' : 'fresh';
    reasons.push(ageDays_ > 0 ? `入库 ${ageDays_} 天，从未被引用` : '刚入库，尚未被引用');
  }
  if (pinned) {
    state = 'hot';
    reasons.unshift('已置顶');
  }
  if (inSession) {
    state = 'hot';
    reasons.unshift('属于当前会话');
  }
  if (noise) reasons.push(`小噪音（${Math.max(1, Math.round(row.bytes / 1024))} KB）`);

  const cleanable = !pinned && !inSession && uses === 0 && ageDays_ >= ageDays;
  return { state, reasons, pinned, noise, uses, lastUsedMs, ageDays: ageDays_, cleanable, big: row.bytes > BIG_BYTES };
}

/** 给清单里的每一行贴上状态字段（面板和向导都吃这个）。 */
export function decorate(rows, options = {}) {
  return rows.map((row) => ({ ...row, ...classify(row, options) }));
}

/** 时间桶：滚动窗口，恒定 5 个 chip，不会随天数堆积。 */
export const TIME_BUCKETS = [
  { id: 'all', label: '全部', days: null },
  { id: '3d', label: '近3天', days: 3 },
  { id: '7d', label: '近7天', days: 7 },
  { id: '30d', label: '近30天', days: 30 },
  { id: 'older', label: '更早', days: -30 }
];

export function inTimeBucket(row, bucketId, nowMs = Date.now()) {
  const bucket = TIME_BUCKETS.find((entry) => entry.id === bucketId);
  if (bucket === undefined || bucket.days === null) return true;
  const age = (nowMs - row.modifiedMs) / DAY_MS;
  if (bucket.days < 0) return age > -bucket.days;
  return age <= bucket.days;
}

export function matchesState(row, state, { ledger = {}, pins = {}, nowMs = Date.now(), sessionId = '', ageDays = DEFAULT_AGE_DAYS } = {}) {
  if (state === '' || state === undefined) return true;
  const info = row.state !== undefined && row.pinned !== undefined ? row : classify(row, { ledger, pins, nowMs, sessionId, ageDays });
  if (state === 'used') return (info.uses ?? 0) > 0;
  if (state === 'unused') return (info.uses ?? 0) === 0;
  if (state === 'pinned') return info.pinned === true;
  if (state === 'big') return info.big === true;
  if (state === 'noise') return info.noise === true;
  if (state === 'cleanable') return info.cleanable === true;
  return info.state === state; // hot / warm / cold / fresh
}

/** 面板顶部的三个数字：磁盘真实体积、可清量、最近使用时间。 */
export function aggregate(rows, { ledger = {}, pins = {}, nowMs = Date.now(), ageDays = DEFAULT_AGE_DAYS, sessionId = '' } = {}) {
  // 数组，按 TIME_BUCKETS 顺序 —— 客户端直接按这个顺序画 chip，不多不少 5 个
  const buckets = [];
  for (const bucket of TIME_BUCKETS) {
    let count = 0;
    let bytes = 0;
    for (const row of rows) {
      if (!inTimeBucket(row, bucket.id, nowMs)) continue;
      count += 1;
      bytes += row.bytes;
    }
    buckets.push({ id: bucket.id, label: bucket.label, days: bucket.days, count, bytes });
  }
  const states = { hot: 0, warm: 0, cold: 0, fresh: 0, noise: 0, big: 0, pinned: 0, used: 0, unused: 0, cleanable: 0 };
  const stateBytes = { hot: 0, warm: 0, cold: 0, fresh: 0, noise: 0, big: 0, pinned: 0, used: 0, unused: 0, cleanable: 0 };
  let totalBytes = 0;
  let lastUsedMs = 0;
  for (const row of rows) {
    const info = classify(row, { ledger, pins, nowMs, ageDays, sessionId });
    totalBytes += row.bytes;
    states[info.state] += 1;
    stateBytes[info.state] += row.bytes;
    if (info.noise) {
      states.noise += 1;
      stateBytes.noise += row.bytes;
    }
    if (info.big) {
      states.big += 1;
      stateBytes.big += row.bytes;
    }
    if (info.pinned) {
      states.pinned += 1;
      stateBytes.pinned += row.bytes;
    }
    if (info.uses > 0) {
      states.used += 1;
      stateBytes.used += row.bytes;
      if ((info.lastUsedMs ?? 0) > lastUsedMs) lastUsedMs = info.lastUsedMs;
    } else {
      states.unused += 1;
      stateBytes.unused += row.bytes;
    }
    if (info.cleanable) {
      states.cleanable += 1;
      stateBytes.cleanable += row.bytes;
    }
  }
  return {
    total: rows.length,
    totalBytes,
    buckets,
    states,
    stateBytes,
    cleanable: { count: states.cleanable, bytes: stateBytes.cleanable },
    lastUsedMs: lastUsedMs > 0 ? lastUsedMs : null,
    ageDays
  };
}
