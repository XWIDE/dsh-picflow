/**
 * Behaviour harness for dsh-picflow/client.js — the 「引用素材」 dock panel and
 * the `@图片` input-trigger source.
 *
 * It fakes exactly the surface the plugin touches (module loader, a minimal
 * React with hooks, the input shell that native reference chips are inserted
 * through, the sessions service and fetch) and asserts the two things the user
 * asked for: picking an image leaves a numbered reference chip (图片1), and the
 * panel inserts that chip at the caret with a correct `dsh-resource://` address.
 *
 * Run: node tests/chip.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

let failures = 0;
function check(label, ok, detail) {
	if (ok) {
		console.log(`ok   ${label}`);
		return;
	}
	failures += 1;
	console.log(`FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (rounds = 8) => {
	for (let index = 0; index < rounds; index += 1) await tick();
};
/** 插件里的 console.warn 收进来（贴图入库失败就是靠它报的），别弄脏测试输出。 */
const warnings = [];
console.warn = (...args) => {
	warnings.push(args.map((arg) => String(arg)).join(" "));
};

//#region minimal React: elements as plain objects, hooks kept per instance
function createReact() {
	let current = null;
	let schedule = null;
	function createElement(type, props, ...children) {
		return {
			type,
			props: { ...(props ?? {}), children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
		};
	}
	function useState(initial) {
		const instance = current;
		const index = instance.index++;
		if (!(index in instance.hooks)) instance.hooks[index] = { value: typeof initial === "function" ? initial() : initial };
		const slot = instance.hooks[index];
		return [slot.value, (next) => {
			slot.value = typeof next === "function" ? next(slot.value) : next;
			schedule?.(instance);
		}];
	}
	function useEffect(effect, deps) {
		const instance = current;
		const index = instance.index++;
		const prev = instance.hooks[index];
		const same = prev !== undefined && Array.isArray(deps) === Array.isArray(prev.deps) &&
			(Array.isArray(deps) ? deps.length === prev.deps.length && deps.every((dep, at) => Object.is(dep, prev.deps[at])) : true);
		if (same) return;
		if (prev !== undefined && typeof prev.cleanup === "function") prev.cleanup();
		// Record the deps BEFORE running the effect: a setState inside it re-enters
		// render synchronously, and that pass must see the new deps (real React
		// commits first and flushes the effect afterwards).
		const slot = { deps, cleanup: undefined };
		instance.hooks[index] = slot;
		slot.cleanup = effect();
	}
	return {
		createElement,
		useState,
		useEffect,
		onSchedule: (fn) => {
			schedule = fn;
		},
		mount(Component, props) {
			const instance = { hooks: [], index: 0, tree: null };
			instance.run = () => {
				const outer = current;
				current = instance;
				instance.index = 0;
				instance.tree = Component(props);
				current = outer;
				return instance.tree;
			};
			instance.run();
			return { instance };
		}
	};
}
//#endregion

function textOf(node) {
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (node === null || node === undefined || typeof node !== "object") return "";
	const children = Array.isArray(node.props?.children) ? node.props.children : [];
	return children.map(textOf).join("");
}

function findAll(node, predicate, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (predicate(node)) out.push(node);
	const children = Array.isArray(node.props?.children) ? node.props.children : [];
	for (const child of children) findAll(child, predicate, out);
	return out;
}

const buttons = (tree, label) => findAll(tree, (node) => node.type === "button" && textOf(node).trim() === label);

/** 渲染进程的 localStorage 替身：插件拿它存「粘贴后自动插入」这个开关。 */
function createStorage(seed) {
	const map = new Map();
	if (seed !== undefined) map.set("dsh-picflow.autoInsert", seed);
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			map.set(key, String(value));
		},
		removeItem: (key) => {
			map.delete(key);
		},
		dump: () => Object.fromEntries(map)
	};
}

