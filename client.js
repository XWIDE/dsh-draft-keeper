window.__ModuleLoader__.load({
	id: "dsh-draft-keeper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const name = "draft-keeper";
		const CHANNEL = "[draft-keeper]";
		const DB_NAME = "dsh-draft-keeper";
		const DB_VERSION = 1;
		const TABLE = "drafts";
		const MAX_IMAGES_PER_SESSION = 12;
		const MAX_BYTES_PER_SESSION = 32 * 1024 * 1024;
		const MAX_RESTORE_ATTEMPTS = 6;

		const debug = (...args) => {
			try { console.info(CHANNEL, ...args); } catch { /* console unavailable */ }
		};
		const warn = (...args) => {
			try { console.warn(CHANNEL, ...args); } catch { /* console unavailable */ }
		};

		//#region persistence — mirrored bytes, keyed by sessionId
		/** In-page cache: sessionId -> record[]. Beats IndexedDB on every switch. */
		const memory = new Map();
		/** Per-session task chain, so a capture never overtakes an earlier one. */
		const chains = new Map();
		let dbPromise;

		function enqueue(sessionId, task) {
			const previous = chains.get(sessionId) ?? Promise.resolve();
			const next = previous.then(task, task).catch((cause) => {
				warn("task failed", cause);
				return 0;
			});
			chains.set(sessionId, next);
			return next;
		}

		function openDb() {
			if (dbPromise !== undefined) return dbPromise;
			dbPromise = new Promise((resolve) => {
				if (typeof indexedDB === "undefined" || indexedDB === null) {
					resolve(null);
					return;
				}
				let request;
				try {
					request = indexedDB.open(DB_NAME, DB_VERSION);
				} catch (cause) {
					warn("indexedDB.open failed", cause);
					resolve(null);
					return;
				}
				request.onupgradeneeded = () => {
					const db = request.result;
					if (!db.objectStoreNames.contains(TABLE)) db.createObjectStore(TABLE, { keyPath: "sessionId" });
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => resolve(null);
				request.onblocked = () => resolve(null);
			});
			return dbPromise;
		}

		async function readRow(sessionId) {
			const db = await openDb();
			if (db === null) return undefined;
			return new Promise((resolve) => {
				let request;
				try {
					request = db.transaction(TABLE, "readonly").objectStore(TABLE).get(sessionId);
				} catch (cause) {
					warn("read failed", cause);
					resolve(undefined);
					return;
				}
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => resolve(undefined);
			});
		}

		async function writeRow(sessionId, records) {
			const db = await openDb();
			if (db === null) return;
			await new Promise((resolve) => {
				let tx;
				try {
					tx = db.transaction(TABLE, "readwrite");
					tx.objectStore(TABLE).put({ sessionId, records, updatedAt: Date.now() });
				} catch (cause) {
					warn("write failed", cause);
					resolve();
					return;
				}
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			});
		}

		async function dropRow(sessionId) {
			const db = await openDb();
			if (db === null) return;
			await new Promise((resolve) => {
				let tx;
				try {
					tx = db.transaction(TABLE, "readwrite");
					tx.objectStore(TABLE).delete(sessionId);
				} catch (cause) {
					warn("drop failed", cause);
					resolve();
					return;
				}
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
				tx.onabort = () => resolve();
			});
		}

		async function loadRecords(sessionId) {
			const cached = memory.get(sessionId);
			if (Array.isArray(cached) && cached.length > 0) return cached;
			const row = await readRow(sessionId);
			const records = row !== null && row !== undefined && Array.isArray(row.records) ? row.records : [];
			if (records.length > 0) memory.set(sessionId, records);
			return records;
		}
		//#endregion

		//#region mirror + restore
		function fileNameOf(file) {
			return typeof file.name === "string" && file.name !== "" ? file.name : "image.png";
		}

		function fileTypeOf(file) {
			return typeof file.type === "string" && file.type !== "" ? file.type : "image/png";
		}

		/**
		 * Read the live composer attachments and mirror every image into the store.
		 * Only `kind === "image"` drafts are kept: a file-kind draft re-entering
		 * `createDrafts` would restart a host upload.
		 */
		function captureInto(keeper, handles, ids) {
			return enqueue(keeper.sessionId, async () => {
				if (!Array.isArray(ids) || ids.length === 0) return 0;
				let live = [];
				try {
					live = handles.conversation.resolveDraftAttachments(ids) ?? [];
				} catch (cause) {
					warn("resolveDraftAttachments failed", cause);
					return 0;
				}
				const records = [];
				let total = 0;
				for (const attachment of live) {
					if (attachment === null || attachment === undefined) continue;
					if (attachment.kind !== "image") continue;
					const file = attachment.file;
					if (file === null || file === undefined || typeof file.arrayBuffer !== "function") continue;
					if (records.length >= MAX_IMAGES_PER_SESSION) break;
					let bytes;
					try {
						bytes = await file.arrayBuffer();
					} catch {
						continue;
					}
					if (bytes.byteLength === 0) continue;
					if (total + bytes.byteLength > MAX_BYTES_PER_SESSION) break;
					total += bytes.byteLength;
					records.push({
						name: fileNameOf(file),
						type: fileTypeOf(file),
						lastModified: typeof file.lastModified === "number" ? file.lastModified : Date.now(),
						bytes
					});
				}
				memory.set(keeper.sessionId, records);
				if (records.length === 0) await dropRow(keeper.sessionId);
				else await writeRow(keeper.sessionId, records);
				debug("mirrored", keeper.sessionId, records.length, "image(s)");
				return records.length;
			});
		}

		/**
		 * Put the mirrored images back into the composer through the official
		 * draft channel, so the next submit sends ordinary attachments.
		 */
		function restoreInto(keeper, handles) {
			return enqueue(keeper.sessionId, async () => {
				const records = await loadRecords(keeper.sessionId);
				if (records.length === 0) return 0;
				let state;
				try {
					state = handles.input.state.getSnapshot();
				} catch (cause) {
					warn("state read failed", cause);
					return 0;
				}
				if (state.phase !== "plain") return 0;
				const ids = Array.isArray(state.attachmentIds) ? state.attachmentIds : [];
				if (ids.length > 0) return 0;
				let created;
				try {
					const files = records.map((record) => new File([record.bytes], record.name, {
						type: record.type,
						lastModified: record.lastModified
					}));
					created = handles.conversation.createDrafts(keeper.sessionId, files);
				} catch (cause) {
					warn("createDrafts failed", cause);
					return 0;
				}
				if (!Array.isArray(created) || created.length === 0) return 0;
				let accepted = false;
				try {
					accepted = handles.input.addAttachments(created.map((draft) => draft.id)) === true;
				} catch (cause) {
					warn("addAttachments failed", cause);
					accepted = false;
				}
				if (!accepted) {
					try {
						handles.conversation.releaseDraftAttachments(created);
					} catch { /* nothing else to do */ }
					return 0;
				}
				debug("restored", keeper.sessionId, created.length, "image(s)");
				return created.length;
			});
		}

		function forget(keeper) {
			memory.set(keeper.sessionId, []);
			return enqueue(keeper.sessionId, () => dropRow(keeper.sessionId));
		}
		//#endregion

		//#region keeper registry
		const keepers = new Map();

		function keeperFor(sessionId, ctx) {
			const existing = keepers.get(sessionId);
			if (existing !== undefined) return existing;
			const keeper = {
				sessionId,
				/** Resolve the live composer shell for this session, if it has one. */
				handles() {
					let sessions;
					try {
						sessions = ctx.sessions;
					} catch {
						sessions = undefined;
					}
					if (sessions === undefined || sessions === null) {
						try {
							sessions = ctx.get("sessions");
						} catch {
							sessions = undefined;
						}
					}
					if (sessions === undefined || sessions === null) return null;
					let actx;
					try {
						actx = sessions.scope(sessionId);
					} catch {
						return null;
					}
					if (actx === undefined || actx === null) return null;
					let conversation;
					try {
						conversation = actx.get("conversation");
					} catch {
						conversation = undefined;
					}
					if (conversation === undefined || conversation === null) return null;
					if (conversation.input === undefined || conversation.input === null) return null;
					if (typeof conversation.input.for !== "function") return null;
					let input;
					try {
						input = conversation.input.for(actx);
					} catch {
						return null;
					}
					if (input === undefined || input === null || input.state === undefined) return null;
					return { conversation, input };
				},
				capture(handles, ids) {
					// Every keystroke republishes the composer state; only a changed
					// attachment set is worth re-reading bytes for.
					const signature = Array.isArray(ids) ? ids.join("|") : "";
					if (signature !== "" && signature === this.lastMirror) return 0;
					this.lastMirror = signature;
					return captureInto(this, handles, ids);
				},
				restore(handles) {
					return restoreInto(this, handles);
				},
				forget() {
					this.lastMirror = "";
					return forget(this);
				}
			};
			keepers.set(sessionId, keeper);
			return keeper;
		}
		//#endregion

		//#region dock component
		/**
		 * Headless dock child: its mount is the composer's own lifetime signal, its
		 * props carry the injected keeper handle for this session.
		 */
		function DraftKeeper(props) {
			const keeper = props !== null && props !== undefined && props.keeper !== undefined ? props.keeper : props;
			const usable = keeper !== null && keeper !== undefined && typeof keeper.handles === "function" && typeof keeper.restore === "function";

			React.useEffect(() => {
				if (!usable) {
					warn("dock props carried no keeper handle", props);
					return undefined;
				}
				let cancelled = false;
				let unsubscribe;
				let lastIds = null;
				let satisfied = false;
				let attempts = 0;
				let handles;
				try {
					handles = keeper.handles();
				} catch (cause) {
					warn("handles failed", cause);
					return undefined;
				}
				if (handles === null) {
					warn("no live composer for session", keeper.sessionId);
					return undefined;
				}
				const runRestore = () => {
					if (cancelled || satisfied || attempts >= MAX_RESTORE_ATTEMPTS) return;
					attempts += 1;
					Promise.resolve(keeper.restore(handles)).then((count) => {
						if (cancelled || !(count > 0)) return;
						satisfied = true;
					}).catch((cause) => {
						warn("restore failed", cause);
					});
				};
				const sync = () => {
					if (cancelled) return;
					let state;
					try {
						state = handles.input.state.getSnapshot();
					} catch {
						return;
					}
					const ids = Array.isArray(state.attachmentIds) ? state.attachmentIds : [];
					const had = lastIds !== null && lastIds.length > 0;
					lastIds = ids;
					if (ids.length > 0) {
						satisfied = true;
						Promise.resolve(keeper.capture(handles, ids)).catch(() => {});
						return;
					}
					if (had) {
						// Observed live attachments go to zero: the message was sent,
						// or the user removed them. Either way they must not come back.
						satisfied = true;
						Promise.resolve(keeper.forget()).catch(() => {});
						return;
					}
					runRestore();
				};
				try {
					unsubscribe = handles.input.state.subscribe(sync);
				} catch (cause) {
					warn("subscribe failed", cause);
				}
				sync();
				return () => {
					cancelled = true;
					if (unsubscribe !== undefined) {
						try {
							unsubscribe();
						} catch { /* already gone */ }
					}
				};
			}, [keeper, usable]);

			return null;
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: name,
				order: 30,
				inject: (sessionId) => ({ keeper: keeperFor(String(sessionId), ctx) })
			}, DraftKeeper));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = ["slots", "sessions"];
		exports.name = name;
		return module.exports;
	}
});
