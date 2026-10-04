// dsh-picflow — 宿主半边
//
// 全部走官方 web 路由面（ctx.webServer.register）：
//   1. GET  /plugins/dsh-picflow/images —— 扫附件库里的「粘贴图片」目录，
//      支持搜索/按天/排序/分页，可选把前 N 张（或 pin 点名的那张）
//      落一份带扩展名的副本到 <工作区>/.dsh/pics/，好让模型用 read_image 读。
//   2. GET  /plugins/dsh-picflow/raw?ref=sha256:… —— 把某张图的原始字节
//      回给浏览器（面板缩略图 / 「挂成附件」时取字节）。
//   3. GET  /plugins/dsh-picflow/version —— 附件库指纹（廉价，只 stat 分片目录），
//      客户端轮询它就知道「库变了」，不用等用户重启。
//   4. POST /plugins/dsh-picflow/admit?session=…&name=… —— 把「刚 Ctrl+V、
//      还没发送」的图片字节入库。没发送的图只在渲染进程内存里（官方的
//      draft attachment 是 runtime-only 的），宿主扫不到；客户端把字节送过来，
//      这里调官方 attachments.saveImage 走同一套规范化 ⇒ sha 与之后发送时
//      落库的那份完全相同，天然去重，编号也一致。
//
// 为什么不用官方 attachments 服务：那个服务的清单面只认 files/（文档类），
// 粘贴进来的图片落在 objects/，没有任何服务读它——本插件直接读目录。
// 目录布局（实测）：<DSH_HOME>/attachments/v1/{objects,request-images}/<sha2>/<sha64>，
// 文件无扩展名、无原名，内容即 sha256，所以按 magic 头嗅探格式。
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis 插件名——必须与 cordis.patch.yml 里的行 id 一致。 */
export const name = 'dsh-picflow';

const BASE = '/plugins/dsh-picflow';
/** 粘贴图片（objects）与真正发给模型的图（request-images）。前者优先。 */
const SOURCES = ['objects', 'request-images'];
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
};
const SHA_RE = /^[0-9a-f]{64}$/;
const SHARD_RE = /^[0-9a-f]{2}$/;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 400;
/** 单张图字节上限：超过就不列（附件库里的图实测都在 1 MB 以内）。 */
const MAX_BYTES = 32 * 1024 * 1024;
const HEAD_BYTES = 16;

/** 附件库根：DSH_HOME 优先，否则 ~/.dsh（与官方 defaultAttachmentsDir 同规则）。 */
export function attachmentsRoot(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const base = home !== '' ? home : join(homedir(), '.dsh');
  return join(base, 'attachments', 'v1');
}

/** 按 magic 头认格式——库里既没有扩展名也没有文件名可用。 */
export function sniffExt(head) {
  if (head === undefined || head.length < 2) return undefined;
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'gif';
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) return 'webp';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  return undefined;
}