//#region one loaded plugin instance over a fake app
function load(payload, options = {}) {
	const log = { fetches: [], insertReference: [], insertText: [], attachments: [], drafts: [], writes: [], admits: [] };
	// 开关默认「开」；options.autoInsert === false 时预置成用户曾经关掉过。
	const storage = options.storage ?? createStorage(options.autoInsert === false ? "0" : undefined);
	const react = createReact();
	const settleRenders = () => {};
	void settleRenders;
	const instances = [];
	react.onSchedule(() => {
		for (const instance of instances) instance.run();
	});

	const source1 = { trigger: "@", name: null, registered: 0 };
	const triggers = {
		registerSource(src) {
			source1.name = src.name;
			source1.options = src;
			source1.registered += 1;
			return () => {};
		}
	};

	const shell = {
		actions: { captureInsertion: () => ({ start: 3, end: 3, draftRev: 7 }) },
		insertReference: (ref, span) => {
			log.insertReference.push({ ref, span });
			return options.insertReferenceResult === undefined ? true : options.insertReferenceResult;
		},
		// 刚 Ctrl+V、还没发送的图：内核只把它们放在内存里（runtime-only draft），
		// 面板靠 snapshot.attachmentIds + resolveDraftAttachments 才摸得到字节。
		...(options.draftImages === undefined
			? {}
			: {
					snapshot: {
						// 真实的 input shell 每次都给新快照：这里跟着 options.draftImages 走，
						// 好让测试在挂载之后再「粘贴」。
						get attachmentIds() {
							return options.draftImages.map((draft) => draft.id);
						},
						draft: "",
						draftRev: 1,
						phase: "idle"
					}
				})
	};
	const conversation = {
		createDrafts: (sessionId, files) => {
			log.drafts.push({ sessionId, files });
			return [{ id: "draft-1" }, { id: "draft-2" }];
		},
		resolveDraftAttachments: (ids) => (options.draftImages ?? []).filter((draft) => ids.includes(draft.id)),
		input: { for: () => (options.noShell === true ? undefined : shell) }
	};
	const sessions = { scope: () => ({ get: (name) => (name === "conversation" ? conversation : undefined) }) };

	const registered = [];
	const ctx = {
		sessions,
		slots: {
			inject(_name, factory) {
				registered.push(factory());
			},
			register(options2, Component) {
				return { options: options2, Component };
			}
		},
		effect(fn) {
			fn();
		},
		get: (name) => (name === "inputTriggers" ? triggers : undefined)
	};

	let moduleExports = null;
	const windowStub = {
		__ModuleLoader__: {
			load({ factory }) {
				moduleExports = factory((id) => {
					if (id === "react") return react;
					throw new Error(`unexpected require(${id})`);
				});
			}
		},
		open: (url) => log.writes.push(url)
	};
	const fetchStub = async (url, init) => {
		const href = String(url);
		log.fetches.push(href);
		if (href.includes("/version")) {
			const stamp = typeof options.stamp === "function" ? options.stamp() : options.stamp ?? "";
			return { ok: true, status: 200, json: async () => ({ stamp, root: "C:\\fake\\attachments\\v1" }) };
		}
		if (href.includes("/admit?")) {
			log.admits.push({ href, method: init?.method, type: init?.headers?.["content-type"], body: init?.body });
			if (options.admitFails === true) {
				return { ok: false, status: 404, json: async () => ({ ok: false, error: "not-found", hint: "宿主没这条路由" }) };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					sha: "d".repeat(64),
					ordinal: 4,
					label: "图片4",
					bytes: 1024,
					ext: "png",
					path: options.admitPath ?? "C:\\tmp\\pics\\pic-d.png",
					row: { sha: "d".repeat(64), url: "/plugins/dsh-picflow/raw?ref=ddd", label: "10-05 10:11", filename: "pic-d.png", bytes: 1024, ext: "png", ordinal: 4, day: "10-05" }
				})
			};
		}
		if (href.includes("/images?")) {
			const params = new URLSearchParams(href.split("?")[1] ?? "");
			const copy = () => JSON.parse(JSON.stringify(payload));
			if (params.get("pin") !== null) {
				const pin = params.get("pin");
				const pinPath = options.pinPath ?? `C:\\tmp\\pics\\pinned-${pin.slice(0, 4)}.png`;
				return { ok: true, status: 200, json: async () => ({ ...copy(), pinned: { sha: pin, path: pinPath } }) };
			}
			return { ok: true, status: 200, json: async () => copy() };
		}
		return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) };
	};
	const navigatorStub = { clipboard: { writeText: async (text) => log.writes.push(text) } };
	const locationStub = { origin: "http://127.0.0.1:52962" };
	const documentStub = {
		listeners: {},
		querySelector: () => ({ dataset: {} }),
		createElement: () => ({ dataset: {}, appendChild() {} }),
		head: { appendChild() {} },
		addEventListener(type, handler) {
			(documentStub.listeners[type] ??= []).push(handler);
		},
		removeEventListener(type, handler) {
			documentStub.listeners[type] = (documentStub.listeners[type] ?? []).filter((entry) => entry !== handler);
		}
	};

	const intervals = [];
	// 只劫持 setInterval：轮询（贴图入库 350ms、库指纹 3000ms）由 world.beat(ms) 手动驱动；
	// setTimeout 保持真的——搜索防抖得按真实时间等。
	const setIntervalStub = (fn, ms) => {
		const id = intervals.length + 1;
		intervals.push({ id, fn, ms, on: true });
		return id;
	};
	const clearIntervalStub = (id) => {
		const slot = intervals.find((entry) => entry.id === id);
		if (slot !== undefined) slot.on = false;
	};

	// eslint-disable-next-line no-new-func
	new Function("window", "document", "location", "fetch", "navigator", "setInterval", "clearInterval", "localStorage", source)(
		windowStub,
		documentStub,
		locationStub,
		fetchStub,
		navigatorStub,
		setIntervalStub,
		clearIntervalStub,
		storage
	);
	moduleExports.apply(ctx);

	const entry = registered[0];
	const inputActions = {
		captureInsertion: () => ({ start: 3, end: 3, draftRev: 7 }),
		insertText: (text, span) => {
			log.insertText.push({ text, span });
			return true;
		},
		addAttachments: (ids) => {
			log.attachments.push(ids);
			return true;
		}
	};
	const mounted = react.mount(entry.Component, { sessionId: "session-1", inputActions });
	instances.push(mounted.instance);
	const layer = registered.find((item) => item.options?.name === "shell.overlay");
	const mountedLayer = layer === undefined ? undefined : react.mount(layer.Component, {});
	if (mountedLayer !== undefined) instances.push(mountedLayer.instance);
	return {
		log,
		entry,
		source: source1,
		tree: () => mounted.instance.tree,
		layerTree: () => (mountedLayer === undefined ? null : mountedLayer.instance.tree),
		hasLayer: mountedLayer !== undefined,
		mountState: mounted,
		inputActions,
		document: documentStub,
		storage,
		/** 手动驱动一次轮询（ms 用注册时的周期匹配：350 = 贴图入库，3000 = 库指纹）。 */
		async beat(ms) {
			for (const slot of intervals) if (slot.on && slot.ms === ms) slot.fn();
			await settle();
		}
	};
}
//#endregion

