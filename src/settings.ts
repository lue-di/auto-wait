import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const USAGE_SETTINGS_FILE = "pi-usage.json";
export const MAX_USAGE_SETTINGS_BYTES = 64 * 1024;

export interface UsageSettings {
	codexFastMode: boolean;
	codexAutoWait5h: boolean;
}

export const DEFAULT_USAGE_SETTINGS: Readonly<UsageSettings> = Object.freeze({
	codexFastMode: false,
	codexAutoWait5h: false,
});

export interface UsageSettingsState {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	settings: UsageSettings;
	document?: Record<string, unknown>;
	issue?: string;
}

export interface UsageSettingsRuntime {
	get(): Readonly<UsageSettingsState>;
	reload(signal?: AbortSignal): Promise<Readonly<UsageSettingsState>>;
	update(
		patch: Partial<UsageSettings>,
		signal?: AbortSignal,
	): Promise<Readonly<UsageSettingsState>>;
	flush(): Promise<void>;
}

interface UsageSettingsFileOperations {
	rename: typeof rename;
	writeFile: typeof writeFile;
}

interface UsageSettingsRuntimeOptions {
	operations?: Partial<UsageSettingsFileOperations>;
	path?: string;
}

export function usageSettingsPath(): string {
	return join(getAgentDir(), USAGE_SETTINGS_FILE);
}

export function normalizeUsageSettings(
	value: unknown,
): UsageSettings | undefined {
	if (!isRecord(value)) return undefined;
	if (
		Object.hasOwn(value, "codexFastMode") &&
		typeof value.codexFastMode !== "boolean"
	) {
		return undefined;
	}
	if (
		Object.hasOwn(value, "codexAutoWait5h") &&
		typeof value.codexAutoWait5h !== "boolean"
	) {
		return undefined;
	}
	return {
		codexFastMode:
			typeof value.codexFastMode === "boolean"
				? value.codexFastMode
				: DEFAULT_USAGE_SETTINGS.codexFastMode,
		codexAutoWait5h:
			typeof value.codexAutoWait5h === "boolean"
				? value.codexAutoWait5h
				: DEFAULT_USAGE_SETTINGS.codexAutoWait5h,
	};
}

export async function loadUsageSettings(
	path = usageSettingsPath(),
	signal?: AbortSignal,
): Promise<UsageSettingsState> {
	throwIfAborted(signal);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let text: string;
		try {
			const stats = await handle.stat();
			throwIfAborted(signal);
			if (!stats.isFile())
				throw new Error("settings path is not a regular file");
			if (stats.size > MAX_USAGE_SETTINGS_BYTES) {
				throw new Error("settings file exceeds 64 KiB");
			}
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		throwIfAborted(signal);
		const document = JSON.parse(text) as unknown;
		const settings = normalizeUsageSettings(document);
		if (!settings || !isRecord(document))
			throw new Error("invalid settings shape");
		return { kind: "loaded", path, settings, document };
	} catch (error) {
		if (signal?.aborted) throw error;
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				settings: { ...DEFAULT_USAGE_SETTINGS },
				document: {},
			};
		}
		return {
			kind: "invalid",
			path,
			settings: { ...DEFAULT_USAGE_SETTINGS },
			issue:
				isNodeError(error) && error.code === "ELOOP"
					? "symbolic links are not accepted"
					: error instanceof Error
						? error.message
						: String(error),
		};
	}
}

export function createUsageSettingsRuntime(
	options: UsageSettingsRuntimeOptions | string = {},
): UsageSettingsRuntime {
	const path =
		typeof options === "string"
			? options
			: (options.path ?? usageSettingsPath());
	const operations: UsageSettingsFileOperations = {
		rename,
		writeFile,
		...(typeof options === "string" ? undefined : options.operations),
	};
	let state: UsageSettingsState = {
		kind: "missing",
		path,
		settings: { ...DEFAULT_USAGE_SETTINGS },
		document: {},
	};
	let queue = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = queue.then(operation, operation);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return {
		get: () => structuredClone(state),
		reload: (signal) =>
			enqueue(async () => {
				const loaded = await loadUsageSettings(path, signal);
				state = loaded;
				return structuredClone(state);
			}),
		update: (patch, signal) =>
			enqueue(async () => {
				const saved = await saveUsageSettingsPatch(
					path,
					patch,
					operations,
					signal,
				);
				state = saved;
				return structuredClone(state);
			}),
		flush: () => queue,
	};
}

async function saveUsageSettingsPatch(
	path: string,
	patch: Partial<UsageSettings>,
	operations: UsageSettingsFileOperations,
	signal?: AbortSignal,
): Promise<UsageSettingsState> {
	const latest = await loadUsageSettings(path, signal);
	if (latest.kind === "invalid") {
		throw new Error(
			"Cannot overwrite an invalid pi-usage.json; repair it and reload first",
		);
	}
	const document = { ...latest.document, ...patch };
	const settings = normalizeUsageSettings(document);
	if (!settings) throw new Error("Refusing to save invalid pi-usage settings");
	const directory = dirname(path);
	const temporaryPath = join(
		directory,
		`.${basename(path)}.${randomUUID()}.tmp`,
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	throwIfAborted(signal);
	try {
		await operations.writeFile(
			temporaryPath,
			`${JSON.stringify(document, null, 2)}\n`,
			{
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			},
		);
		if (process.platform !== "win32") await chmodPrivate(temporaryPath);
		throwIfAborted(signal);
		const current = await loadUsageSettings(path, signal);
		if (
			current.kind === "invalid" ||
			current.kind !== latest.kind ||
			JSON.stringify(current.document) !== JSON.stringify(latest.document)
		) {
			throw new Error("pi-usage.json changed while saving; retry the action");
		}
		throwIfAborted(signal);
		await operations.rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
	return { kind: "loaded", path, settings, document };
}

async function chmodPrivate(path: string): Promise<void> {
	await chmod(path, 0o600);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw new DOMException("Settings operation aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
