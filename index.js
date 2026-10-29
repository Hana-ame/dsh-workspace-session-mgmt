import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROBE = "/tmp/wal-steps.log";
/** @param text - marker written before/after each phase so failures are traceable. */
function probe(text) {
	try {
		appendFileSync(PROBE, `${Date.now()} ${text}\n`);
	} catch {}
}
probe("module-eval");

/**
 * Live Workspace session management.
 *
 * The Workspace registry keeps `archivedSessionIds` and `pinnedSessionIds` in
 * process memory and only reads the persisted `workspace.json` document at
 * startup. A direct edit to that file is therefore invisible to the GUI
 * sidebar, which is rendered from the in-memory set, and the next registry
 * mutation overwrites the file with the in-memory state. Routing a change
 * through the registry is the only path that is both live and durable: the
 * durable write happens and the `follow` stream pushes the new set to
 * connected clients immediately.
 *
 * This bundle imports nothing outside `node:` so it resolves from any location
 * a bundle may be installed from, not only from inside the Harness install.
 *
 * @module dsh-workspace-session-mgmt
 */
const name = "workspace-archive-live";

/** Services this plugin needs; it stays inactive in profiles without them. */
const inject = ["tools", "workspaceRegistry"];

/** Ceiling on a requested deferral so a caller cannot postpone indefinitely. */
const MAX_DEFER_MS = 120000;
/** Persisted workspace document used when the configured path is unreadable. */
const FALLBACK_STORAGE_PATH = join(homedir(), ".dsh", "storages", "workspace.json");

/** Deployment defaults, merged over the raw row config. */
const DEFAULTS = {
	storagePath: join(homedir(), ".dsh", "storages", "workspace.json"),
	reconcileDisk: true,
	reconcileIntervalMs: 2500,
	reconcileStopActivity: true
};

/** Annotation-only output schema: an unconstrained JSON object. */
const OUTPUT_SCHEMA = { type: "object", additionalProperties: true };

/** Resolve the DeepSeek Harness home directory, honouring `$DSH_HOME`. */
function harnessHome() {
	const raw = process.env.DSH_HOME;
	if (raw === void 0 || raw.trim().length === 0) return join(homedir(), ".dsh");
	if (raw === "~") return resolve(homedir());
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return resolve(join(homedir(), raw.slice(2)));
	return resolve(raw);
}

/**
 * Merge the raw row config over the defaults, dropping keys with values that
 * cannot be used rather than failing plugin activation.
 */
function readConfig(config) {
	const row = config !== null && typeof config === "object" ? config : {};
	const result = { ...DEFAULTS, ...row };
	if (typeof result.storagePath !== "string" || result.storagePath.length === 0) result.storagePath = DEFAULTS.storagePath;
	if (typeof result.reconcileDisk !== "boolean") result.reconcileDisk = DEFAULTS.reconcileDisk;
	if (!Number.isInteger(result.reconcileIntervalMs) || result.reconcileIntervalMs < 500) result.reconcileIntervalMs = DEFAULTS.reconcileIntervalMs;
	else if (result.reconcileIntervalMs > 60000) result.reconcileIntervalMs = 60000;
	if (typeof result.reconcileStopActivity !== "boolean") result.reconcileStopActivity = DEFAULTS.reconcileStopActivity;
	return result;
}

/** Keep only non-empty string entries, ignoring malformed persisted data. */
function stringList(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}