//#region fixtures
const rows = [
	{ sha: "a".repeat(64), url: "/plugins/dsh-picflow/raw?ref=aaa", label: "10-05 09:01", filename: "pic-a.png", bytes: 10389, ext: "png", path: "C:\\tmp\\pics\\pic-a.png", ordinal: 1, day: "10-05" },
	{ sha: "b".repeat(64), url: "/plugins/dsh-picflow/raw?ref=bbb", label: "10-05 08:40", filename: "pic b.png", bytes: 2048, ext: "png", path: "C:\\Users\\Administrator\\我的 图\\pic b.png", ordinal: 2, day: "10-05" },
	{ sha: "c".repeat(64), url: "/plugins/dsh-picflow/raw?ref=ccc", label: "10-05 08:12", filename: "pic-c.jpg", bytes: 400000, ext: "jpg", ordinal: 3, day: "10-05" }
];
const payload = {
	rows,
	total: 3,
	libraryTotal: 490,
	totalBytes: 412237,
	days: [
		{ day: "10-05", count: 3 },
		{ day: "10-04", count: 61 },
		{ day: "10-03", count: 18 }
	],
	hasMore: true,
	nextOffset: 3,
	sort: "new"
};

const A1 = "dsh-resource://file/absolute/C:/tmp/pics/pic-a.png";
const A2 = "dsh-resource://file/absolute/C:/Users/Administrator/%E6%88%91%E7%9A%84%20%E5%9B%BE/pic%20b.png";
//#endregion

//#region 1. registration + @ source
{
	const world = load(payload);
	check("dock registered on conversation.composer.dock", world.entry.options.name === "conversation.composer.dock" && world.entry.options.id === "dsh-picflow-dock", JSON.stringify(world.entry.options));
	check("dock order keeps it after the built-in rows", world.entry.options.order === 6, String(world.entry.options.order));
	check("@ source registered under the 「图片」 group title", world.source.name === "图片" && world.source.registered === 1, String(world.source.name));

	const candidates = await world.source.options.candidates({ sessionId: "session-1" }, { query: "" });
	check("@ menu lists 图片1/图片2/图片3", candidates.map((row) => row.name).join(",") === "图片1,图片2,图片3", JSON.stringify(candidates.map((row) => row.name)));
	check("@ menu rows read 「加载图像」", candidates.every((row) => row.description === "加载图像"));
	check("@ menu carries the file address for materialised rows", candidates[0].address === A1 && candidates[1].address === A2, `${candidates[0].address} / ${candidates[1].address}`);
	check("@ menu leaves the address off a row with no disk copy", candidates[2].address === undefined, String(candidates[2].address));

	const picked = world.source.options.onPick({ candidate: candidates[0] });
	check("picking an image inserts a native reference chip", picked?.insert?.source === "reference" && picked.insert.appearance === "file", JSON.stringify(picked));
	check("chip carries the numbered label 图片1", picked?.insert?.label === "图片1", JSON.stringify(picked?.insert));
	check("chip points at the dsh-resource address", picked?.insert?.ref === A1 && picked?.insert?.clipboardText === A1, JSON.stringify(picked?.insert));

	const fallback = world.source.options.onPick({ candidate: candidates[2] });
	check("picking a row without a disk copy falls back to markdown text", typeof fallback?.text === "string" && fallback.text.includes("![10-05 08:12](http://127.0.0.1:52962/plugins/dsh-picflow/raw?ref=ccc)"), JSON.stringify(fallback));
	check("no insert outcome when there is nothing to insert", world.source.options.onPick({}) === undefined);
}