async function readHead(path) {
  const handle = await fsp.open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const pad = (value) => String(value).padStart(2, '0');

/** 文件名用的时间戳（本地时区）：1004-2255。 */
export function stampOf(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 给人看的时间标签：10-04 22:55。 */
export function labelOf(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 落盘副本的名字，同时充当重新挂成附件时的文件名（带正确扩展名）。 */
export function exportName(row) {
  return `pic-${stampOf(row.modifiedMs)}-${row.sha.slice(0, 8)}.${row.ext}`;
}

/**
 * 候选（未嗅探）：附件库里所有 sha blob，同一 sha 只留一条（objects 优先，
 * 因为粘贴那一刻的时间戳更接近用户记忆里的「我刚贴的那张」）。
 */
async function collectCandidates(root) {
  const bySha = new Map();
  for (const source of SOURCES) {
    const dir = join(root, source);
    let shards;
    try {
      shards = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const shard of shards) {
      if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue;
      const shardDir = join(dir, shard.name);
      let entries;
      try {
        entries = await fsp.readdir(shardDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !SHA_RE.test(entry.name)) continue;
        const prior = bySha.get(entry.name);
        if (prior !== undefined && prior.source === 'objects') continue;
        const path = join(shardDir, entry.name);
        let stat;
        try {
          stat = await fsp.stat(path);
        } catch {
          continue;
        }
        if (stat.size === 0 || stat.size > MAX_BYTES) continue;
        bySha.set(entry.name, { sha: entry.name, file: path, bytes: stat.size, modifiedMs: stat.mtimeMs, source });
      }
    }
  }
  return Array.from(bySha.values());
}

/**
 * 廉价的库指纹：只 readdir + stat 分片目录，不嗅探任何 blob。
 * 新图落进某个分片目录会刷新那个目录的 mtime，所以「分片目录 mtime 的最大值 + 分片数」
 * 足以判断库里有没有新增（客户端靠它决定要不要重新拉清单）。
 */
export async function libraryStamp(root) {
  let newest = 0;
  let shards = 0;
  for (const source of SOURCES) {
    const dir = join(root, source);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SHARD_RE.test(entry.name)) continue;
      try {
        const stat = await fsp.stat(join(dir, entry.name));
        shards += 1;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        continue;
      }
    }
  }
  return `${Math.round(newest)}:${shards}`;
}

/** 给人看的日标签：10-04。 */
export function dayOf(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 搜索词里的「今天/昨天/前天」。 */
const DAY_WORDS = { 今天: 0, 昨天: 1, 前天: 2 };

/**
 * 搜索词归一化：支持
 *  - `10-04`（日）、`今天/昨天/前天`
 *  - `图片12` / `图12` / `12`（固定编号）
 *  - `png`、`objects`、`128kb`、sha 前缀、`10-04 22:55`
 */
export function normalizeQuery(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === '') return { text: '', ordinal: undefined, day: '' };
  const word = DAY_WORDS[text];
  if (word !== undefined) {
    return { text: '', ordinal: undefined, day: dayOf(Date.now() - word * 86400000) };
  }
  const ordinal = /^(?:图片|图|pic)?\s*(\d{1,4})$/.exec(text);
  if (ordinal !== null) return { text, ordinal: Number(ordinal[1]), day: '' };
  return { text, ordinal: undefined, day: '' };
}

function matchesQuery(row, query) {
  if (query.ordinal !== undefined) return row.ordinal === query.ordinal;
  if (query.day !== '') return row.day === query.day;
  if (query.text === '') return true;
  const haystack = `${row.label} ${row.stamp} ${row.day} ${row.sha} ${row.ext} ${row.source} ${row.filename} ${row.ordinal} ${Math.round(row.bytes / 1024)}kb`.toLowerCase();
  return haystack.includes(query.text);
}

function sortRows(rows, sort) {
  const copy = rows.slice();
  if (sort === 'old') copy.sort((a, b) => a.modifiedMs - b.modifiedMs || a.sha.localeCompare(b.sha));
  else if (sort === 'big') copy.sort((a, b) => b.bytes - a.bytes || b.modifiedMs - a.modifiedMs);
  else copy.sort((a, b) => b.modifiedMs - a.modifiedMs || a.sha.localeCompare(b.sha));
  return copy;
}

/**
 * 全库清单：collect → 按 mtime 升序 → 嗅探 → 固定编号。
 * 编号和排序都从这一份出，所以「图片N」在任何入口（清单/点名/入库）都是同一个号。
 */
async function loadLibrary(root) {
  const candidates = await collectCandidates(root);
  candidates.sort((a, b) => a.modifiedMs - b.modifiedMs || a.sha.localeCompare(b.sha));
  const all = [];
  for (const row of candidates) {
    let ext;
    try {
      ext = sniffExt(await readHead(row.file));
    } catch {
      continue;
    }
    if (ext === undefined) continue;
    all.push({
      ...row,
      ext,
      stamp: stampOf(row.modifiedMs),
      label: labelOf(row.modifiedMs),
      day: dayOf(row.modifiedMs),
      filename: exportName({ ...row, ext }),
      ordinal: all.length + 1
    });
  }
  const counts = new Map();
  for (const row of all) counts.set(row.day, (counts.get(row.day) ?? 0) + 1);
  const days = Array.from(counts.entries())
    .map(([value, count]) => ({ day: value, count }))
    .sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1));
  return { all, days };
}

/**
 * 扫附件库 + 过滤 + 分页。
 * `ordinal` 是按「老 → 新」排出来的固定编号：新图只会拿到更大的号，
 * 已有图的号永远不变（编号能当身份用，插进正文的「图片N」不会指错图）。
 */
export async function queryImages(root, options = {}) {
  const rawLimit = Number(options.limit);
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT), MAX_LIMIT);
  const rawOffset = Number(options.offset);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
  const sort = options.sort === 'old' || options.sort === 'big' ? options.sort : 'new';
  const query = normalizeQuery(options.q);
  const day = typeof options.day === 'string' ? options.day.trim() : '';
  const source = typeof options.source === 'string' ? options.source.trim() : '';

  const { all, days } = await loadLibrary(root);
  const matched = all.filter(
    (row) => (day === '' || row.day === day) && (source === '' || row.source === source) && matchesQuery(row, query)
  );
  const page = sortRows(matched, sort).slice(offset, offset + limit);
  return {
    rows: page,
    total: matched.length,
    libraryTotal: all.length,
    days,
    sort,
    hasMore: offset + limit < matched.length,
    nextOffset: offset + limit
  };
}