/** Read the persisted workspace document, falling back to the default location. */
async function readPersistedState(config) {
	const candidates = [config.storagePath];
	if (config.storagePath !== FALLBACK_STORAGE_PATH) candidates.push(FALLBACK_STORAGE_PATH);
	let lastError;
	for (const path of candidates) {
		try {
			const doc = JSON.parse(await readFile(path, "utf8"));
			const global = doc !== null && typeof doc === "object" ? doc.global ?? {} : {};
			return {
				ok: true,
				path,
				archivedSessionIds: stringList(global.archivedSessionIds),
				pinnedSessionIds: stringList(global.pinnedSessionIds),
				workspaceIds: stringList(global.workspaceIds)
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		ok: false,
		path: candidates[0],
		error: lastError,
		archivedSessionIds: [],
		pinnedSessionIds: [],
		workspaceIds: []
	};
}

/** Snapshot of the running registry's archive set, pin set and membership. */
function registryState(registry) {
	return {
		archivedSessionIds: stringList(registry.archivedSessionIds).map(String),
		pinnedSessionIds: stringList(registry.pinnedSessionIds).map(String),
		workspaces: registry.list().map((workspace) => ({
			workspaceId: String(workspace.workspaceId),
			path: workspace.path,
			title: typeof workspace.title === "string" ? workspace.title : "",
			sessionIds: stringList(workspace.sessionIds).map(String)
		}))
	};
}

/** Two-way set difference between the live registry and the persisted file. */
function divergence(live, disk) {
	const compare = (registrySet, persistedSet) => ({
		onlyInRegistry: registrySet.filter((id) => !persistedSet.includes(id)),
		onlyInDisk: persistedSet.filter((id) => !registrySet.includes(id))
	});
	return {
		archivedSessionIds: compare(live.archivedSessionIds, disk.archivedSessionIds),
		pinnedSessionIds: compare(live.pinnedSessionIds, disk.pinnedSessionIds)
	};
}

/** Report one session's activity families, exactly as the registry would see them. */
async function sessionActivity(ctx, sessionId) {
	try {
		const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => []);
		if (!Array.isArray(activity)) return [];
		return activity.map((entry) => ({
			kind: typeof entry?.kind === "string" ? entry.kind : "unknown",
			items: Array.isArray(entry?.items) ? [...entry.items] : []
		}));
	} catch {
		return [];
	}
}

function jsonRender(value) {
	return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function requireSessionId(value) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("`sessionId` must be a non-empty string");
	return value;
}

/**
 * Compile a per-property parameter map into the JSON Schema the tool registry
 * consumes. A property marked `required` is added to the `required` list.
 */
function parameters(spec) {
	const properties = {};
	const required = [];
	for (const [key, value] of Object.entries(spec)) {
		properties[key] = {
			type: value.type,
			...value.description !== void 0 ? { description: value.description } : {}
		};
		if (value.required === true) required.push(key);
	}
	return { type: "object", properties, ...required.length > 0 ? { required } : {} };
}

/** Build a registry-ready tool definition with JSON object output. */
function tool(toolName, description, spec, execute) {
	return {
		name: toolName,
		description,
		parameters: parameters(spec),
		output: { schema: OUTPUT_SCHEMA, render: (_args, value) => jsonRender(value) },
		execute
	};
}

/**
 * Register the live workspace tools and, when enabled, a poller that pulls
 * external edits to the persisted document into the running registry.
 * @param ctx - registrant context carrying the tool registry and Workspace registry.
 * @param config - raw row config, as written in the composition patch.
 */
function apply(ctx, config) {
	probe("apply-begin");
	try {
		return applyInner(ctx, config);
	} catch (error) {
		probe(`apply-ERROR ${error instanceof Error ? error.stack : String(error)}`);
		throw error;
	}
}

/** The actual plugin body; its start/finish markers show how far execution got. */
function applyInner(ctx, config) {
	probe("apply-inner-begin");
	const settings = readConfig(config);
	const registry = ctx.workspaceRegistry;
	probe(`apply-inner ctx=${typeof ctx.tools}/${typeof ctx.effect}/${typeof ctx.waterfall}/${typeof registry}`);
	/** Deferred archive timers, so plugin teardown can cancel a pending write. */
	const pending = new Set();

	async function performArchive(sessionId, stopActivity) {
		await registry.archiveSession(sessionId, { stopActivity });
		const state = registryState(registry);
		return {
			status: "archived",
			sessionId,
			archivedSessionIds: state.archivedSessionIds,
			pinnedSessionIds: state.pinnedSessionIds
		};
	}

	ctx.tools.register(tool(
		"workspace_state",
		"Read the Workspace registry that the GUI sidebar is rendered from. Returns the running registry's live in-memory archivedSessionIds and pinnedSessionIds and each workspace's session membership, and optionally compares them against the persisted workspace.json document to show the divergence between the process cache and disk. Use this to determine whether a session is archived in the process cache (hidden from the sidebar) or only on disk (still shown).",
		{
			includeDisk: {
				type: "boolean",
				description: "Also read the persisted workspace.json document and report the divergence. Default true."
			}
		},
		async (args) => {
			const live = registryState(registry);
			const result = { registry: live };
			if (args.includeDisk !== false) {
				const disk = await readPersistedState(settings);
				result.disk = disk;
				if (disk.ok) result.divergence = divergence(live, disk);
			}
			return result;
		}
	));

	ctx.tools.register(tool(
		"workspace_archive_session",
		"Archive a session through the running Workspace registry, so the GUI sidebar hides it immediately and the change persists. A direct edit to workspace.json is ignored by the running registry and overwritten by the next registry write, so this is the only live path. An active session is refused unless stopActivity is set, which stops its running work instead; when archiving the session that is currently running this tool, pass deferMs so the tool returns first, the turn finishes, and the archive lands after it without cancelling it. Never pass deferMs and expect an in-turn confirmation - the archive write happens after the deferral elapses.",
		{
			sessionId: { type: "string", required: true, description: "Session id to archive, for example `session-...`." },
			stopActivity: {
				type: "boolean",
				description: "Stop the session's running work (turn, subagent, job, reminder) and archive anyway instead of refusing. Default false."
			},
			deferMs: {
				type: "number",
				description: "Delay the archive write by this many milliseconds and return immediately. Bounded to 120000. Use when archiving the session running this tool so that turn can finish first. Default 0."
			}
		},
		async (args) => {
			const sessionId = requireSessionId(args.sessionId);
			const stopActivity = args.stopActivity === true;
			const deferMs = Number.isFinite(args.deferMs) && args.deferMs > 0
				? Math.min(Math.floor(args.deferMs), MAX_DEFER_MS)
				: 0;
			if (deferMs > 0) {
				const handle = setTimeout(() => {
					pending.delete(handle);
					performArchive(sessionId, stopActivity).catch((error) => {
						ctx.logger.error(error, { tool: "workspace_archive_session", sessionId, deferred: true });
					});
				}, deferMs);
				pending.add(handle);
				return { status: "scheduled", sessionId, deferMs, stopActivity };
			}
			try {
				return await performArchive(sessionId, stopActivity);
			} catch (error) {
				return {
					status: "refused",
					sessionId,
					reason: error instanceof Error ? error.message : String(error),
					activity: stopActivity ? [] : await sessionActivity(ctx, sessionId)
				};
			}
		}
	));

	ctx.tools.register(tool(
		"workspace_unarchive_session",
		"Move a session back out of the archive so the GUI sidebar shows it again. Idempotent: an id that is not archived resolves without writing. Does not require the session to still exist, and preserves its position within its workspace.",
		{
			sessionId: { type: "string", required: true, description: "Session id to unarchive." }
		},
		async (args) => {
			const sessionId = requireSessionId(args.sessionId);
			await registry.unarchiveSession(sessionId);
			const state = registryState(registry);
			return { status: "unarchived", sessionId, archivedSessionIds: state.archivedSessionIds };
		}
	));

	ctx.tools.register(tool(
		"workspace_pin_session",
		"Pin a session so it leads the GUI sidebar. Requires the session to be known to persistence or to be live, and refuses a session that is archived. Idempotent for an id that is already pinned.",
		{
			sessionId: { type: "string", required: true, description: "Session id to pin." }
		},
		async (args) => {
			const sessionId = requireSessionId(args.sessionId);
			try {
				await registry.pinSession(sessionId);
			} catch (error) {
				return { status: "refused", sessionId, reason: error instanceof Error ? error.message : String(error) };
			}
			const state = registryState(registry);
			return { status: "pinned", sessionId, pinnedSessionIds: state.pinnedSessionIds };
		}
	));

	ctx.tools.register(tool(
		"workspace_unpin_session",
		"Unpin a session so it falls back to its durable registry position in the GUI sidebar. Idempotent: an id that is not pinned resolves without writing or reordering.",
		{
			sessionId: { type: "string", required: true, description: "Session id to unpin." }
		},
		async (args) => {
			const sessionId = requireSessionId(args.sessionId);
			await registry.unpinSession(sessionId);
			const state = registryState(registry);
			return { status: "unpinned", sessionId, pinnedSessionIds: state.pinnedSessionIds };
		}
	));

	/**
	 * Pull the persisted archive set into the running registry. Both sides are
	 * re-read on every pass because the registry and the file have independent
	 * write queues; when they agree nothing is written.
	 */
	let running = false;
	async function reconcile() {
		if (running) return;
		running = true;
		try {
			const disk = await readPersistedState(settings);
			if (!disk.ok) {
				ctx.logger.warn(`workspace-archive-live: cannot read persisted workspace document at ${disk.path}: ${disk.error}`);
				return;
			}
			const live = registryState(registry);
			const onDisk = new Set(disk.archivedSessionIds);
			const inMemory = new Set(live.archivedSessionIds);
			for (const sessionId of onDisk) {
				if (inMemory.has(sessionId)) continue;
				try {
					await registry.archiveSession(sessionId, { stopActivity: settings.reconcileStopActivity });
				} catch (error) {
					ctx.logger.warn(`workspace-archive-live: reconciliation could not archive ${sessionId}: ${String(error instanceof Error ? error.message : error)}`);
				}
			}
			for (const sessionId of inMemory) {
				if (onDisk.has(sessionId)) continue;
				try {
					await registry.unarchiveSession(sessionId);
				} catch (error) {
					ctx.logger.warn(`workspace-archive-live: reconciliation could not unarchive ${sessionId}: ${String(error instanceof Error ? error.message : error)}`);
				}
			}
		} catch (error) {
			ctx.logger.error(error, { plugin: name });
		} finally {
			running = false;
		}
	}

	ctx.effect(() => {
		if (settings.reconcileDisk === false) {
			return () => {
				for (const handle of pending) clearTimeout(handle);
				pending.clear();
			};
		}
		void reconcile();
		const poller = setInterval(() => void reconcile(), settings.reconcileIntervalMs);
		return () => {
			clearInterval(poller);
			for (const handle of pending) clearTimeout(handle);
			pending.clear();
		};
	});
}

export { apply, inject, name };