//#region 2. dock panel: numbered cells, chip insert, fallback, attach
{
	const world = load(payload);
	await settle();
	check("pill reports the library size", textOf(world.tree()).includes("490 张图"), textOf(world.tree()));

	buttons(world.tree(), "490 张图")[0].props.onClick();
	check("panel header reads 引用素材 · 库里 N 张", textOf(world.tree()).includes("引用素材 · 库里 490 张"), textOf(world.tree()).slice(0, 120));
	check("panel shows one numbered cell per image (图片1…图片3)", ["图片1", "图片2", "图片3"].every((label) => textOf(world.tree()).includes(label)));

	const insertButtons = buttons(world.tree(), "插到光标处");
	check("every cell offers 插到光标处", insertButtons.length === 3, String(insertButtons.length));

	insertButtons[0].props.onClick();
	check("panel inserts a chip at the caret", world.log.insertReference.length === 1, JSON.stringify(world.log.insertReference));
	check("panel chip is source=reference + 图片1 + address", world.log.insertReference[0]?.ref?.source === "reference" && world.log.insertReference[0]?.ref?.label === "图片1" && world.log.insertReference[0]?.ref?.ref === A1, JSON.stringify(world.log.insertReference[0]));
	check("panel chip uses the caret span", world.log.insertReference[0]?.span?.draftRev === 7 && world.log.insertReference[0]?.span?.start === 3, JSON.stringify(world.log.insertReference[0]?.span));

	buttons(world.tree(), "插到光标处")[1].props.onClick();
	check("chinese/space path is percent-encoded but keeps the drive colon", world.log.insertReference[1]?.ref?.ref === A2, String(world.log.insertReference[1]?.ref?.ref));

	buttons(world.tree(), "插到光标处")[2].props.onClick();
	await settle();
	check(
		"row without a disk copy is materialised on demand, then inserted",
		world.log.fetches.some((href) => href.includes("pin=") && href.includes(rows[2].sha)) &&
			world.log.insertReference.length === 3 &&
			world.log.insertReference[2]?.ref?.ref === "dsh-resource://file/absolute/C:/tmp/pics/pinned-cccc.png",
		JSON.stringify({ fetches: world.log.fetches, refs: world.log.insertReference.map((entry) => entry.ref.ref) })
	);

	buttons(world.tree(), "挂上")[0].props.onClick();
	await settle();
	check("挂上 uploads the bytes as a fresh draft", world.log.drafts.length === 1 && world.log.drafts[0].files[0] instanceof File && world.log.drafts[0].files[0].name === "pic-a.png", JSON.stringify(world.log.drafts.map((entry) => entry.files.map((file) => file.name))));
	check("挂上 adds the returned draft ids to the composer", world.log.attachments[0]?.join(",") === "draft-1,draft-2", JSON.stringify(world.log.attachments));

	buttons(world.tree(), "路径")[0].props.onClick();
	await settle();
	check("路径 copies the markdown reference", world.log.writes.some((value) => String(value).includes("![10-05 09:01](C:/tmp/pics/pic-a.png)")), JSON.stringify(world.log.writes));

	const zoomLayer = () => findAll(world.layerTree(), (node) => node.props?.className === "pf-zoom");
	check("the zoom layer is registered on shell.overlay", world.hasLayer === true, JSON.stringify(Object.keys(world)));
	check("no zoom overlay before a click", zoomLayer().length === 0, JSON.stringify(zoomLayer()));
	findAll(world.tree(), (node) => node.props?.className === "pf-thumb")[0].props.onClick();
	check("clicking a thumbnail opens the built-in zoom overlay", zoomLayer().length === 1 && zoomLayer()[0].props.children[0].props.src === rows[0].url, JSON.stringify(zoomLayer()[0]?.props?.children?.[0]?.props));
	check("the overlay names the image it shows", textOf(zoomLayer()[0]).includes("图片1") && textOf(zoomLayer()[0]).includes("pic-a.png"), textOf(zoomLayer()[0]));
	zoomLayer()[0].props.onClick();
	check("clicking the overlay closes it", zoomLayer().length === 0, JSON.stringify(zoomLayer()));

	findAll(world.tree(), (node) => node.props?.className === "pf-thumb")[0].props.onClick();
	check("overlay registers an Escape handler", (world.document.listeners.keydown ?? []).length === 1, JSON.stringify(Object.keys(world.document.listeners)));
	for (const handler of world.document.listeners.keydown ?? []) handler({ key: "Escape" });
	check("Escape closes the zoom overlay", zoomLayer().length === 0, JSON.stringify(zoomLayer()));
	check("Escape handler is removed with the overlay", (world.document.listeners.keydown ?? []).length === 0, JSON.stringify(Object.keys(world.document.listeners)));
}