/**
 * 按 sha 求那一行（带固定编号）。刚入库的图立刻要有一个号，走这里；
 * 全库扫一次 ~0.4s，只发生在用户粘贴那一刻和点名落盘时。
 */
export async function ordinalOf(root, sha) {
  const target = String(sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(target)) return undefined;
  const { all } = await loadLibrary(root);
  return all.find((row) => row.sha === target);
}

/** 兼容旧调用：只拿一页。 */
export async function scanImages(root, limit = DEFAULT_LIMIT) {
  const { rows } = await queryImages(root, { limit });
  return rows;
}

/** 按 sha 取单行（面板里按需落盘时用，不必全库重扫）。 */
export async function findRow(root, sha) {
  const hit = await findObject(root, sha);
  if (hit === undefined) return undefined;
  let ext;
  let stat;
  try {
    ext = sniffExt(await readHead(hit.path));
    stat = await fsp.stat(hit.path);
  } catch {
    return undefined;
  }
  if (ext === undefined) return undefined;
  const source = hit.path.split(/[\\/]/).includes('request-images') ? 'request-images' : 'objects';
  const row = { sha, file: hit.path, bytes: stat.size, modifiedMs: stat.mtimeMs, source, ext };
  return {
    ...row,
    stamp: stampOf(row.modifiedMs),
    label: labelOf(row.modifiedMs),
    day: dayOf(row.modifiedMs),
    filename: exportName(row)
  };
}

/** 从 sha 找原文件（objects 优先）。 */
export async function findObject(root, sha) {
  for (const source of SOURCES) {
    const path = join(root, source, sha.slice(0, 2), sha);
    try {
      const stat = await fsp.stat(path);
      if (stat.isFile()) return { path, bytes: stat.size };
    } catch {
      /* 换下一个目录 */
    }
  }
  return undefined;
}

/**
 * 把图落一份带扩展名的副本到 <cwd>/.dsh/pics/，返回绝对路径。
 * 幂等：同尺寸同名就跳过，重复调用不会反复拷贝。
 */
export async function materializeInto(cwd, rows, io = fsp) {
  const dir = join(cwd, '.dsh', 'pics');
  await io.mkdir(dir, { recursive: true });
  let written = 0;
  for (const row of rows) {
    const dest = join(dir, row.filename);
    try {
      const stat = await io.stat(dest);
      if (stat.size === row.bytes) {
        row.path = dest;
        continue;
      }
    } catch {
      /* 还没副本，往下写 */
    }
    await io.copyFile(row.file, dest);
    row.path = dest;
    written += 1;
  }
  return { dir, written };
}

// ===================== HTTP 面 =====================

