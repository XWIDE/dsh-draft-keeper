/**
 * Behaviour harness for dsh-draft-keeper/client.js.
 *
 * It fakes exactly the surface the plugin touches — the module loader, React
 * hooks, the session/composer services and IndexedDB — then exercises the
 * switch-away/come-back paths. It proves the plugin's own logic, not the app's.
 *
 * Run: node tests/harness.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

let failures = 0;
const checks = [];
function check(label, condition, detail) {
	checks.push({ label, ok: Boolean(condition), detail });
	if (!condition) failures += 1;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (rounds = 6) => {
	for (let index = 0; index < rounds; index += 1) await tick();
};

//#region fake IndexedDB — durable across "reloads" because the map outlives the module
const durable = new Map();

function fakeIndexedDB(store) {
	return {
		open() {
			const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
			setTimeout(() => {
				const db = {
					objectStoreNames: { contains: (name) => name === "drafts" },
					createObjectStore: () => {},
					transaction(_name, mode) {
						const tx = { oncomplete: null, onerror: null, onabort: null };
						tx.objectStore = () => ({
							get: (key) => {
								const get = { result: structuredClone(store.get(key)), onsuccess: null, onerror: null };
								setTimeout(() => { get.onsuccess?.(); tx.oncomplete?.(); }, 0);
								return get;
							},
							put: (value) => {
								const put = { onsuccess: null, onerror: null };
								setTimeout(() => { store.set(value.sessionId, structuredClone(value)); tx.oncomplete?.(); }, 0);
								return put;
							},
							delete: (key) => {
								const del = { onsuccess: null, onerror: null };
								setTimeout(() => { store.delete(key); tx.oncomplete?.(); }, 0);
								return del;
							}
						});
						void mode;
						return tx;
					}
				};
				request.result = db;
				request.onupgradeneeded?.();
				request.onsuccess?.();
			}, 0);
			return request;
		}
	};
}

//#endregion

//#region fake services
function createStore(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			snapshot = next;
			for (const listener of [...listeners]) listener();
		}
	};
}

function createWorld() {
	const notices = [];
	const world = {};
	world.drafts = [];
	let seq = 0;

	world.shell = {
		state: createStore({ draft: "", attachmentIds: [], phase: "plain" }),
		addAttachments(ids) {
			const state = this.state.getSnapshot();
			if (state.phase === "adjudicating" || state.phase === "submitting") return false;
			if (ids.length === 0) return true;
			this.state.set({ ...state, attachmentIds: [...state.attachmentIds, ...ids] });
			return true;
		},
		setDraft(text) {
			this.state.set({ ...this.state.getSnapshot(), draft: text });
		},
		notify(level, text) {
			notices.push([level, text]);
		}
	};

	world.conversation = {
		createCalls: [],
		resolveCalls: 0,
		createDrafts(sessionId, files) {
			this.createCalls.push({ sessionId, files });
			return files.map((file) => {
				seq += 1;
				const draft = { kind: "image", id: `draft-${seq}`, file, previewUrl: `blob:${seq}` };
				world.drafts.push(draft);
				return draft;
			});
		},
		resolveDraftAttachments(ids) {
			this.resolveCalls += 1;
			return ids.map((id) => world.drafts.find((draft) => draft.id === id)).filter(Boolean);
		},
		releaseDraftAttachments(list) {
			for (const draft of list) world.drafts = world.drafts.filter((item) => item !== draft);
		}
	};
	world.conversation.input = { for: () => world.shell };

	world.sessionScopes = new Map();
	world.sessions = { scope: (sessionId) => world.sessionScopes.get(sessionId) };
	world.notices = notices;
	return world;
}

function loadPlugin(world, store) {
	const cleanups = [];
	const react = {
		createElement: () => null,
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect(effect) {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		}
	};
	const registered = [];
	const services = {};
	let moduleExports = null;
	const ctx = {
		sessions: world.sessions,
		slots: {
			inject(_name, factory) {
				registered.push(factory());
			},
			register(options, Component) {
				return { options, Component };
			}
		},
		get: (name) => services[name]
	};
	services.sessions = world.sessions;

	globalThis.window = {
		__ModuleLoader__: {
			load({ factory }) {
				moduleExports = factory((id) => {
					if (id === "react") return react;
					throw new Error(`unexpected require(${id})`);
				});
			}
		}
	};
	globalThis.indexedDB = fakeIndexedDB(store);
	globalThis.File = File;

	// eslint-disable-next-line no-new-func
	new Function("window", "indexedDB", source)(globalThis.window, globalThis.indexedDB);
	moduleExports.apply(ctx);
	const entry = registered[0];
	return {
		entry,
		cleanups,
		mount(sessionId) {
			const props = entry.options.inject(sessionId);
			return entry.Component(props);
		},
		unmount() {
			for (const cleanup of cleanups.splice(0)) cleanup();
		}
	};
}
//#endregion

async function scenarioRestoreAfterSwitchBack() {
	const store = new Map();
	const world = createWorld();
	world.sessionScopes.set("session-A", { get: (name) => (name === "conversation" ? world.conversation : undefined) });

	// A previously mirrored draft: two images sitting in the store.
	store.set("session-A", {
		sessionId: "session-A",
		records: [
			{ name: "one.png", type: "image/png", lastModified: 1, bytes: new TextEncoder().encode("one").buffer },
			{ name: "two.jpg", type: "image/jpeg", lastModified: 2, bytes: new TextEncoder().encode("two").buffer }
		]
	});

	const plugin = loadPlugin(world, store);
	plugin.mount("session-A");
	await settle();

	const state = world.shell.state.getSnapshot();
	check("switch back: two attachments are re-added", state.attachmentIds.length === 2, JSON.stringify(state));
	check("switch back: createDrafts received both files", world.conversation.createCalls.length === 1 && world.conversation.createCalls[0].files.length === 2);
	const files = world.conversation.createCalls[0]?.files ?? [];
	check("switch back: names/types survive the round trip", files[0]?.name === "one.png" && files[1]?.type === "image/jpeg", files.map((file) => `${file.name}:${file.type}`).join(","));
	const bytes = await files[0]?.arrayBuffer();
	check("switch back: bytes survive the round trip", bytes instanceof ArrayBuffer && new TextDecoder().decode(bytes) === "one");
	// The composer's info notice cannot be cleared once set (its store only ever
	// carries the latest entry), so a restore must not park a banner there.
	check("switch back: restore stays silent", world.notices.length === 0, JSON.stringify(world.notices));

	// Restoring must not re-restore on the very next notification.
	const before = world.conversation.createCalls.length;
	world.shell.state.set({ ...world.shell.state.getSnapshot() });
	await settle();
	check("switch back: no duplicate restore", world.conversation.createCalls.length === before);
}

async function scenarioMirrorOnAttach() {
	const store = new Map();
	const world = createWorld();
	world.sessionScopes.set("session-B", { get: (name) => (name === "conversation" ? world.conversation : undefined) });
	const plugin = loadPlugin(world, store);
	plugin.mount("session-B");
	await settle();
	check("attach: nothing mirrored while the composer is empty", store.has("session-B") === false);

	// The user pastes an image: the shell gains a live draft, then publishes.
	const draft = world.conversation.createDrafts("session-B", [new File([new Uint8Array([7, 7, 7])], "pasted.png", { type: "image/png" })])[0];
	world.shell.addAttachments([draft.id]);
	await settle();

	const row = store.get("session-B");
	check("attach: the image is mirrored", row?.records?.length === 1, JSON.stringify(row?.records?.map((record) => record.name)));
	check("attach: bytes are mirrored", new Uint8Array(row?.records?.[0]?.bytes ?? new ArrayBuffer(0)).length === 3);

	// Typing republishes the composer state on every keystroke; that must not
	// re-read the attachment bytes.
	const writes = world.conversation.resolveCalls ?? 0;
	world.shell.setDraft("hello");
	world.shell.setDraft("hello world");
	await settle();
	check("attach: typing does not re-mirror the same attachment set", (world.conversation.resolveCalls ?? 0) === writes, `resolve calls ${writes} -> ${world.conversation.resolveCalls ?? 0}`);

	// Switching away unmounts; coming back must restore the same image.
	plugin.unmount();
	world.drafts = [];
	world.shell.state.set({ draft: "", attachmentIds: [], phase: "plain" });
	const remount = loadPlugin(world, store);
	remount.mount("session-B");
	await settle();
	check("attach→switch back: the pasted image returns", world.shell.state.getSnapshot().attachmentIds.length === 1);
	check("attach→switch back: the restore does not park a notice", world.notices.length === 0);
}

async function scenarioSendOrRemoveClears() {
	const store = new Map();
	const world = createWorld();
	world.sessionScopes.set("session-C", { get: (name) => (name === "conversation" ? world.conversation : undefined) });
	const plugin = loadPlugin(world, store);
	plugin.mount("session-C");
	await settle();

	const draft = world.conversation.createDrafts("session-C", [new File([new Uint8Array([1])], "gone.png", { type: "image/png" })])[0];
	world.shell.addAttachments([draft.id]);
	await settle();
	check("clear: mirrored before the send", store.get("session-C")?.records?.length === 1);

	// Submit: the shell commits the send and drops the ids.
	world.shell.state.set({ ...world.shell.state.getSnapshot(), attachmentIds: [] });
	await settle();
	check("clear: a sent/removed image is forgotten", store.has("session-C") === false, JSON.stringify([...store.keys()]));

	// Coming back must therefore restore nothing.
	plugin.unmount();
	const remount = loadPlugin(world, store);
	remount.mount("session-C");
	await settle();
	check("clear: nothing comes back after a send", world.shell.state.getSnapshot().attachmentIds.length === 0);
}

async function scenarioBusyComposerRetries() {
	const store = new Map();
	const world = createWorld();
	world.sessionScopes.set("session-D", { get: (name) => (name === "conversation" ? world.conversation : undefined) });
	store.set("session-D", { sessionId: "session-D", records: [{ name: "wait.png", type: "image/png", lastModified: 3, bytes: new ArrayBuffer(4) }] });
	world.shell.state.set({ draft: "", attachmentIds: [], phase: "adjudicating" });

	const plugin = loadPlugin(world, store);
	plugin.mount("session-D");
	await settle();
	check("busy: no restore while the composer is adjudicating", world.shell.state.getSnapshot().attachmentIds.length === 0);

	world.shell.state.set({ ...world.shell.state.getSnapshot(), phase: "plain" });
	await settle();
	check("busy: restores once the composer is plain", world.shell.state.getSnapshot().attachmentIds.length === 1);
}

async function scenarioFileKindIgnored() {
	const store = new Map();
	const world = createWorld();
	world.sessionScopes.set("session-E", { get: (name) => (name === "conversation" ? world.conversation : undefined) });
	const plugin = loadPlugin(world, store);
	plugin.mount("session-E");
	await settle();

	const fileDraft = { kind: "file", id: "file-1", file: new File([new Uint8Array([9])], "doc.pdf", { type: "application/pdf" }) };
	world.drafts.push(fileDraft);
	world.shell.addAttachments([fileDraft.id]);
	await settle();
	check("file-kind: a document draft is not mirrored", store.has("session-E") === false);
}

const scenarios = [
	["restore after switching back", scenarioRestoreAfterSwitchBack],
	["mirror on attach", scenarioMirrorOnAttach],
	["send/remove clears", scenarioSendOrRemoveClears],
	["busy composer retries", scenarioBusyComposerRetries],
	["file-kind ignored", scenarioFileKindIgnored]
];

for (const [label, run] of scenarios) {
	try {
		await run();
	} catch (cause) {
		failures += 1;
		checks.push({ label, ok: false, detail: `threw: ${cause?.stack ?? cause}` });
	}
}

for (const { label, ok, detail } of checks) {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `  — ${detail}`}`);
}
console.log(`\n${checks.filter((entry) => entry.ok).length}/${checks.length} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
