// dsh-picflow — 客户端半边
//
// 两个入口，正好对上两件事：
//   1. `@` 图片源：在输入框里打 @ → 菜单里出现「图片 10-04 22:55」这类候选，
//      选中后把这张图的正文引用 (![时间](绝对路径)) 插到**光标所在的位置**，
//      所以「这张图插在这一段里」不用再手写「图1/图2」。
//   2. 输入框下方的「图片 N 张」胶囊：按时间倒序列出贴过的图（最近的在最上），
//      每张可「挂上」＝把原图重新挂成这条消息的附件（模型原生多模态看到它），
//      或「路径」＝把正文引用复制到剪贴板，自己粘到段落里。
//
// 路数全部来自已在本版本跑通的官方扩展点：inputTriggers.registerSource
// （onPick 返回 { text } 即在触发处插文本）、composer.dock slot（框架会
// 注入 sessionId 与 inputActions）、conversation.createDrafts + addAttachments。
window.__ModuleLoader__.load({
  id: 'dsh-picflow',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const BASE = '/plugins/dsh-picflow';
    const SOURCE_NAME = 'dsh-picflow-images';
    const CACHE_MS = 20000;
    const MATERIALIZE = 60;
    /** 面板一页多少张（宿主上限 400）。 */
    const PAGE = 120;
    const MAX_ITEMS = 30;
    const DOCK_ID = 'dsh-picflow-dock';
    /** 贴图入库轮询间隔：粘贴后 ~1 秒内面板里就能看到它（含入库请求本身的时间）。 */
    const ADMIT_MS = 350;
    /** 附件库指纹轮询间隔（兜底：别的窗口/外部原因让库变了）。 */
    const STAMP_MS = 3000;
    /** 清理边界默认值：入库满 14 天且从未被引用才进候选（与宿主侧 CLEAN_AGE_DAYS 一致）。 */
    const CLEAN_DAYS = 14;
    /** 状态桶：第二排 chip。label 给用户看，value 是宿主的 state 参数。 */
    const STATE_CHIPS = [
      ['used', '用过'],
      ['unused', '没用过'],
      ['pinned', '已置顶'],
      ['big', '大文件'],
      ['noise', '小噪音'],
      ['cleanable', '可清理']
    ];
    /** 四态徽标的中文说法（悬停看理由）。 */
    const STATE_TEXT = { hot: '常用', warm: '用过', cold: '冷门', fresh: '新入库' };

    // ===================== 数据 =====================

    const cache = new Map();

    function sizeText(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * 宿主半边是否还是「旧契约」（没带 libraryTotal/days/hasMore、也不认 pin）。
     * 只有重启 DSH NEXT 才能换掉插件宿主模块，所以这里留一条退路：
     * 一旦发现旧宿主，就退回旧请求（要一页、要 materialize），不让面板开天窗。
     */
    let hostLegacy = false;

    async function loadImages(sessionId, options) {
      const opts = options !== undefined ? options : {};
      const force = opts.force === true;
      const q = typeof opts.q === 'string' ? opts.q.trim() : '';
      const day = typeof opts.day === 'string' ? opts.day.trim() : '';
      const sort = opts.sort === 'old' || opts.sort === 'big' ? opts.sort : 'new';
      const bucket = opts.bucket === undefined || opts.bucket === null ? '' : String(opts.bucket).trim();
      const state = opts.state === undefined || opts.state === null ? '' : String(opts.state).trim();
      const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 400) : PAGE;
      const materialize = Number.isInteger(opts.materialize) && opts.materialize >= 0 ? opts.materialize : 0;
      const key = [typeof sessionId === 'string' ? sessionId : '', q, day, sort, bucket, state, offset, limit, materialize].join('\u0000');
      const hit = cache.get(key);
      if (!force && hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit;
      const query = new URLSearchParams({ limit: String(limit) });
      if (materialize > 0) query.set('materialize', String(materialize));
      if (q !== '') query.set('q', q);
      if (day !== '') query.set('day', day);
      if (sort !== 'new') query.set('sort', sort);
      if (bucket !== '' && bucket !== 'all') query.set('bucket', bucket);
      if (state !== '') query.set('state', state);
      if (offset > 0) query.set('offset', String(offset));
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId);
      const response = await fetch(`${BASE}/images?${query.toString()}`, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body !== undefined && typeof body.hint === 'string' ? body.hint : `图片清单不可用（HTTP ${response.status}）`);
      }
      const payload = await response.json();
      const legacy = payload === null || typeof payload !== 'object' || typeof payload.libraryTotal !== 'number';
      if (legacy) hostLegacy = true;
      const snapshot = {
        at: Date.now(),
        legacy,
        rows: Array.isArray(payload.rows) ? payload.rows : [],
        total: typeof payload.total === 'number' ? payload.total : 0,
        libraryTotal: typeof payload.libraryTotal === 'number' ? payload.libraryTotal : 0,
        days: Array.isArray(payload.days) ? payload.days : [],
        hasMore: payload.hasMore === true,
        nextOffset: typeof payload.nextOffset === 'number' ? payload.nextOffset : 0,
        offset,
        totalBytes: typeof payload.totalBytes === 'number' ? payload.totalBytes : 0,
        bucket: typeof payload.bucket === 'string' ? payload.bucket : '',
        state: typeof payload.state === 'string' ? payload.state : '',
        // 全库聚合（真实磁盘体积、可清量、最近使用时间）：面板顶部数字与时间桶 chip 都吃它。
        stats: payload.stats !== null && typeof payload.stats === 'object' ? payload.stats : undefined,
        note: typeof payload.note === 'string' ? payload.note : undefined
      };
      cache.set(key, snapshot);
      return snapshot;
    }

    /**
     * 新图入库后把这个会话的快照缓存作废。
     * @ 菜单和面板吃的是同一份缓存，不清掉的话「刚贴的图」要等 20 秒才出现在 @ 里。
     */
    function forgetImages(sessionId) {
      const prefix = `${typeof sessionId === 'string' ? sessionId : ''}\u0000`;
      for (const key of Array.from(cache.keys())) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    }

    // ===================== 使用账本 / 置顶 / 清理：宿主侧那五条路由的客户端封装 =====================

    async function postJson(path, body, query) {
      const suffix = query !== undefined && query !== null && String(query) !== '' ? `?${query}` : '';
      const response = await fetch(`${BASE}${path}${suffix}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const hint = payload !== undefined && typeof payload.hint === 'string' ? payload.hint : `${path} 失败（HTTP ${response.status}）`;
        throw new Error(hint);
      }
      return payload;
    }

    async function getJson(path, query) {
      const suffix = query !== undefined && query !== null && String(query) !== '' ? `?${query}` : '';
      const response = await fetch(`${BASE}${path}${suffix}`, { headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const hint = payload !== undefined && typeof payload.hint === 'string' ? payload.hint : `${path} 失败（HTTP ${response.status}）`;
        throw new Error(hint);
      }
      return payload;
    }

    /**
     * 记一笔「这张图被用过了」：用过就不进清理候选。
     * 记账失败绝不影响插入本身——它只影响以后的清理判定，静默即可。
     */
    function reportUse(sessionId, row, kind) {
      if (row === undefined || typeof row.sha !== 'string' || row.sha === '') return;
      const query = new URLSearchParams({ kind: typeof kind === 'string' && kind !== '' ? kind : 'insert' });
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId);
      postJson('/ledger', { sha: row.sha }, query).catch(() => undefined);
    }

    async function setPin(sessionId, row) {
      const query = typeof sessionId === 'string' && sessionId !== '' ? `session=${encodeURIComponent(sessionId)}` : '';
      return postJson('/pin', { sha: row.sha }, query);
    }

    async function loadCleanup(sessionId, days) {
      const query = new URLSearchParams({});
      if (Number.isInteger(days) && days > 0) query.set('days', String(days));
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId);
      return getJson('/cleanup', query.toString());
    }

    async function loadTrash() {
      return getJson('/trash');
    }

    async function trashMove(sessionId, shas) {
      const query = typeof sessionId === 'string' && sessionId !== '' ? `session=${encodeURIComponent(sessionId)}` : '';
      return postJson('/trash', { op: 'move', shas }, query);
    }

    async function trashRestore(sessionId, ids) {
      const query = typeof sessionId === 'string' && sessionId !== '' ? `session=${encodeURIComponent(sessionId)}` : '';
      return postJson('/trash', { op: 'restore', ids }, query);
    }

    /**
     * 「粘贴后自动插入」开关：贴在渲染进程的 localStorage 里，刷新/重启之后还是这个选择。
     * 默认开 —— 用户要的就是「Ctrl+V 之后什么都不用点」。
     */
    const AUTO_KEY = 'dsh-picflow.autoInsert';

    function readAutoInsert() {
      try {
        if (typeof localStorage === 'undefined') return true;
        const raw = localStorage.getItem(AUTO_KEY);
        if (raw === '0') return false;
        if (raw === '1') return true;
      } catch {
        /* 读不到就按默认走 */
      }
      return true;
    }

    function writeAutoInsert(value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(AUTO_KEY, value === true ? '1' : '0');
      } catch {
        /* 存不下也不影响这一次 */
      }
    }

    /** 按需把单张图落进工作区（芯片必须有磁盘路径，模型才读得到）。 */
    async function pinRow(sessionId, row) {
      if (typeof row.path === 'string' && row.path !== '') return row.path;
      const query = new URLSearchParams({ pin: row.sha, limit: '1' });
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId);
      const response = await fetch(`${BASE}/images?${query.toString()}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`落盘失败（HTTP ${response.status}）`);
      const payload = await response.json();
      const pinned = payload !== null && typeof payload === 'object' ? payload.pinned : undefined;
      if (pinned === undefined || typeof pinned.path !== 'string') {
        throw new Error(typeof payload.note === 'string' && payload.note !== '' ? payload.note : '这张图落不了盘');
      }
      row.path = pinned.path;
      return pinned.path;
    }

    /** 正文引用：有落盘副本就给绝对路径（模型能直接 read_image），否则退回回环 URL。 */
    function markdownFor(row) {
      const label = typeof row.label === 'string' && row.label !== '' ? row.label : '图片';
      if (typeof row.path === 'string' && row.path !== '') return `![${label}](${row.path.replace(/\\/g, '/')})`;
      const origin = typeof location !== 'undefined' ? location.origin : '';
      return `![${label}](${origin}${row.url})`;
    }

    /** 图片编号：面板与 @ 菜单统一按同一份倒序列表的序位（1 起）。 */
    function labelAt(index) {
      return `图片${index + 1}`;
    }

    /**
     * 芯片上的编号用宿主给的固定号（`ordinal`：越早的图编号越小，新图只往后排），
     * 所以「图片12」永远指同一张图；行上没有号时才退回列表序位。
     */
    function rowLabel(row, index) {
      const ordinal = row !== undefined && Number.isInteger(row.ordinal) && row.ordinal > 0 ? row.ordinal : undefined;
      return `图片${ordinal !== undefined ? ordinal : index + 1}`;
    }

    /** 与宿主 index.js 的 normalizeQuery 对齐：支持 图片12 / 12 / 10-04 / 今天。 */
    function classifyQuery(raw) {
      const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (text === '') return { text: '', ordinal: undefined, day: '' };
      const words = { 今天: 0, 昨天: 1, 前天: 2 };
      if (words[text] !== undefined) {
        const d = new Date(Date.now() - words[text] * 86400000);
        const pad = (value) => String(value).padStart(2, '0');
        return { text: '', ordinal: undefined, day: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
      }
      const ordinal = /^(?:图片|图|pic)?\s*(\d{1,4})$/.exec(text);
      if (ordinal !== null) return { text, ordinal: Number(ordinal[1]), day: '' };
      return { text, ordinal: undefined, day: '' };
    }

    /** 本地过滤：搜索词按编号/日期/文本三种意思匹配一行。 */
    function matchesRow(row, query) {
      if (query.ordinal !== undefined) return row.ordinal === query.ordinal;
      if (query.day !== '') return row.day === query.day;
      if (query.text === '') return true;
      const haystack = `${row.label} ${row.stamp} ${row.day} ${row.ext} ${row.filename} ${row.ordinal}`.toLowerCase();
      return haystack.includes(query.text);
    }

    /** 内核引用通道只认 `dsh-resource://file/…` 地址（见 util-workspace-path）。 */
    function fileAddressOf(path) {
      if (typeof path !== 'string' || path === '') return undefined;
      const normalized = path.replace(/\\/g, '/');
      const unc = normalized.startsWith('//');
      const body = normalized.replace(/^\/+/, '');
      if (body === '') return undefined;
      const encoded = body
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
        .join('/');
      return `dsh-resource://file/absolute/${unc ? '/' : ''}${encoded}`;
    }

    /** 会话输入壳：原生引用芯片只能从 `conversation.input.for(scope)` 插进去。 */
    function inputShellOf(ctx, sessionId) {
      try {
        const scope = ctx?.sessions?.scope?.(sessionId);
        if (scope === undefined) return undefined;
        const conversation = scope.get?.('conversation');
        const shell = conversation?.input?.for?.(scope);
        if (shell === undefined || typeof shell.insertReference !== 'function') return undefined;
        return shell;
      } catch {
        return undefined;
      }
    }

    /**
     * 把一张图作为「原生引用芯片」（图片2）插到光标处——内核的 insert-reference
     * 通道，与打 @ 选文件同一条路：显示是芯片，送出去模型拿到的是图片路径。
     */
    function insertChipAtCaret(ctx, sessionId, row, label) {
      const shell = inputShellOf(ctx, sessionId);
      if (shell === undefined) return 'no-shell';
      const address = fileAddressOf(row.path);
      if (address === undefined) return 'no-path';
      let span;
      try {
        span = shell.actions?.captureInsertion?.();
      } catch {
        span = undefined;
      }
      if (span === undefined) return 'no-caret';
      const reference = { source: 'reference', ref: address, label, appearance: 'file', clipboardText: address };
      try {
        return shell.insertReference(reference, span) === true ? 'ok' : 'busy';
      } catch (error) {
        console.warn(`[dsh-picflow] 插入引用芯片失败：${error instanceof Error ? error.message : String(error)}`);
        return 'failed';
      }
    }

    function conversationOf(ctx, sessionId) {
      let conversation;
      try {
        conversation = ctx.sessions?.scope?.(sessionId)?.get?.('conversation');
      } catch {
        return undefined;
      }
      return conversation !== undefined && typeof conversation.createDrafts === 'function' ? conversation : undefined;
    }

    /** 把库里那张图重新变成这条消息的附件——进度/取消/模型可见的行都交给宿主。 */
    async function attachRow(ctx, sessionId, inputActions, row) {
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('没有当前会话');
      if (inputActions === undefined || typeof inputActions.addAttachments !== 'function') throw new Error('输入区不可用');
      const conversation = conversationOf(ctx, sessionId);
      if (conversation === undefined) throw new Error('附件通道不可用（需要 harness ≥ 0.1.3）');
      const response = await fetch(row.url);
      if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const name = typeof row.filename === 'string' && row.filename !== '' ? row.filename : `pic-${String(row.sha).slice(0, 8)}.${row.ext}`;
      const drafts = conversation.createDrafts(sessionId, [new File([blob], name, { type: blob.type || 'image/png' })]);
      if (drafts.length === 0) throw new Error('宿主没有接受这张图');
      if (inputActions.addAttachments(drafts.map((draft) => draft.id)) !== true) throw new Error('输入区忙，稍后再点一次');
      return name;
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }

    // ===================== 贴图入库：Ctrl+V → 马上能引用 =====================

    /**
     * 刚 Ctrl+V、还没发送的图。内核把它们做成「runtime-only draft attachment」——
     * previewUrl 是 object URL，字节要等发送时才上传，所以宿主扫附件库根本看不到它。
     * 想「贴完就能引用」，只能由这边把字节主动送进库里。
     */
    function draftImagesOf(ctx, sessionId) {
      const shell = inputShellOf(ctx, sessionId);
      if (shell === undefined) return [];
      let ids;
      try {
        ids = shell.snapshot !== undefined && shell.snapshot !== null ? shell.snapshot.attachmentIds : undefined;
      } catch {
        return [];
      }
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const conversation = conversationOf(ctx, sessionId);
      if (conversation === undefined || typeof conversation.resolveDraftAttachments !== 'function') return [];
      let drafts;
      try {
        drafts = conversation.resolveDraftAttachments(ids);
      } catch {
        return [];
      }
      if (!Array.isArray(drafts)) return [];
      return drafts.filter(
        (draft) => draft !== undefined && draft !== null && draft.kind === 'image' && typeof draft.file?.arrayBuffer === 'function'
      );
    }

    /**
     * 把一张草稿图交给宿主入库。宿主走的是官方 attachments.saveImage（同一套规范化），
     * 所以 sha 与之后真正发送时落库的那份完全相同：天然去重，编号也是同一个。
     */
    async function admitDraft(sessionId, draft) {
      const file = draft.file;
      const name =
        typeof file?.name === 'string' && file.name !== ''
          ? file.name
          : `paste-${String(draft.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12) || 'image'}.png`;
      const query = new URLSearchParams({ name });
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId);
      const type = typeof file?.type === 'string' && file.type !== '' ? file.type : 'application/octet-stream';
      const response = await fetch(`${BASE}/admit?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: file
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(
          payload !== undefined && payload !== null && typeof payload.hint === 'string'
            ? payload.hint
            : `入库失败（HTTP ${response.status}）`
        );
      }
      return payload;
    }

    /** 已送过的草稿 id：同一张图只送一次；失败过的不再重试（旧宿主没有 /admit，别刷屏）。 */
    const admittedDrafts = new Set();
    const rejectedDrafts = new Set();
    let sweeping = false;

    async function sweepDrafts(ctx, sessionId, onAdmitted) {
      if (sweeping) return;
      let pending;
      try {
        pending = draftImagesOf(ctx, sessionId).filter(
          (draft) => !admittedDrafts.has(draft.id) && !rejectedDrafts.has(draft.id)
        );
      } catch {
        return;
      }
      if (pending.length === 0) return;
      sweeping = true;
      try {
        for (const draft of pending) {
          admittedDrafts.add(draft.id);
          try {
            const payload = await admitDraft(sessionId, draft);
            if (typeof onAdmitted === 'function') onAdmitted(payload);
          } catch (error) {
            admittedDrafts.delete(draft.id);
            rejectedDrafts.add(draft.id);
            console.warn(`[dsh-picflow] 贴图入库失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        sweeping = false;
      }
      if (admittedDrafts.size > 400) admittedDrafts.clear();
      if (rejectedDrafts.size > 400) rejectedDrafts.clear();
    }

    /** 附件库指纹（宿主只 stat 分片目录，很便宜）；旧宿主没有这条路由，会抛错。 */
    async function loadStamp() {
      const response = await fetch(`${BASE}/version`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return payload !== null && typeof payload === 'object' && typeof payload.stamp === 'string' ? payload.stamp : '';
    }

    // ===================== 样式 =====================

    const CSS = `
.pf-wrap{position:relative;display:inline-flex;align-items:center}
.pf-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb, CanvasText 16%, transparent);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.85;white-space:nowrap}
.pf-pill:hover{opacity:1;background:color-mix(in srgb, CanvasText 8%, transparent)}
.pf-pill[data-open="1"]{opacity:1;background:color-mix(in srgb, CanvasText 10%, transparent)}
.pf-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.pf-card{position:absolute;bottom:calc(100% + 8px);left:0;z-index:60;width:min(560px,86vw);max-height:46vh;overflow:auto;padding:10px;border-radius:12px;border:1px solid color-mix(in srgb, CanvasText 16%, transparent);background:color-mix(in srgb, Canvas 94%, transparent);color:CanvasText;box-shadow:0 14px 36px rgba(0,0,0,.35);backdrop-filter:blur(14px)}
.pf-head{display:flex;align-items:center;gap:8px;padding:0 2px 8px;font-size:12px;opacity:.75}
.pf-head strong{font-weight:600;opacity:1}
.pf-head .pf-spacer{flex:1}
.pf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px}
.pf-cell{display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:10px;border:1px solid color-mix(in srgb, CanvasText 12%, transparent)}
.pf-thumb{width:100%;height:66px;object-fit:cover;border-radius:6px;background:color-mix(in srgb, CanvasText 8%, transparent);cursor:zoom-in}
.pf-meta{font-size:11px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-name{font-size:12px;font-weight:600;letter-spacing:.2px}
.pf-actions{display:flex;gap:6px;flex-wrap:wrap}
.pf-btn{flex:1;min-width:52px;height:22px;font:inherit;font-size:11px;border-radius:6px;border:1px solid color-mix(in srgb, CanvasText 16%, transparent);background:transparent;color:inherit;cursor:pointer}
.pf-btn:hover:not(:disabled){background:color-mix(in srgb, CanvasText 10%, transparent)}
.pf-btn:disabled{opacity:.45;cursor:default}
.pf-btn[data-primary="1"]{border-color:color-mix(in srgb, CanvasText 34%, transparent)}
.pf-note{padding:6px 2px 0;font-size:11px;opacity:.65;line-height:1.5}
.pf-filters{display:flex;flex-direction:column;gap:6px;padding:0 2px 8px}
.pf-search{width:100%;height:26px;padding:0 8px;font:inherit;font-size:12px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 18%, transparent);background:color-mix(in srgb, CanvasText 6%, transparent);color:inherit;outline:none}
.pf-search:focus{border-color:color-mix(in srgb, CanvasText 38%, transparent)}
.pf-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pf-chip{height:22px;padding:0 8px;font:inherit;font-size:11px;border-radius:999px;border:1px solid color-mix(in srgb, CanvasText 16%, transparent);background:transparent;color:inherit;cursor:pointer;opacity:.8}
.pf-chip:hover{opacity:1;background:color-mix(in srgb, CanvasText 10%, transparent)}
.pf-chip[data-on="1"]{opacity:1;border-color:color-mix(in srgb, CanvasText 42%, transparent);background:color-mix(in srgb, CanvasText 14%, transparent)}
.pf-more{display:flex;justify-content:center;padding:8px 2px 0}
.pf-clean{display:flex;flex-direction:column;gap:8px;padding:0 2px 8px}
.pf-list{display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto}
.pf-row{display:flex;align-items:center;gap:8px;padding:4px 6px;font-size:11px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 12%, transparent);background:color-mix(in srgb, CanvasText 4%, transparent);cursor:pointer}
.pf-row input[type=checkbox]{flex:none;width:14px;height:14px;accent-color:CanvasText;cursor:pointer}
.pf-row-thumb{flex:none;width:44px;height:34px;object-fit:cover;border-radius:5px;background:#111}
.pf-row-name{flex:none;min-width:52px;font-weight:600}
.pf-row-meta{flex:none;opacity:.7}
.pf-row-why{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6}
.pf-cleanfoot{display:flex;align-items:center;gap:8px}
.pf-tag{margin-left:6px;padding:1px 6px;font-size:10px;border-radius:999px;vertical-align:middle;border:1px solid color-mix(in srgb, CanvasText 18%, transparent);opacity:.75}
.pf-legacy{margin:0 2px 8px;padding:6px 8px;font-size:11px;line-height:1.5;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 18%, transparent);background:color-mix(in srgb, CanvasText 8%, transparent);opacity:.8}
.pf-more .pf-btn{flex:none;padding:0 12px}
.pf-empty{padding:14px 4px;font-size:12px;opacity:.7;line-height:1.6}
.pf-toast{padding:6px 2px 0;font-size:11px;opacity:.85}
.pf-flash{position:absolute;bottom:calc(100% + 6px);left:0;z-index:59;max-width:min(320px,70vw);padding:6px 10px;font-size:11px;line-height:1.5;border-radius:10px;border:1px solid color-mix(in srgb, CanvasText 20%, transparent);background:color-mix(in srgb, Canvas 92%, transparent);color:CanvasText;box-shadow:0 8px 22px rgba(0,0,0,.28);backdrop-filter:blur(12px)}
.pf-cell[data-fresh="1"]{border-color:color-mix(in srgb, CanvasText 40%, transparent);background:color-mix(in srgb, CanvasText 8%, transparent);box-shadow:0 0 0 1px color-mix(in srgb, CanvasText 22%, transparent)}
.pf-badge{margin-left:6px;padding:1px 6px;font-size:10px;font-weight:600;border-radius:999px;vertical-align:middle;background:color-mix(in srgb, CanvasText 16%, transparent);opacity:.9}
.pf-zoom{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,.82);cursor:zoom-out}
.pf-zoom-img{max-width:92vw;max-height:82vh;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.6);background:#111}
.pf-zoom-cap{font-size:12px;color:rgba(255,255,255,.82)}
`;

    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="dsh-picflow"]') !== null) return;
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-picflow';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ===================== 放大浮层（挂在 shell.overlay，避免被输入框容器裁剪） =====================

    const ZOOM_ID = 'dsh-picflow-zoom';
    const zoomListeners = new Set();
    let zoomState = null;

    function showZoom(next) {
      zoomState = next;
      for (const notify of Array.from(zoomListeners)) {
        try {
          notify(next);
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    function ZoomLayer() {
      const [state, setState] = React.useState(zoomState);
      React.useEffect(() => {
        const notify = (next) => setState(next);
        zoomListeners.add(notify);
        setState(zoomState);
        return () => zoomListeners.delete(notify);
      }, []);
      React.useEffect(() => {
        if (state === null) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKey = (event) => {
          if (event !== null && event !== undefined && event.key === 'Escape') showZoom(null);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [state]);
      if (state === null || state === undefined) return null;
      return h(
        'div',
        { className: 'pf-zoom', onClick: () => showZoom(null), title: '点一下或按 Esc 关闭' },
        h('img', { className: 'pf-zoom-img', src: state.row.url, alt: state.label }),
        h('div', { className: 'pf-zoom-cap' }, `${state.label} · ${state.row.filename} · ${sizeText(state.row.bytes)} —— 点一下或按 Esc 关掉`)
      );
    }

    // ===================== 输入框下方的图片胶囊 =====================

    function PicDock(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const [open, setOpen] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState(undefined);
      const [problem, setProblem] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [toast, setToast] = React.useState('');
      // 刚入库的那张（Ctrl+V 贴进来的）：面板里给它一个「刚入库」标记，12 秒后自动退场。
      const [fresh, setFresh] = React.useState(undefined);
      // 「粘贴后自动插入」：开着时 Ctrl+V 一入库就把「图片N」插到光标处，等于程序替你点了面板上那颗按钮。
      const [autoInsert, setAutoInsert] = React.useState(() => readAutoInsert());
      const [tick, setTick] = React.useState(0);
      // 强制刷新只对紧接着的那一次取数生效：点开面板/刷新/新图入库要绕开 20 秒快照缓存，
      // 平时改筛选条件仍然吃缓存（用 useState 存的可变小盒子当 ref 使）。
      const [forceBox] = React.useState(() => ({ next: false }));
      const reload = () => {
        forceBox.next = true;
        setTick((value) => value + 1);
      };
      const [search, setSearch] = React.useState('');
      const [q, setQ] = React.useState('');
      const [day, setDay] = React.useState('');
      const [sort, setSort] = React.useState('new');
      const [depth, setDepth] = React.useState(1);
      // 时间桶（近3天/近7天/近30天/更早）与状态桶（用过/没用过/已置顶/大文件/小噪音/可清理）：
      // 这两排取代了原来那一长串具体日期 chip——日期收进「按日期」下钻，桶是滚动的、恒定 5 个。
      const [bucket, setBucket] = React.useState('all');
      const [stateFilter, setStateFilter] = React.useState('');
      const [showDays, setShowDays] = React.useState(false);
      // 「浏览」/「清理」两种面板形态：清理态列候选、勾选、移入回收站，并给出回收站撤销入口。
      const [mode, setMode] = React.useState('browse');
      const [clean, setClean] = React.useState(undefined);
      const [picked, setPicked] = React.useState(() => new Set());
      const [trash, setTrash] = React.useState(undefined);
      const [working, setWorking] = React.useState(false);
      // 清理边界：入库满多少天且从未被引用才进候选（宿主侧默认也是 14 天）。
      const [cleanDays, setCleanDays] = React.useState(CLEAN_DAYS);
      // 置顶翻转表（会话内即时生效，宿主重取后与它异或）：用 useState 存可变盒子当 ref 使。
      const [pinnedFlip] = React.useState(() => new Map());

      // 搜索框防抖：停手 260ms 再发请求（每次按键都查库太吵）。
      React.useEffect(() => {
        if (search === q) return undefined;
        const timer = setTimeout(() => {
          setQ(search);
          setDepth(1);
        }, 260);
        return () => clearTimeout(timer);
      }, [search, q]);

      React.useEffect(() => {
        let alive = true;
        const force = forceBox.next === true;
        forceBox.next = false;
        setProblem('');
        loadImages(sessionId, { force, q, day, sort, bucket, state: stateFilter, offset: 0, limit: PAGE * depth }).then((first) => {
          // 旧宿主：它不认 q/day/sort/pin，也不给总数。退回旧契约（只列最近一页 + 全量落盘），
          // 起码「插到光标处」还有磁盘路径可用。
          if (first.legacy !== true) return first;
          return loadImages(sessionId, { force: true, limit: MATERIALIZE, materialize: MATERIALIZE });
        }).then(
          (next) => {
            if (alive) setSnapshot(next);
          },
          (error) => {
            if (alive) {
              setSnapshot(undefined);
              setProblem(error instanceof Error ? error.message : String(error));
            }
          }
        );
        return () => {
          alive = false;
        };
      }, [sessionId, tick, q, day, sort, bucket, stateFilter, depth]);

      // 清理态：拉一次候选 + 回收站。默认全勾（规则本身就是「满 N 天且从未被引用」）。
      React.useEffect(() => {
        if (mode !== 'clean') return undefined;
        let alive = true;
        setWorking(true);
        const days = cleanDays;
        Promise.all([loadCleanup(sessionId, days), loadTrash()]).then(
          ([list, bin]) => {
            if (!alive) return;
            setClean(list);
            setTrash(bin);
            setPicked(new Set((Array.isArray(list.rows) ? list.rows : []).map((row) => row.sha)));
          },
          (error) => {
            if (!alive) return;
            setToast(error instanceof Error ? error.message : String(error));
          }
        ).finally(() => {
          if (alive) setWorking(false);
        });
        return () => {
          alive = false;
        };
      }, [mode, sessionId, cleanDays]);

      React.useEffect(() => {
        if (toast === '') return undefined;
        const timer = setTimeout(() => setToast(''), 2600);
        return () => clearTimeout(timer);
      }, [toast]);

      // 一贴图就入库：粘贴后 ~1 秒就有「图片N」——「自动插入」开着时程序自己插到光标处，
      // 关着（或光标接不上）才把面板冒出来让用户点。
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let alive = true;
        const beat = () => {
          void sweepDrafts(props.ctxRef?.current, sessionId, (payload) => {
            if (!alive) return;
            const info = payload !== null && typeof payload === 'object' ? payload : {};
            const label = typeof info.label === 'string' && info.label !== '' ? info.label : '';
            const sha = typeof info.sha === 'string' ? info.sha : '';
            const row = info.row !== null && typeof info.row === 'object' ? info.row : undefined;
            // 宿主入库时顺手把副本落进工作区了：把路径并进这一行，「插到光标处」就不用再等一次落盘。
            if (row !== undefined && typeof row.path !== 'string' && typeof info.path === 'string' && info.path !== '') {
              row.path = info.path;
            }
            // 缓存里还没有这张图：不清掉的话 @ 菜单要等 20 秒才认得出它的编号。
            forgetImages(sessionId);
            if (sha !== '' || row !== undefined) setFresh({ sha, label, row, at: Date.now() });
            reload();
            // 「自动插入」开着的时候，面板上那一步程序自己点：入库完就把引用芯片放到光标处。
            const placed =
              autoInsert === true && row !== undefined && label !== ''
                ? insertChipAtCaret(props.ctxRef?.current, sessionId, row, label)
                : 'off';
            if (placed === 'ok') {
              reportUse(sessionId, row, 'auto');
              setToast(`${label} 已自动插到光标处 —— 想改回手动：面板里「自动插入」`);
              return;
            }
            // 没自动插入（开关关着，或者光标/输入框这会儿接不上）：面板照旧自己冒出来。
            setOpen(true);
            if (placed === 'off') {
              setToast(label !== '' ? `${label} 已入库 —— 点「插到光标处」把它引用进段落` : '贴的图已入库，可以插到光标处了');
              return;
            }
            setToast(
              label !== ''
                ? `${label} 已入库，但${
                    placed === 'no-path' ? '这张图还没落盘副本' : placed === 'busy' ? '输入框这会儿正忙' : '光标没接上'
                  } —— 点「插到光标处」自己放`
                : '贴的图已入库，但没能自动插到光标处'
            );
          });
        };
        const timer = setInterval(beat, ADMIT_MS);
        beat();
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      // 刚入库那条提示别赖着不走。
      React.useEffect(() => {
        if (fresh === undefined) return undefined;
        const timer = setTimeout(() => setFresh(undefined), 12000);
        return () => clearTimeout(timer);
      }, [fresh]);

      // 兜底：库被别处改了（别的窗口贴图、外部清理）也能自己跟上。旧宿主没有 /version，静默忽略。
      React.useEffect(() => {
        let alive = true;
        let known;
        const beat = () => {
          loadStamp().then(
            (stamp) => {
              if (!alive || stamp === '') return;
              if (known === undefined) {
                known = stamp;
                return;
              }
              if (known !== stamp) {
                known = stamp;
                reload();
              }
            },
            () => undefined
          );
        };
        const timer = setInterval(beat, STAMP_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      const rows = snapshot === undefined ? [] : snapshot.rows;
      const total = snapshot === undefined ? rows.length : snapshot.total;
      const library = snapshot === undefined || snapshot.libraryTotal === 0 ? total : snapshot.libraryTotal;
      const dayList = snapshot === undefined ? [] : snapshot.days;
      const stats = snapshot !== undefined && snapshot.stats !== undefined ? snapshot.stats : undefined;
      const filtering = q !== '' || day !== '' || stateFilter !== '' || (bucket !== '' && bucket !== 'all');
      const label = problem !== '' ? '图片库不可用' : `${library} 张图`;
      // 顶部数字要的是磁盘真实占用（不是这一页的体积）+ 可清量 + 最近一次使用。
      const diskBytes = stats !== undefined && Number.isFinite(stats.totalBytes) ? stats.totalBytes : snapshot !== undefined ? snapshot.totalBytes : 0;
      const cleanableCount = stats !== undefined && stats.cleanable !== undefined ? stats.cleanable.count : 0;
      const cleanableBytes = stats !== undefined && stats.cleanable !== undefined ? stats.cleanable.bytes : 0;
      const lastUsedMs = stats !== undefined && Number.isFinite(stats.lastUsedMs) ? stats.lastUsedMs : 0;
      const stateCounts = stats !== undefined && stats.states !== undefined ? stats.states : {};
      const hasStats = stats !== undefined && Array.isArray(stats.buckets) && stats.buckets.length > 0;
      const timeChips = hasStats
        ? stats.buckets.map((entry) => [entry.id, entry.label, entry.count])
        // 旧宿主没有聚合能力：第一排退回按天（点了走 day 参数，不是 bucket）。
        : [['all', `全部 ${library}`, undefined]].concat(dayList.slice(0, 12).map((entry) => [`d:${entry.day}`, entry.day, entry.count]));
      const stateChips = STATE_CHIPS.map(([value, text]) => [value, text, Number.isFinite(stateCounts[value]) ? stateCounts[value] : 0]);
      // 清理态的三样数据：候选清单、回收站内容、回收站位置（给用户看清楚东西去哪了）。
      const cleanRows = clean === undefined || !Array.isArray(clean.rows) ? [] : clean.rows;
      const trashEntries = trash === undefined || !Array.isArray(trash.entries) ? [] : trash.entries;
      const trashCount = trash !== undefined && Number.isFinite(trash.count) ? trash.count : trashEntries.length;
      const trashBytes = trash !== undefined && Number.isFinite(trash.bytes) ? trash.bytes : 0;
      const trashRootText = trash !== undefined && typeof trash.trashRoot === 'string' ? trash.trashRoot : '';
      // 置顶的本地叠加：宿主行上的 pinned 要重取才有，点完立刻翻面靠它。
      const pinFlip = typeof pinnedFlip.get === 'function' ? pinnedFlip : new Map();
      const isRowPinned = (row) => {
        const host = row !== undefined && row.pinned === true;
        const flipped = pinFlip.get(row.sha) === true;
        return flipped ? !host : host;
      };
      // 刚入库的那张要立刻看得见：取数还没回来（或者正被筛选条件挡着）就先把它顶到最前面。
      const freshRow = fresh !== undefined && fresh.row !== undefined ? fresh.row : undefined;
      const freshSha = fresh !== undefined && typeof fresh.sha === 'string' ? fresh.sha : '';
      const freshListed = freshRow !== undefined && rows.some((row) => row.sha === freshRow.sha);
      const shown = freshRow !== undefined && !freshListed && !filtering && sort === 'new' && problem === '' ? [freshRow].concat(rows) : rows;

      const onAttach = (row) => {
        setBusy(row.sha);
        attachRow(props.ctxRef?.current, sessionId, inputActions, row).then(
          (name) => {
            reportUse(sessionId, row, 'attach');
            setToast(`已挂上 ${name}，发送时模型会直接看到它`);
          },
          (error) => setToast(error instanceof Error ? error.message : String(error))
        ).finally(() => setBusy(''));
      };

      const onInsert = (row, label) => {
        const place = () => {
          const status = insertChipAtCaret(props.ctxRef?.current, sessionId, row, label);
          if (status === 'ok') {
            reportUse(sessionId, row, 'insert');
            setToast(`已插入 ${label} —— 它就是一个引用，接着打字就行`);
            return;
          }
          if (status === 'no-path') {
            setToast('这张图还没落盘副本，先点「挂上」');
            return;
          }
          if (status === 'busy') {
            setToast('输入框正忙，等这条发完再点');
            return;
          }
          const text = markdownFor(row);
          let fallback = false;
          try {
            const span = inputActions?.captureInsertion?.();
            if (span !== undefined && typeof inputActions.insertText === 'function') fallback = inputActions.insertText(text, span) === true;
          } catch {
            fallback = false;
          }
          setToast(fallback ? `已插入 ${label}（纯文本形态）` : `插不进去，手动用这条：${text}`);
        };
        if (typeof row.path === 'string' && row.path !== '') {
          place();
          return;
        }
        // 芯片要有磁盘路径，模型才读得到图：只给这一张落盘，不整库拷贝。
        setBusy(row.sha);
        pinRow(sessionId, row).then(
          () => place(),
          (error) => setToast(error instanceof Error ? error.message : String(error))
        ).finally(() => setBusy(''));
      };

      const onPath = (row) => {
        const text = markdownFor(row);
        copyText(text).then((ok) => setToast(ok ? '路径已复制，粘到段落里就行' : `复制失败，手动用这条：${text}`));
      };

      return h(
        'div',
        { className: 'pf-wrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'pf-pill',
            'data-open': open ? '1' : '0',
            title: '图片流：贴过的图都在这里（按时间倒序，最近的在最上）',
            onClick: () => {
              showZoom(null);
              const next = !open;
              // 打开时强制重取一次：刚贴的图不用等轮询就已经在列表里。
              if (next) reload();
              setOpen(next);
            }
          },
          h('span', { className: 'pf-dot' }),
          label
        ),
        // 卡片关着的时候提示也得看得见（否则「贴完没反应」）。
        open || toast === '' ? null : h('div', { className: 'pf-flash' }, toast),
        open
          ? h(
              'div',
              { className: 'pf-card' },
              h(
                'div',
                { className: 'pf-head' },
                h('strong', null, problem !== '' ? '引用素材' : `引用素材 · 库里 ${library} 张`),
                h(
                  'span',
                  {
                    title:
                      stats === undefined
                        ? '宿主半边还没有聚合能力（重启 DSH NEXT 后生效）'
                        : `磁盘真实占用 ${sizeText(diskBytes)}；可清理 ${cleanableCount} 张 / ${sizeText(cleanableBytes)}（入库满 ${cleanDays} 天且从未被引用）${lastUsedMs > 0 ? `；最近一次使用在 ${new Date(lastUsedMs).toLocaleString()}` : ''}`
                  },
                  filtering
                    ? `· 命中 ${total} 张`
                    : diskBytes > 0
                      ? `· 占盘 ${sizeText(diskBytes)}${cleanableCount > 0 ? ` · 可清 ${cleanableCount} 张/${sizeText(cleanableBytes)}` : ''}`
                      : ''
                ),
                h('span', { className: 'pf-spacer' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pf-chip',
                    'data-on': autoInsert === true ? '1' : '0',
                    title:
                      autoInsert === true
                        ? '现在：Ctrl+V 贴图一入库，程序就自己把它插到光标处（点一下改成手动）'
                        : '现在：贴图只入库，自己点「插到光标处」（点一下改成自动）',
                    onClick: () => {
                      const next = autoInsert !== true;
                      writeAutoInsert(next);
                      setAutoInsert(next);
                      setToast(next ? '以后贴图会自动插到光标处' : '以后贴图只入库，插不插由你点');
                    }
                  },
                  `自动插入 ${autoInsert === true ? '开' : '关'}`
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pf-chip',
                    'data-on': mode === 'clean' ? '1' : '0',
                    title:
                      cleanableCount > 0
                        ? `挑出 ${cleanableCount} 张（入库满 ${cleanDays} 天且从未被引用）搬进回收站，7 天内可撤销`
                        : '按「入库满天数 + 从未被引用」挑图搬进回收站（7 天内可撤销）',
                    onClick: () => setMode(mode === 'clean' ? 'browse' : 'clean')
                  },
                  mode === 'clean' ? '返回浏览' : `清理${cleanableCount > 0 ? ` ${cleanableCount}` : ''}`
                ),
                h(
                  'button',
                  { type: 'button', className: 'pf-btn', style: { flex: 'none', padding: '0 8px' }, onClick: () => reload() },
                  '刷新'
                )
              ),
              // 提示贴着卡片顶部放：网格长了也不会把它顶到看不见的地方。
              toast !== '' ? h('div', { className: 'pf-toast' }, toast) : null,
              snapshot !== undefined && snapshot.legacy === true
                ? h(
                    'div',
                    { className: 'pf-legacy' },
                    '宿主半边还是旧版：搜索、按天筛选、翻页和按需落盘要等 DSH NEXT 重启后才生效（客户端已经准备好了）。'
                  )
                : h(
                'div',
                { className: 'pf-filters' },
                h('input', {
                  className: 'pf-search',
                  type: 'search',
                  value: search,
                  placeholder: '搜编号 / 日期 / 格式：图片12、10-04、昨天、png',
                  title: '编号就是每张图左下角的「图片N」——固定的，不会因为新图而变',
                  onChange: (event) => setSearch(event.target.value)
                }),
                h(
                  'div',
                  { className: 'pf-chips' },
                  // 第一排：时间桶。宿主给的 stats.buckets 是滚动的恒定 5 个（全部/近3天/近7天/近30天/更早），
                  // 取代原来那一长串「10-08 19 / 10-07 22 …」日期 chip；具体日期收进下面的「按日期」下钻。
                  timeChips.map(([id, text, count]) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pf-chip',
                        key: id,
                        'data-on': id.startsWith('d:') ? (day === id.slice(2) ? '1' : '0') : bucket === id && day === '' ? '1' : '0',
                        title: count === undefined ? text : `${text}：${count} 张`,
                        onClick: () => {
                          // 「d:」前缀 = 旧宿主回退形态里的按天 chip：点它是筛某一天，不是时间桶。
                          if (id.startsWith('d:')) {
                            const target = id.slice(2);
                            setBucket('all');
                            setDay(day === target ? '' : target);
                          } else {
                            setBucket(id);
                            setDay('');
                          }
                          setDepth(1);
                        }
                      },
                      count === undefined ? text : `${text} ${count}`
                    )
                  ),
                  h('span', { className: 'pf-spacer' }),
                  [
                    ['new', '最新'],
                    ['old', '最早'],
                    ['big', '最大']
                  ].map(([value, text]) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pf-chip',
                        key: value,
                        'data-on': sort === value ? '1' : '0',
                        onClick: () => {
                          setSort(value);
                          setDepth(1);
                        }
                      },
                      text
                    )
                  )
                ),
                h(
                  'div',
                  { className: 'pf-chips' },
                  // 第二排：状态桶。「没用过 + 更早」就是清理候选的来源。
                  stateChips.map(([value, text, count]) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pf-chip',
                        key: value,
                        'data-on': stateFilter === value ? '1' : '0',
                        title: `${text}：${count} 张（点一下筛，再点取消）`,
                        onClick: () => {
                          setStateFilter(stateFilter === value ? '' : value);
                          setDepth(1);
                        }
                      },
                      `${text} ${count}`
                    )
                  ),
                  h('span', { className: 'pf-spacer' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pf-chip',
                      'data-on': showDays ? '1' : '0',
                      title: '展开按天筛选（哪天贴得多一目了然）',
                      onClick: () => setShowDays(!showDays)
                    },
                    '按日期'
                  )
                ),
                showDays
                  ? h(
                      'div',
                      { className: 'pf-chips' },
                      dayList.slice(0, 20).map((entry) =>
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'pf-chip',
                            key: entry.day,
                            'data-on': day === entry.day ? '1' : '0',
                            onClick: () => {
                              setDay(day === entry.day ? '' : entry.day);
                              setDepth(1);
                            }
                          },
                          `${entry.day} ${entry.count}`
                        )
                      )
                    )
                  : null
              ),
              // ---------- 清理态：候选清单 + 勾选 + 移入回收站 + 撤销 ----------
              mode === 'clean'
                ? h(
                    'div',
                    { className: 'pf-clean' },
                    h(
                      'div',
                      { className: 'pf-chips' },
                      [7, 14, 30].map((days) =>
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'pf-chip',
                            key: days,
                            'data-on': cleanDays === days ? '1' : '0',
                            title: `入库满 ${days} 天且从未被引用的进候选`,
                            onClick: () => setCleanDays(days)
                          },
                          `满 ${days} 天`
                        )
                      ),
                      h('span', { className: 'pf-spacer' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'pf-chip',
                          onClick: () => setPicked(new Set((Array.isArray(clean?.rows) ? clean.rows : []).map((row) => row.sha)))
                        },
                        '全选'
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'pf-chip',
                          onClick: () => {
                            const all = (Array.isArray(clean?.rows) ? clean.rows : []).map((row) => row.sha);
                            const next = new Set();
                            for (const sha of all) if (!picked.has(sha)) next.add(sha);
                            setPicked(next);
                          }
                        },
                        '反选'
                      )
                    ),
                    working && clean === undefined
                      ? h('div', { className: 'pf-empty' }, '正在按规则挑图……')
                      : cleanRows.length === 0
                        ? h(
                            'div',
                            { className: 'pf-empty' },
                            `按「入库满 ${cleanDays} 天 + 从未被引用 + 未置顶 + 不属于当前会话」挑，一张都不该动 —— 说明库里没有可清的图。`
                          )
                        : h(
                            'div',
                            { className: 'pf-list' },
                            cleanRows.map((row) =>
                              h(
                                'label',
                                { className: 'pf-row', key: row.sha, title: (Array.isArray(row.reasons) ? row.reasons : []).join('；') },
                                h('input', {
                                  type: 'checkbox',
                                  checked: picked.has(row.sha),
                                  onChange: () => {
                                    const next = new Set(picked);
                                    if (next.has(row.sha)) next.delete(row.sha);
                                    else next.add(row.sha);
                                    setPicked(next);
                                  }
                                }),
                                h('img', { className: 'pf-row-thumb', src: row.url, alt: row.label, loading: 'lazy' }),
                                h('span', { className: 'pf-row-name' }, rowLabel(row, 0)),
                                h('span', { className: 'pf-row-meta' }, `${row.day} · ${sizeText(row.bytes)}`),
                                h('span', { className: 'pf-row-why' }, (Array.isArray(row.reasons) ? row.reasons : [])[0] ?? '')
                              )
                            )
                          ),
                    h(
                      'div',
                      { className: 'pf-cleanfoot' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'pf-btn',
                          'data-primary': '1',
                          disabled: picked.size === 0 || working,
                          title: '搬进回收站：附件库里不再有它们，工作区里的缩略副本一起清掉；7 天内可撤销，超期真删',
                          onClick: () => {
                            const shas = Array.from(picked);
                            setWorking(true);
                            trashMove(sessionId, shas).then(
                              (payload) => {
                                const moved = Array.isArray(payload.moved) ? payload.moved.length : 0;
                                const bytes = Number.isFinite(payload.bytes) ? payload.bytes : 0;
                                const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
                                setToast(`已移入回收站 ${moved} 张${bytes > 0 ? `（${sizeText(bytes)}）` : ''}${skipped > 0 ? `，${skipped} 张没动` : ''} —— 7 天内可撤销`);
                                setPicked(new Set());
                                forgetImages(sessionId);
                                reload();
                                void loadCleanup(sessionId, cleanDays).then(setClean, () => undefined);
                                void loadTrash().then(setTrash, () => undefined);
                              },
                              (error) => setToast(error instanceof Error ? error.message : String(error))
                            ).finally(() => setWorking(false));
                          }
                        },
                        working ? '…' : `移入回收站${picked.size > 0 ? ` ${picked.size} 张` : ''}`
                      ),
                      h('span', { className: 'pf-spacer' }),
                      trashCount > 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'pf-btn',
                              disabled: working,
                              title: '把回收站里的图全部放回附件库',
                              onClick: () => {
                                setWorking(true);
                                trashRestore(sessionId, []).then(
                                  (payload) => {
                                    const back = Array.isArray(payload.restored) ? payload.restored.length : 0;
                                    setToast(`已撤销 ${back} 张，回到图片库`);
                                    forgetImages(sessionId);
                                    reload();
                                    void loadTrash().then(setTrash, () => undefined);
                                    void loadCleanup(sessionId, cleanDays).then(setClean, () => undefined);
                                  },
                                  (error) => setToast(error instanceof Error ? error.message : String(error))
                                ).finally(() => setWorking(false));
                              }
                            },
                            `全部撤销（${trashCount} 张 / ${sizeText(trashBytes)}）`
                          )
                        : null
                    ),
                    h('div', { className: 'pf-note' },
                      trashCount > 0
                        ? `回收站里 ${trashCount} 张 / ${sizeText(trashBytes)}（${trashRootText !== '' ? trashRootText : '插件回收站'}）：满 7 天后才真删，之后无法找回。置顶的图永远不会进候选，当前会话刚贴的也不会。`
                        : `规则：入库满 ${cleanDays} 天 + 从未被引用 + 未置顶 + 不属于当前会话。搬动只发生在插件自己的回收站目录${trashRootText !== '' ? `（${trashRootText}）` : ''}，不动官方附件库的其它内容。`
                    )
                  )
                : problem !== ''
                  ? h('div', { className: 'pf-empty' }, problem)
                  : shown.length === 0
                  ? h(
                      'div',
                      { className: 'pf-empty' },
                      filtering
                        ? `没找到「${q !== '' ? q : day}」对应的图。清空搜索或点「全部」看整库。`
                        : '还没有贴过图片。截图 Ctrl+V 粘进来之后，这里就会出现它；在输入框里打 @ 也能直接插到光标处。'
                    )
                  : h(
                      'div',
                      { className: 'pf-grid' },
                      shown.map((row, index) => {
                        const label = rowLabel(row, index);
                        const isFresh = freshSha !== '' && row.sha === freshSha;
                        return h(
                          'div',
                          { className: 'pf-cell', key: row.sha, 'data-fresh': isFresh ? '1' : '0' },
                          h('img', { className: 'pf-thumb', src: row.url, alt: label, loading: 'lazy', title: `点击放大 ${label}`, onClick: () => showZoom({ row, label }) }),
                          h(
                            'div',
                            { className: 'pf-name' },
                            label,
                            isFresh ? h('span', { className: 'pf-badge' }, '刚入库') : null,
                            typeof row.state === 'string' && STATE_TEXT[row.state] !== undefined
                              ? h('span', { className: 'pf-tag', title: (Array.isArray(row.reasons) ? row.reasons : []).join('；') }, STATE_TEXT[row.state])
                              : null,
                            row.noise === true ? h('span', { className: 'pf-tag', title: '小于 20 KB：多半是截了个角、一句话的截图这类噪音' }, '小') : null,
                            isRowPinned(row) ? h('span', { className: 'pf-tag', title: '已置顶：清理永远不碰它' }, '顶') : null
                          ),
                          h('div', { className: 'pf-meta', title: `${row.filename} · ${sizeText(row.bytes)}` }, `${row.label} · ${sizeText(row.bytes)}`),
                          h(
                            'div',
                            { className: 'pf-actions' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'pf-btn',
                                'data-primary': '1',
                                disabled: busy !== '',
                                title: `把「${label}」的引用插到光标所在的段落里——送出后模型看到的是这张图的路径`,
                                onClick: () => onInsert(row, label)
                              },
                              busy === row.sha ? '…' : '插到光标处'
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'pf-btn',
                                disabled: busy !== '',
                                title: '把这张图重新挂成这条消息的附件（模型直接看到图）',
                                onClick: () => onAttach(row)
                              },
                              busy === row.sha ? '…' : '挂上'
                            ),
                            h(
                              'button',
                              { type: 'button', className: 'pf-btn', title: '复制 markdown 图片语法', onClick: () => onPath(row) },
                              '路径'
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'pf-btn',
                                disabled: busy !== '',
                                title:
                                  isRowPinned(row)
                                    ? '已置顶：这张图永远不会进清理候选（点一下取消）'
                                    : '置顶：这张图永远不会进清理候选，也不会被自动清走',
                                onClick: () => {
                                  setBusy(row.sha);
                                  setPin(sessionId, row).then(
                                    (payload) => {
                                      const now = payload !== null && typeof payload === 'object' && payload.pinned === true;
                                      // 宿主说它现在是置顶的：与「原本置不置顶」不一致就记一次翻转，界面立刻翻面。
                                      pinFlip.set(row.sha, now !== (row.pinned === true));
                                      setToast(now ? `已置顶 ${label}：清理永远不碰它` : `已取消置顶 ${label}`);
                                      forgetImages(sessionId);
                                      reload();
                                    },
                                    (error) => setToast(error instanceof Error ? error.message : String(error))
                                  ).finally(() => setBusy(''));
                                }
                              },
                              busy === row.sha ? '…' : isRowPinned(row) ? '取消置顶' : '置顶'
                            )
                          )
                        );
                      })
                    ),
              snapshot !== undefined && snapshot.hasMore && snapshot.legacy !== true && problem === ''
                ? h(
                    'div',
                    { className: 'pf-more' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pf-btn',
                        onClick: () => setDepth(depth + 1)
                      },
                      `显示更早的 ${PAGE} 张（还有 ${Math.max(0, total - shown.length)} 张）`
                    )
                  )
                : null,
              h('div', { className: 'pf-note' }, `已显示 ${shown.length} / ${Math.max(total, shown.length)} 张。「插到光标处」= 在段落里留一个编号引用（图片N，固定编号），模型据此知道你说的是哪张；「挂上」= 把这张图重新作为附件发出去，模型直接看图。`),
              snapshot !== undefined && typeof snapshot.note === 'string' ? h('div', { className: 'pf-note' }, snapshot.note) : null
            )
          : null
      );
    }

    // ===================== @ 图片源 =====================

    function registerImageSource(ctx) {
      let installed = false;
      const resolveService = () => {
        try {
          const service = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
          if (service !== undefined) return service;
        } catch {
          /* 未注入时会抛，退回属性访问 */
        }
        try {
          return ctx.inputTriggers;
        } catch {
          return undefined;
        }
      };
      const install = () => {
        if (installed) return true;
        const triggers = resolveService();
        if (triggers === undefined || typeof triggers.registerSource !== 'function') return false;
        installed = true;
        ctx.effect(() =>
          triggers.registerSource({
            trigger: '@',
            name: '图片',
            order: 24,
            showGroupTitle: true,
            candidates: async (projection, options) => {
              const sessionId = projection !== undefined && typeof projection.sessionId === 'string' ? projection.sessionId : undefined;
              // @ 菜单的 onPick 拿不到会话，记账要用的会话先在这儿留一份。
              if (typeof sessionId === 'string' && sessionId !== '') atSessionId = sessionId;
              const raw = options !== undefined && typeof options.query === 'string' ? options.query.trim() : '';
              const parsed = classifyQuery(raw);
              // 搜索词点名到某一张（图片12 / 10-04 / 昨天）→ 全库找那一张；
              // 否则只列最近的一批（芯片要磁盘路径，全库预落盘代价太大）。
              // 旧宿主不认 q/day，点名也没用，直接走最近一页。
              const specific = hostLegacy !== true && (parsed.ordinal !== undefined || parsed.day !== '');
              let snapshot;
              try {
                snapshot = specific
                  ? await loadImages(sessionId, { q: raw, limit: 20, materialize: 20 })
                  : await loadImages(sessionId, { limit: MATERIALIZE, materialize: MATERIALIZE });
              } catch (error) {
                console.warn(`[dsh-picflow] @ 图片源不可用：${error instanceof Error ? error.message : String(error)}`);
                return [];
              }
              return snapshot.rows
                .filter((row) => {
                  if (specific) return true;
                  // 旧宿主：行上没有 ordinal/day，编号与日期都筛不了，索性把最近这一页都列出来
                  // （面板那边会提示「重启后可用搜索/筛选」）。
                  if (hostLegacy === true) return true;
                  if (raw === '') return true;
                  if (matchesRow(row, parsed)) return true;
                  return '图片imagepic'.includes(parsed.text);
                })
                .slice(0, MAX_ITEMS)
                .map((row, index) => {
                  const label = rowLabel(row, index);
                  return {
                    name: label,
                    description: '加载图像',
                    icon: 'file',
                    value: markdownFor(row),
                    label,
                    address: fileAddressOf(row.path),
                    fallback: markdownFor(row),
                    sha: row.sha
                  };
                });
            },
            onPick: (pick) => {
              const candidate = pick !== undefined ? pick.candidate : undefined;
              if (candidate === undefined) return undefined;
              // @ 里选走也算「用过」：账本记一笔，清理候选就不会碰它。
              reportUse(atSessionId, { sha: candidate.sha }, 'at');
              if (typeof candidate.address === 'string' && candidate.address !== '') {
                return {
                  insert: {
                    source: 'reference',
                    ref: candidate.address,
                    label: candidate.label,
                    appearance: 'file',
                    clipboardText: candidate.address
                  }
                };
              }
              const text = candidate.fallback;
              if (typeof text !== 'string' || text === '') return undefined;
              return { text };
            }
          })
        );
        return true;
      };
      if (install()) return;
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['inputTriggers'], () => install());
          return;
        } catch {
          /* 落到下面的兜底 */
        }
      }
      setTimeout(() => {
        if (!installed) console.warn('[dsh-picflow] inputTriggers 服务不可用：@ 图片源未注册（输入框下方的图片胶囊仍然可用）');
      }, 5000);
    }

    // ===================== 装配 =====================

    function apply(ctx) {
      ensureStyles();
      const ctxRef = { current: ctx };
      const Dock = (props) => PicDock({ ...props, ctxRef });
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: DOCK_ID,
            order: 6,
            inject: (sessionId) => ({ sessionId })
          },
          Dock
        )
      );
      registerImageSource(ctx);
      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: ZOOM_ID, order: 20 }, ZoomLayer)
        );
      } catch {
        console.warn('[dsh-picflow] shell.overlay 不可用：缩略图的点击放大浮层未注册（面板其余功能不受影响）');
      }
    }

    exports.name = 'picflow';
    exports.inject = ['slots', 'sessions'];
    exports.apply = apply;
    return module.exports;
  }
});