//#region 3. no input shell / busy composer
{
	const world = load(payload, { noShell: true });
	await settle();
	buttons(world.tree(), "490 张图")[0].props.onClick();
	buttons(world.tree(), "插到光标处")[0].props.onClick();
	check("without the input shell the panel falls back to plain text", world.log.insertReference.length === 0 && world.log.insertText.length === 1, JSON.stringify(world.log));

	const busy = load(payload, { insertReferenceResult: false });
	await settle();
	buttons(busy.tree(), "490 张图")[0].props.onClick();
	buttons(busy.tree(), "插到光标处")[0].props.onClick();
	check("a busy composer reports instead of falling back silently", busy.log.insertReference.length === 1 && busy.log.insertText.length === 0);
	check("the busy toast is surfaced to the user", textOf(busy.tree()).includes("输入框正忙"), textOf(busy.tree()).slice(-160));
}

//#region 4. the fetch guard
{
	const world = load({ rows: [], total: 0, totalBytes: 0 });
	await settle();
	check("dock asks the host for the session's images", world.log.fetches[0]?.includes("/plugins/dsh-picflow/images?") && world.log.fetches[0].includes("limit=120") && world.log.fetches[0].includes("session=session-1") && !world.log.fetches[0].includes("materialize="), world.log.fetches[0]);
}

//#region 5. finding one image in a 490-image library
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
{
	const world = load(payload);
	await settle();
	buttons(world.tree(), "490 张图")[0].props.onClick();

	const search = findAll(world.tree(), (node) => node.props?.className === "pf-search")[0];
	check("panel has a search box", search !== undefined && search.props.placeholder.includes("图片12"), JSON.stringify(search?.props));
	check("panel offers 全部 + per-day chips", textOf(world.tree()).includes("全部 490") && textOf(world.tree()).includes("10-04 61"), textOf(world.tree()).slice(0, 200));
	check("panel offers 最新 / 最早 / 最大", ["最新", "最早", "最大"].every((label) => buttons(world.tree(), label).length === 1));
	check("panel shows the real library size and the hit count", textOf(world.tree()).includes("引用素材 · 库里 490 张") && textOf(world.tree()).includes("已显示 3 / 3 张"), textOf(world.tree()).slice(0, 120));
	check("panel offers to load older pages", buttons(world.tree(), "显示更早的 120 张（还有 0 张）").length === 1, textOf(world.tree()).slice(-260));

	search.props.onChange({ target: { value: "图片12" } });
	await wait(340);
	await settle();
	const afterSearch = world.log.fetches.at(-1);
	check("typing searches the whole library, not just this page", afterSearch.includes("q=%E5%9B%BE%E7%89%8712") && afterSearch.includes("limit=120"), afterSearch);

	buttons(world.tree(), "10-04 61")[0].props.onClick();
	await settle();
	check("clicking a day chip filters that day", world.log.fetches.at(-1).includes("day=10-04"), world.log.fetches.at(-1));
	const dayOn = buttons(world.tree(), "10-04 61")[0].props["data-on"];
	const before = world.log.fetches.length;
	buttons(world.tree(), "10-04 61")[0].props.onClick();
	await settle();
	const dayOff = buttons(world.tree(), "10-04 61")[0].props["data-on"];
	const allOn = buttons(world.tree(), "全部 490")[0].props["data-on"];
	check(
		"clicking the same day chip again clears the filter (and the 20s snapshot cache answers it)",
		dayOn === "1" && dayOff === "0" && allOn === "1" && world.log.fetches.length === before,
		`chip ${dayOn} -> ${dayOff} · 全部 ${allOn} · fetches ${before} -> ${world.log.fetches.length}`
	);

	buttons(world.tree(), "最早")[0].props.onClick();
	await settle();
	check("sorting by 最早 asks the host for oldest first", world.log.fetches.at(-1).includes("sort=old"), world.log.fetches.at(-1));
}
{
	const older = { ...payload, rows: [{ ...rows[0], ordinal: 12, day: "10-05" }], total: 490, hasMore: true };
	const world = load(older);
	await settle();
	buttons(world.tree(), "490 张图")[0].props.onClick();
	check("cell numbering comes from the host ordinal, not the row position", textOf(world.tree()).includes("图片12"), textOf(world.tree()).slice(0, 200));

	buttons(world.tree(), "显示更早的 120 张（还有 489 张）")[0].props.onClick();
	await settle();
	check("showing older pages raises the request limit", world.log.fetches.at(-1).includes("limit=240"), world.log.fetches.at(-1));
}

