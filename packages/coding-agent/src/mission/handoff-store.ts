import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MissionFileService } from "./file-service";
import type { WorkerHandoff } from "./types";

/**
 * One durable record under `<missionDir>/handoffs/`. The directory is created by
 * `MissionFileService.initMissionDir` but nothing ever wrote into it, so handoffs
 * only existed inside `progress_log.jsonl` and were unreachable without replaying
 * the whole log.
 */
export interface PersistedHandoff {
	/** Feature this handoff belongs to. */
	featureId: string;
	/** Handoff exactly as the worker produced it, failures included. */
	handoff: WorkerHandoff;
	/** Marker so a reader can tell a stored artifact from a bare `WorkerHandoff`. */
	kind: "worker-handoff";
	/** When the record was persisted, independent of any handoff-listed timestamp. */
	persistedAt: string;
}

/** Longest feature id kept verbatim in a file name before the digest suffix takes over. */
const MAX_SLUG_LENGTH = 48;

/** Digest width appended to a slug when the feature id was truncated. */
const DIGEST_LENGTH = 8;

/**
 * Stable file stem for a feature id. Mirrors `sanitizeIdbName`
 * (`src/ida/store.ts:207-210`): keep `[A-Za-z0-9._-]`, cap the length, and append a
 * hash of the original id whenever sanitizing changed anything. The digest is
 * what stops two distinct features from resolving to the same file: `feature/one`
 * and `feature_one` sanitize identically, and `__f1__` trims to `f1`, so without
 * the digest one feature's handoff silently overwrites the other's.
 */
export function handoffSlug(featureId: string): string {
	const sanitized = featureId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+|[._-]+$/g, "");
	if (sanitized === featureId && sanitized.length <= MAX_SLUG_LENGTH) return featureId;
	const digest = Bun.hash(featureId).toString(36).slice(0, DIGEST_LENGTH);
	const stem = sanitized.slice(0, MAX_SLUG_LENGTH - DIGEST_LENGTH - 1).replace(/[._-]+$/g, "");
	return `${stem.length > 0 ? stem : "handoff"}-${digest}`;
}

/**
 * The one file a feature's handoff lives in: `<missionDir>/handoffs/<slug>.json`.
 *
 * Exported because the naming is the durable contract — it is what makes a
 * feature's handoff addressable without scanning `progress_log.jsonl`, and tests
 * assert the path directly. One file per feature, so the newest handoff for a
 * feature is always the file's contents.
 */
export function handoffPath(missionDir: string, featureId: string): string {
	return path.join(missionDir, "handoffs", `${handoffSlug(featureId)}.json`);
}

/**
 * Persist one feature's handoff into `<missionDir>/handoffs`, pretty-printed like
 * the other mission state files (`features.json`, `validation-state.json`) and
 * written through a temp file so a crash mid-write cannot truncate an earlier
 * handoff. A synthesized failure handoff is persisted unchanged — its `lastError`
 * is the point of the record, so it is never rewritten into a success.
 */
export async function writeHandoff(missionDir: string, handoff: WorkerHandoff, featureId: string): Promise<void> {
	const filePath = handoffPath(missionDir, featureId);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const record: PersistedHandoff = {
		kind: "worker-handoff",
		featureId,
		handoff,
		persistedAt: new Date().toISOString(),
	};
	const tmp = `${filePath}.tmp`;
	await Bun.write(tmp, JSON.stringify(record, null, 2) + "\n");
	await fs.rename(tmp, filePath);
}

/**
 * Read one feature's handoff off disk.
 *
 * Before this store existed a mission recorded handoffs only in the progress log,
 * so a mission directory that predates it has no file. Rather than a second way to
 * read the same thing, that case falls back to `filterWorkerHandoffs()` — the
 * read pattern `progress-log.ts` already uses — and takes the last entry for the
 * feature, which is the append-order equivalent of this file's contents.
 */
export async function readLatestHandoff(
	svc: MissionFileService,
	featureId: string,
): Promise<WorkerHandoff | undefined> {
	try {
		const record = JSON.parse(await Bun.file(handoffPath(svc.missionDir(), featureId)).text()) as PersistedHandoff;
		if (record?.kind === "worker-handoff" && record.featureId === featureId) return record.handoff;
	} catch {
		// No durable file yet: the mission predates the store, or the write never
		// landed. Fall through to the progress log rather than reporting no handoff.
	}
	const entries = await svc.filterWorkerHandoffs();
	const matching = entries.filter(entry => entry.featureId === featureId);
	return matching[matching.length - 1]?.handoff;
}
