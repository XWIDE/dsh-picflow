/**
 * dsh-picflow · cleanup.js —— 清理候选、回收站（搬走 / 撤销 / 到期真删）。
 *
 * 安全边界，三条都是硬约束：
 *   1. 只搬「未引用 && 满 14 天 && 未置顶 && 不属于当前会话」的（判据在 ledger.js）；
 *   2. 删除 = 搬到 <home>/trash/dsh-picflow/ 下的镜像目录结构 + manifest，保留 7 天可撤销；
 *   3. 被会话逐字稿引用过的图由调用方传 referenced 集合进来，一律排除。
 * 附件库对插件是只读的：这里唯一的写动作就是「搬走/搬回」，绝不原地改内容。
 */
import nodeFs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

export const TRASH_KEEP_DAYS = 7;
export const DEFAULT_AGE_DAYS = 14;
const DAY_MS = 86_400_000;
const SOURCES = ['objects', 'request-images'];
const io_default = nodeFs;

/** 回收站根：<home>/trash/dsh-picflow —— 官方 trash 目录下开自己的分区。 */
export function trashRootFor(home) {
  return join(home, 'trash', 'dsh-picflow');
}

async function exists(io, path) {
  try {
    const stat = await io.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJsonSafe(io, path, fallback) {
  try {
    return JSON.parse(String(await io.readFile(path)));
  } catch {
    return fallback;
  }
}

async function writeManifest(io, trashRoot, manifest) {
  try {
    await io.mkdir(dirname(join(trashRoot, 'x')), { recursive: true });
    await io.writeFile(join(trashRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return true;
  } catch {
    return false;
  }
}

async function loadManifest(io, trashRoot) {
  const raw = await readJsonSafe(io, join(trashRoot, 'manifest.json'), null);
  if (Array.isArray(raw)) return { entries: raw };
  if (raw && Array.isArray(raw.entries)) return raw;
  return { entries: [] };
}

function stamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 对象在库里的路径：<root>/<source>/<sha2>/<sha> */
function objectPath(root, source, sha) {
  return join(root, source, sha.slice(0, 2), sha);
}

/**
 * 清理候选：吃 decorate 过的行，返回可清的那些（默认边界 >14 天且从未引用）。
 * referenced = 被会话逐字稿引用过的 sha 集合，命中即排除。
 */
export function candidates(rows, { classifyRow, referenced = new Set() } = {}) {
  const out = [];
  let bytes = 0;
  for (const row of rows) {
    const info = classifyRow ? classifyRow(row) : row;
    if (info?.cleanable !== true) continue;
    if (referenced.has(row.sha)) continue;
    out.push(row);
    bytes += row.bytes;
  }
  out.sort((a, b) => a.modifiedMs - b.modifiedMs);
  return { candidates: out, count: out.length, bytes };
}

/**
 * 搬进回收站。逐个搬，失败的不阻塞后面的；置顶的一律拒绝。
 * 返回 { ok, moved[], skipped[{sha,reason}], manifest }
 */
export async function moveToTrash({ root, trashRoot, shas = [], sources = SOURCES, io = io_default, nowMs = Date.now(), pinnedCheck = () => false, cwds = [] } = {}) {
  const manifest = await loadManifest(io, trashRoot);
  const moved = [];
  const skipped = [];
  for (const sha of shas) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      skipped.push({ sha: String(sha).slice(0, 12), reason: '编号非法' });
      continue;
    }
    if (pinnedCheck(sha)) {
      skipped.push({ sha, reason: '已置顶，不动' });
      continue;
    }
    const foundSource = await (async () => {
      for (const src of sources) {
        if (await exists(io, objectPath(root, src, sha))) return src;
      }
      return null;
    })();
    if (foundSource === null) {
      const inTrash = await exists(io, join(trashRoot, 'objects', sha.slice(0, 2), sha));
      skipped.push({ sha, reason: inTrash ? '已在回收站里' : '库里找不到这个对象' });
      continue;
    }
    const from = objectPath(root, foundSource, sha);
    const to = join(trashRoot, foundSource, sha.slice(0, 2), sha);
    try {
      await io.mkdir(dirname(to), { recursive: true });
      const stat = await io.stat(from);
      await io.rename(from, to);
      // id 带序号：同一分钟搬进多张图时，sha 前 8 位相同也不会撞号
      const entry = {
        id: `${stamp(nowMs)}-${sha.slice(0, 8)}-${manifest.entries.length + 1}`,
        sha,
        source: foundSource,
        bytes: stat.size,
        movedMs: nowMs,
        from,
        to
      };
      manifest.entries.push(entry);
      moved.push(entry);
    } catch (error) {
      skipped.push({ sha, reason: `搬走失败：${String(error?.code ?? error?.message ?? error).slice(0, 60)}` });
    }
  }
  await writeManifest(io, trashRoot, manifest);
  // 工作区里的缩略副本跟着一起清，面板不留死图
  const cleaned = await cleanMaterialized({ cwds, shas, io });
  return { ok: true, moved, skipped, removedThumbs: cleaned.removed, manifest };
}

/** 删掉 <cwd>/.dsh/pics/ 里对应这些 sha 的缩略副本（文件名里带 sha 前 8 位）。 */
export async function cleanMaterialized({ cwds = [], shas = [], io = io_default } = {}) {
  let removed = 0;
  const marks = shas.filter((s) => typeof s === 'string' && s.length === 64).map((s) => s.slice(0, 8));
  if (marks.length === 0) return { removed };
  for (const cwd of cwds) {
    const dir = join(cwd, '.dsh', 'pics');
    let names = [];
    try {
      names = await io.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!marks.some((mark) => name.includes(`-${mark}.`))) continue;
      try {
        await io.rm(join(dir, name));
        removed += 1;
      } catch {
        /* 留着，下次清理再试 */
      }
    }
  }
  return { removed };
}

/** 回收站清单：每条给「在回收站里第几天 / 到期真删时间」，面板据此显示撤销。 */
export async function listTrash({ trashRoot, io = io_default, nowMs = Date.now() } = {}) {
  const manifest = await loadManifest(io, trashRoot);
  const entries = [];
  let bytes = 0;
  for (const entry of manifest.entries) {
    const present = await exists(io, entry.to ?? join(trashRoot, entry.source, entry.sha.slice(0, 2), entry.sha));
    const daysInTrash = Math.floor((nowMs - (entry.movedMs ?? nowMs)) / DAY_MS);
    entries.push({ ...entry, present: present, daysInTrash, purgeAfterMs: (entry.movedMs ?? nowMs) + TRASH_KEEP_DAYS * DAY_MS, missing: !present });
    if (present) bytes += entry.bytes ?? 0;
  }
  entries.sort((a, b) => (b.movedMs ?? 0) - (a.movedMs ?? 0));
  return { entries, count: entries.length, bytes, manifest };
}

/** 撤销：把选中条目搬回库里原位置（ids 为空 = 全部撤销）。 */
export async function restoreFromTrash({ root, trashRoot, ids = [], io = io_default } = {}) {
  const manifest = await loadManifest(io, trashRoot);
  const restored = [];
  const skipped = [];
  const keep = [];
  for (const entry of manifest.entries) {
    const selected = ids.length === 0 || ids.includes(entry.id);
    if (!selected) {
      keep.push(entry);
      continue;
    }
    const from = entry.to ?? join(trashRoot, entry.source, entry.sha.slice(0, 2), entry.sha);
    const to = objectPath(root, entry.source, entry.sha);
    try {
      await io.mkdir(dirname(to), { recursive: true });
      await io.rename(from, to);
      restored.push(entry);
    } catch (error) {
      skipped.push({ ...entry, reason: `搬回失败：${String(error?.code ?? error?.message ?? error).slice(0, 60)}` });
      keep.push(entry);
    }
  }
  await writeManifest(io, trashRoot, { entries: keep });
  return { ok: true, restored, skipped };
}

/** 到期真删：回收站里超过保留期的条目才动。 */
export async function purgeTrash({ trashRoot, io = io_default, nowMs = Date.now(), keepDays = TRASH_KEEP_DAYS } = {}) {
  const manifest = await loadManifest(io, trashRoot);
  const purged = [];
  const kept = [];
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (nowMs - (entry.movedMs ?? 0) < keepDays * DAY_MS) {
      kept.push(entry);
      continue;
    }
    const path = entry.to ?? join(trashRoot, entry.source, entry.sha.slice(0, 2), entry.sha);
    try {
      await io.rm(path, { force: true });
      purged.push(entry);
      bytes += entry.bytes ?? 0;
    } catch {
      kept.push(entry);
    }
  }
  await writeManifest(io, trashRoot, { entries: kept });
  return { ok: true, purged, bytes, kept: kept.length };
}