//#region 6. an old host half (only a restart swaps the plugin's host module)
{
	// 旧宿主：没有 libraryTotal/days/hasMore，行上是旧字段。
	const legacyPayload = {
		rows: rows.map((row) => ({ sha: row.sha, url: row.url, label: row.label, filename: row.filename, bytes: row.bytes, ext: row.ext, path: row.path })),
		total: 60,
		totalBytes: 412237,
		note: "按时间倒序列出最近 60 张。"
	};
	const world = load(legacyPayload);
	await settle();
	check(
		"old host: the panel re-asks with the legacy contract (one page, materialised)",
		world.log.fetches.length === 2 && world.log.fetches[0].includes("limit=120") && world.log.fetches[1].includes("limit=60") && world.log.fetches[1].includes("materialize=60"),
		JSON.stringify(world.log.fetches)
	);

	buttons(world.tree(), "60 张图")[0].props.onClick();
	// 点开会强制重取一次（新行为），等它落地再数后面的请求。
	await settle();
	check("old host: the panel says why the filters are missing", textOf(world.tree()).includes("宿主半边还是旧版"), textOf(world.tree()).slice(0, 200));
	check("old host: search box and paging button are not offered", findAll(world.tree(), (node) => node.props?.className === "pf-search").length === 0 && buttons(world.tree(), "显示更早的 120 张（还有 0 张）").length === 0);

	const before = world.log.fetches.length;
	buttons(world.tree(), "插到光标处")[0].props.onClick();
	await settle();
	check(
		"old host: inserting still works straight from the materialised path",
		world.log.insertReference.length === 1 && world.log.insertReference[0]?.ref?.ref === A1 && world.log.fetches.length === before && !world.log.fetches.some((href) => href.includes("pin=")),
		JSON.stringify({ refs: world.log.insertReference.length, fetches: world.log.fetches.slice(before) })
	);

	const candidates = await world.source.options.candidates({ sessionId: "session-1" }, { query: "图片12" });
	check(
		"old host: the @ source skips the whole-library lookup it cannot answer",
		!world.log.fetches.at(-1).includes("q=") && candidates.map((row) => row.name).join(",") === "图片1,图片2,图片3",
		JSON.stringify({ last: world.log.fetches.at(-1), names: candidates.map((row) => row.name) })
	);
}