function queryParam(url, name) {
  try {
    const value = new URL(url, 'http://local').searchParams.get(name);
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

function queryInt(url, name, fallback, max) {
  const raw = queryParam(url, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  });
  res.end(body);
}

/** 单张入库图的字节上限（官方 maxImageBytes 是 20 MB，这里留点余量后自己先挡掉）。 */
const ADMIT_MAX_BYTES = 24 * 1024 * 1024;

/** 收 POST 体：官方插件里就是这么读的（dsh-client-connection / dsh-host-open-in-app）。 */
async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** 取官方附件服务（宿主半边注入的 'attachments'）。服务可能不存在，取不到就返回 undefined。 */
function attachmentsOf(ctx) {
  let store;
  try {
    store = typeof ctx.get === 'function' ? ctx.get('attachments') : ctx.attachments;
  } catch {
    store = undefined;
  }
  return store !== undefined && store !== null && typeof store.saveImage === 'function' ? store : undefined;
}

/**
 * 只认回环 host：这个路由能读到本机附件库里的全部图片，不能对局域网开放。
 * 需要域名/局域网访问时把 host[:port] 加进本插件的 trustedHosts 配置。
 */
function authorityOf(headers) {
  const raw = headers?.host;
  if (typeof raw !== 'string') return undefined;
  return raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isTrusted(headers, trustedHosts) {
  const authority = authorityOf(headers);
  if (authority === undefined) return false;
  if (authority === '127.0.0.1' || authority === 'localhost' || authority === '::1' || authority === '0:0:0:0:0:0:0:1') return true;
  const host = typeof headers?.host === 'string' ? headers.host.toLowerCase() : '';
  return trustedHosts.some((entry) => (entry.includes(':') ? entry.toLowerCase() === host : entry.toLowerCase() === authority));
}

function fence(req, res, trustedHosts) {
  if (isTrusted(req.headers, trustedHosts)) return true;
  json(res, 403, {
    ok: false,
    error: 'host-not-trusted',
    hint: `本插件的路由只对回环地址开放（收到 host=${String(req.headers?.host)}）。要允许该来源，把它的 host[:port] 加进 dsh-picflow 的 trustedHosts 配置。`
  });
  return false;
}

function cwdOf(sessions, sessionId) {
  if (sessions === undefined || typeof sessionId !== 'string' || sessionId === '') return undefined;
  let session;
  try {
    session = sessions.get(sessionId);
  } catch {
    return undefined;
  }
  if (session !== undefined && typeof session.then === 'function') return undefined; // 异步面：交给下次刷新
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

function wireRow(row) {
  return {
    ref: `sha256:${row.sha}`,
    sha: row.sha,
    bytes: row.bytes,
    modifiedMs: row.modifiedMs,
    ext: row.ext,
    filename: row.filename,
    stamp: stampOf(row.modifiedMs),
    label: labelOf(row.modifiedMs),
    day: row.day,
    ordinal: row.ordinal,
    source: row.source,
    url: `${BASE}/raw?ref=sha256:${row.sha}`,
    ...(row.path !== undefined ? { path: row.path } : {})
  };
}

/**
 * 注册四条路由。服务可能在本插件 apply 之后才激活，所以走 ctx.inject 延迟注册
 * （与 dsh-files 同一套做法，apply 时直接 ctx.get 会拿到未激活的 webServer）。
 */
export function registerRoutes(ctx, { sessions, trustedHosts = [], root: rootOverride } = {}) {
  const root = rootOverride ?? attachmentsRoot();
  ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/version`,
    handler: async (req, res) => {
      if (!fence(req, res, trustedHosts)) return;
      try {
        const stamp = await libraryStamp(root);
        json(res, 200, { stamp, root });
      } catch (error) {
        json(res, 500, {
          ok: false,
          error: 'stamp-failed',
          hint: `读附件库失败（${root}）：${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  });

  ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/admit`,
    handler: async (req, res) => {
      if (!fence(req, res, trustedHosts)) return;
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed', hint: '贴图入库要走 POST（body 直接放图片字节）。' });
        return;
      }
      const store = attachmentsOf(ctx);
      if (store === undefined) {
        json(res, 501, {
          ok: false,
          error: 'attachments-unavailable',
          hint: '这个部署没有可用的附件服务（ctx.get("attachments") 里没有 saveImage），贴图没法入库。'
        });
        return;
      }
      let bytes;
      try {
        bytes = await readBody(req, ADMIT_MAX_BYTES);
      } catch (error) {
        json(res, 413, {
          ok: false,
          error: 'body-too-large',
          hint: `这张图超过 ${Math.round(ADMIT_MAX_BYTES / 1024 / 1024)} MB，没法入库：${error instanceof Error ? error.message : String(error)}`
        });
        return;
      }
      if (bytes.byteLength === 0) {
        json(res, 400, { ok: false, error: 'empty-body', hint: 'POST body 里没有图片字节。' });
        return;
      }
      // 格式以字节为准（不是 content-type）：官方入库会拿声明的 mediaType 和嗅探结果对表，
      // 声明错了直接抛 IMAGE_TYPE_MISMATCH，所以这里自己先嗅一遍。
      const ext = sniffExt(bytes.subarray(0, HEAD_BYTES));
      if (ext === undefined) {
        json(res, 400, { ok: false, error: 'unsupported-image', hint: '只认 png / jpg / gif / webp 这四种（bmp 附件库不收）。' });
        return;
      }
      const sessionId = queryParam(req.url, 'session');
      const name = queryParam(req.url, 'name');
      let ref;
      try {
        ref = await store.saveImage({
          data: bytes,
          mediaType: MIME[ext],
          ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {})
        });
      } catch (error) {
        json(res, 400, {
          ok: false,
          error: 'admit-failed',
          hint: `入库失败：${error instanceof Error ? error.message : String(error)}`
        });
        return;
      }
      const sha = String(ref?.attachmentId ?? ref?.id ?? '').replace(/^sha256:/i, '').trim().toLowerCase();
      if (!SHA_RE.test(sha)) {
        json(res, 500, { ok: false, error: 'admit-no-ref', hint: '附件服务没有返回 sha256 引用。' });
        return;
      }
      const row = await ordinalOf(root, sha);
      if (row === undefined) {
        json(res, 500, {
          ok: false,
          error: 'admit-not-indexed',
          hint: '图的字节存进去了，但清单里没扫到它（可能不是图片，或刚好被清理了）。'
        });
        return;
      }
      // 落一份带扩展名的副本到工作区，芯片才有路径模型可读；没有工作区就只给编号。
      let path;
      const cwd = cwdOf(sessions, sessionId);
      if (cwd !== undefined) {
        try {
          await materializeInto(cwd, [row]);
          path = row.path;
        } catch {
          path = undefined;
        }
      }
      json(res, 200, {
        ok: true,
        sha,
        ordinal: row.ordinal,
        label: `图片${row.ordinal}`,
        bytes: row.bytes,
        ext,
        ...(path !== undefined ? { path } : {}),
        row: wireRow(row)
      });
    }
  });

  ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/images`,
    handler: async (req, res) => {
      if (!fence(req, res, trustedHosts)) return;
      const url = req.url ?? '';
      const limit = queryInt(url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      const want = queryInt(url, 'materialize', 0, MAX_LIMIT);
      const offset = queryInt(url, 'offset', 0, 100000);
      const q = queryParam(url, 'q');
      const day = queryParam(url, 'day');
      const source = queryParam(url, 'source');
      const sort = queryParam(url, 'sort');
      const pin = queryParam(url, 'pin');
      const sessionId = queryParam(url, 'session');
      try {
        const page = await queryImages(root, { limit, offset, q, day, source, sort });
        const rows = page.rows;
        let note;
        let pinned;
        const pinSha = typeof pin === 'string' ? pin.trim().toLowerCase() : '';
        if (SHA_RE.test(pinSha)) {
          const cwd = cwdOf(sessions, sessionId);
          const target = await findRow(root, pinSha);
          if (target === undefined) {
            note = '这张图已经不在附件库里了。';
          } else if (cwd === undefined) {
            note = '这个会话没有工作区，芯片拿不到磁盘路径。';
          } else {
            try {
              const done = await materializeInto(cwd, [target]);
              pinned = { sha: pinSha, path: target.path, written: done.written };
            } catch (error) {
              note = `写入工作区失败：${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
        if (want > 0 && rows.length > 0) {
          const cwd = cwdOf(sessions, sessionId);
          if (cwd === undefined) {
            note = '这个会话没有工作区，正文引用会退化成回环 URL（模型读不了图，只能靠你自己描述）。';
          } else {
            try {
              await materializeInto(cwd, rows.slice(0, want));
            } catch (error) {
              note = `写入工作区失败：${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
        json(res, 200, {
          rows: rows.map(wireRow),
          total: page.total,
          libraryTotal: page.libraryTotal,
          days: page.days,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          sort: page.sort,
          totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
          root,
          ...(pinned !== undefined ? { pinned } : {}),
          ...(note !== undefined ? { note } : {})
        });
      } catch (error) {
        json(res, 500, {
          ok: false,
          error: 'list-failed',
          hint: `读附件库失败（${root}）：${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  });

  ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/raw`,
    handler: async (req, res) => {
      if (!fence(req, res, trustedHosts)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method-not-allowed', hint: '这是一条只读的 GET 路由。' });
        return;
      }
      const ref = queryParam(req.url, 'ref');
      const sha = typeof ref === 'string' ? ref.replace(/^sha256:/, '').trim().toLowerCase() : '';
      if (!SHA_RE.test(sha)) {
        json(res, 400, {
          ok: false,
          error: 'invalid-ref',
          hint: 'ref 必须是 ref=sha256:<64 位十六进制>，用 GET /plugins/dsh-picflow/images 返回的 ref 字段原样传回来。'
        });
        return;
      }
      const found = await findObject(root, sha);
      if (found === undefined) {
        json(res, 404, { ok: false, error: 'image-not-found', hint: '附件库里没有这个 sha 对应的对象，先重新拉一次清单。' });
        return;
      }
      let ext;
      try {
        ext = sniffExt(await readHead(found.path));
      } catch {
        ext = undefined;
      }
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': String(found.bytes),
        'cache-control': 'private, max-age=300'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(found.path);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
  });
}

/**
 * 宿主半边入口。配置全部可选：默认只对回环开放、清单 60 张、
 * 由客户端决定要不要 materialize 到工作区。
 */
export function apply(ctx, config = {}) {
  const trustedHosts = Array.isArray(config.trustedHosts)
    ? config.trustedHosts.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : [];
  const start = (scope) => {
    try {
      registerRoutes(scope ?? ctx, { sessions: (scope ?? ctx).sessions, trustedHosts });
      console.log('[dsh-picflow] routes registered');
    } catch (error) {
      console.warn(`[dsh-picflow] route registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer', 'sessions'], (scope) => start(scope));
  else start(ctx);
}