//#region 7. 贴图入库：Ctrl+V 之后不用重启、不用刷新就能引用
const pastedFile = (name) =>
	typeof File === "function"
		? new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" })
		: Object.assign(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), { name });
{
	// 真实顺序：面板一直挂着，用户之后才按 Ctrl+V。
	const drafts = [];
	const world = load(payload, { draftImages: drafts });
	await settle();
	check("贴图入库：没贴图的时候一次也不打扰宿主", world.log.admits.length === 0, JSON.stringify(world.log.admits));

	drafts.push({ id: "draft-9", kind: "image", file: pastedFile("微信截图.png") });
	await world.beat(350);
	const admit = world.log.admits[0];
	check(
		"贴图入库：粘贴后把字节 POST 给宿主 /admit（带会话和原名）",
		world.log.admits.length === 1 && admit.method === "POST" && admit.type === "image/png" &&
			admit.href.includes("session=session-1") && admit.href.includes("name=%E5%BE%AE%E4%BF%A1%E6%88%AA%E5%9B%BE.png"),
		JSON.stringify(admit)
	);
	check("贴图入库：body 就是那张图的字节", admit.body?.size === 8, String(admit.body?.size));
	check(
		"贴图入库：入库成功后强制重取一次（不吃 20 秒快照缓存）",
		world.log.fetches.filter((href) => href.includes("/images?")).length === 2,
		JSON.stringify(world.log.fetches)
	);

	// 开关默认开：程序自己点「插到光标处」，芯片直接落在光标处。
	check(
		"贴图入库：开关默认开 —— 粘贴后芯片自动落到光标处（等于程序替你点了那颗按钮）",
		world.log.insertReference.length === 1 &&
			world.log.insertReference[0]?.ref?.ref === "dsh-resource://file/absolute/C:/tmp/pics/pic-d.png" &&
			world.log.insertReference[0]?.ref?.label === "图片4" &&
			world.log.insertReference[0]?.span?.draftRev === 7,
		JSON.stringify(world.log.insertReference)
	);
	check(
		"贴图入库：自动插好了就不再弹面板（不挡你打字），提示走卡片外的 pf-flash",
		!textOf(world.tree()).includes("引用素材 · 库里") &&
			findAll(world.tree(), (node) => node.props?.className === "pf-flash").length === 1 &&
			textOf(world.tree()).includes("图片4 已自动插到光标处"),
		textOf(world.tree()).slice(0, 220)
	);

	// 同一张草稿不会被反复送（350ms 一次轮询，送完就记账）。
	await world.beat(350);
	await world.beat(350);
	check("贴图入库：同一张草稿只送一次", world.log.admits.length === 1, String(world.log.admits.length));
}
{
	// 开关关掉之后：只入库，插不插由用户点（面板照旧自己冒出来）。
	const drafts = [];
	const world = load(payload, { draftImages: drafts, autoInsert: false });
	await settle();
	drafts.push({ id: "draft-11", kind: "image", file: pastedFile("微信截图3.png") });
	await world.beat(350);
	check("贴图入库：开关关着时不自动插入", world.log.insertReference.length === 0, JSON.stringify(world.log.insertReference));

	// 用户什么也没点：面板自己冒出来，提示也在面板里。
	check(
		"贴图入库：面板自己打开（用户不用去点胶囊）",
		textOf(world.tree()).includes("引用素材 · 库里 490 张"),
		textOf(world.tree()).slice(0, 220)
	);
	check("贴图入库：面板里直接告诉用户「图片4 已入库」", textOf(world.tree()).includes("图片4 已入库"), textOf(world.tree()).slice(0, 220));

	// 刚入库那张立刻可见：宿主清单还没被刷新出来也先顶到最前面，并打上「刚入库」。
	const cells = findAll(world.tree(), (node) => node.props?.className === "pf-cell");
	check("贴图入库：刚入库的图立刻出现在网格里（第一格）", textOf(cells[0]).includes("图片4"), JSON.stringify(cells.map((cell) => textOf(cell).slice(0, 24))));
	check("贴图入库：刚入库那格带「刚入库」标记", cells[0]?.props?.["data-fresh"] === "1" && textOf(cells[0]).includes("刚入库"), JSON.stringify({ fresh: cells[0]?.props?.["data-fresh"], text: textOf(cells[0]) }));
	check("贴图入库：其它格没有「刚入库」标记", cells.slice(1).every((cell) => cell.props?.["data-fresh"] !== "1"), JSON.stringify(cells.slice(1).map((cell) => cell.props?.["data-fresh"])));

	// 宿主入库时已经把副本落进工作区了：刚入库那一格直接能插，不用再等一次落盘。
	const pinsBefore = world.log.fetches.filter((href) => href.includes("pin=")).length;
	buttons(world.tree(), "插到光标处")[0].props.onClick();
	await settle();
	check(
		"贴图入库：刚入库那格直接能插到光标处（用入库时落好的路径，不再等落盘）",
		world.log.insertReference.length === 1 &&
			world.log.insertReference[0]?.ref?.ref === "dsh-resource://file/absolute/C:/tmp/pics/pic-d.png" &&
			world.log.fetches.filter((href) => href.includes("pin=")).length === pinsBefore,
		JSON.stringify({ refs: world.log.insertReference.map((entry) => entry.ref.ref), fetches: world.log.fetches.slice(-3) })
	);

	// 面板里那颗开关：点一下 = 以后自动插入，写进 localStorage，刷新后还记得。
	check("贴图入库：面板里有「自动插入 关」这颗开关", buttons(world.tree(), "自动插入 关").length === 1, JSON.stringify(buttons(world.tree(), "自动插入 关").length));
	buttons(world.tree(), "自动插入 关")[0].props.onClick();
	await settle();
	check(
		"贴图入库：点开关就写进 localStorage（刷新/重启后仍然记得）",
		world.storage.dump()["dsh-picflow.autoInsert"] === "1" && buttons(world.tree(), "自动插入 开").length === 1,
		JSON.stringify(world.storage.dump())
	);

	// 把面板收起来（再点一次胶囊）：提示改在卡片外面显示，用户仍然看得见。
	buttons(world.tree(), "490 张图")[0].props.onClick();
	await settle();
	check(
		"贴图入库：面板收起来后提示还在（卡片外的 pf-flash）",
		findAll(world.tree(), (node) => node.props?.className === "pf-flash").length === 1 &&
			textOf(world.tree()).includes("以后贴图会自动插到光标处"),
		textOf(world.tree()).slice(0, 220)
	);
}
{
	// @ 菜单吃的是同一份 20 秒缓存：刚入库的图必须马上能在 @ 里选中它的编号。
	const drafts = [];
	const world = load(payload, { draftImages: drafts });
	await settle();
	await world.source.options.candidates({ sessionId: "session-1" }, { query: "" });
	await world.source.options.candidates({ sessionId: "session-1" }, { query: "" });
	const cached = world.log.fetches.filter((href) => href.includes("/images?")).length;
	check("贴图入库：@ 菜单第二次问走缓存（不打宿主）", cached === 2, JSON.stringify(world.log.fetches));

	drafts.push({ id: "draft-10", kind: "image", file: pastedFile("微信截图2.png") });
	await world.beat(350);
	const afterAdmit = world.log.fetches.filter((href) => href.includes("/images?")).length;
	await world.source.options.candidates({ sessionId: "session-1" }, { query: "" });
	check(
		"贴图入库：入库后 @ 菜单立刻重问宿主（缓存已清，不用等 20 秒）",
		afterAdmit === cached + 1 && world.log.fetches.filter((href) => href.includes("/images?")).length === afterAdmit + 1,
		JSON.stringify(world.log.fetches)
	);
}
{
	// 旧宿主没有 /admit（要重启 DSH NEXT 才换得到宿主模块）：失败了就记账，别每次轮询都撞一次。
	warnings.length = 0;
	const drafts = [{ id: "draft-old", kind: "image", file: pastedFile("old.png") }];
	const world = load(payload, { draftImages: drafts, admitFails: true });
	await settle();
	await world.beat(350);
	await world.beat(350);
	check("旧宿主：入库失败只试一次，之后不再重试", world.log.admits.length === 1, String(world.log.admits.length));
	check("旧宿主：失败原因进 console.warn", warnings.some((line) => line.includes("贴图入库失败")), JSON.stringify(warnings));
	check("旧宿主：入库失败不影响面板正常列图", world.log.fetches.some((href) => href.includes("/images?")), JSON.stringify(world.log.fetches));
	check("旧宿主：入库失败不会把面板硬弹出来", !textOf(world.tree()).includes("引用素材 · 库里"), textOf(world.tree()).slice(0, 160));
}
{
	// 兜底指纹：别的窗口让库变了，面板自己跟上。
	let stamp = "1000:14";
	const world = load(payload, { stamp: () => stamp });
	await settle();
	const beforeVersion = world.log.fetches.length;
	const beforeImages = world.log.fetches.filter((href) => href.includes("/images?")).length;
	await world.beat(3000);
	check(
		"库指纹没变：只问一次指纹，不重取清单",
		world.log.fetches.length === beforeVersion + 1 && world.log.fetches.at(-1).includes("/version") &&
			world.log.fetches.filter((href) => href.includes("/images?")).length === beforeImages,
		JSON.stringify(world.log.fetches.slice(beforeVersion))
	);
	stamp = "2000:15";
	await world.beat(3000);
	check(
		"库指纹变了：面板自己重取清单",
		world.log.fetches.filter((href) => href.includes("/images?")).length === beforeImages + 1,
		JSON.stringify(world.log.fetches.slice(beforeVersion))
	);
}
{
	// 点开面板 = 立刻要看到刚贴的图，不等 3 秒轮询。
	const world = load(payload);
	await settle();
	const before = world.log.fetches.filter((href) => href.includes("/images?")).length;
	buttons(world.tree(), "490 张图")[0].props.onClick();
	await settle();
	check(
		"点开面板就强制重取一次（缓存里有旧快照也绕开）",
		world.log.fetches.filter((href) => href.includes("/images?")).length === before + 1,
		JSON.stringify(world.log.fetches)
	);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
