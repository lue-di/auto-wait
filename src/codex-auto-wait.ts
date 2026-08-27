import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findCodex5hBucket } from "./format.js";
import type { UsageSettingsRuntime } from "./settings.js";
import type { PiModel, UsageReport } from "./types.js";
import { isAbortError, modelIdentity } from "./usage-helpers.js";

const RESET_SETTLE_MS = 2_000;
const STALE_RESET_RECHECK_MS = 15_000;

type CurrentCodexUsage = {
	model: PiModel;
	report: UsageReport;
};

type CodexAutoWaitDependencies = {
	checkCurrentUsage: (
		ctx: ExtensionContext,
		signal: AbortSignal,
	) => Promise<CurrentCodexUsage | undefined>;
	publishObservedUsage(ctx: ExtensionContext, usage: CurrentCodexUsage): void;
};

type WaitingState = {
	modelIdentity: string;
	resetsAtMs: number;
};

export function registerCodexAutoWait(
	pi: ExtensionAPI,
	settingsRuntime: UsageSettingsRuntime,
	dependencies: CodexAutoWaitDependencies,
) {
	let sessionController = new AbortController();
	let waiting: WaitingState | undefined;

	const enabled = () => settingsRuntime.get().settings.codexAutoWait5h;
	const clearWaiting = () => {
		waiting = undefined;
	};

	const observe = (report: UsageReport, model: PiModel | undefined) => {
		if (
			!enabled() ||
			model?.provider !== "openai-codex" ||
			report.providerId !== "openai-codex"
		) {
			return;
		}
		const bucket = findCodex5hBucket(report, model);
		const exhausted =
			(bucket?.remaining ?? 100) <= 0 || (bucket?.used ?? 0) >= 100;
		const resetsAtMs = bucket?.resetsAt ? bucket.resetsAt * 1_000 : undefined;
		if (!exhausted || !resetsAtMs || !Number.isFinite(resetsAtMs)) {
			if (waiting?.modelIdentity === modelIdentity(model)) clearWaiting();
			return;
		}
		waiting = { modelIdentity: modelIdentity(model) ?? "", resetsAtMs };
	};

	const waitForAvailability = async (ctx: ExtensionContext) => {
		if (!enabled() || ctx.model?.provider !== "openai-codex") return;
		const expectedModel = modelIdentity(ctx.model);
		let announced = false;
		while (
			!sessionController.signal.aborted &&
			enabled() &&
			modelIdentity(ctx.model) === expectedModel
		) {
			let current: CurrentCodexUsage | undefined;
			try {
				current = await dependencies.checkCurrentUsage(
					ctx,
					sessionController.signal,
				);
			} catch (error) {
				if (isAbortError(error)) return;
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Couldn't check Codex 5h usage; continuing without automatic wait.",
						"warning",
					);
				}
				return;
			}
			if (!current || modelIdentity(ctx.model) !== expectedModel) return;
			observe(current.report, current.model);
			const bucket = findCodex5hBucket(current.report, current.model);
			const exhausted =
				(bucket?.remaining ?? 100) <= 0 || (bucket?.used ?? 0) >= 100;
			const resetsAtMs = bucket?.resetsAt ? bucket.resetsAt * 1_000 : undefined;
			if (!exhausted) {
				clearWaiting();
				dependencies.publishObservedUsage(ctx, current);
				if (announced && ctx.hasUI)
					ctx.ui.notify("Codex 5h usage is available; continuing.", "info");
				return;
			}
			if (!resetsAtMs || !Number.isFinite(resetsAtMs)) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Codex 5h usage is exhausted, but no reset time was returned; continuing without automatic wait.",
						"warning",
					);
				}
				return;
			}
			waiting = { modelIdentity: expectedModel ?? "", resetsAtMs };
			dependencies.publishObservedUsage(ctx, current);
			if (!announced && ctx.hasUI) {
				ctx.ui.notify(
					`Codex 5h usage is exhausted; waiting until ${formatWaitTime(resetsAtMs)} before continuing.`,
					"info",
				);
				announced = true;
			}
			const delay =
				resetsAtMs > Date.now()
					? resetsAtMs - Date.now() + RESET_SETTLE_MS
					: STALE_RESET_RECHECK_MS;
			try {
				await waitFor(delay, sessionController.signal);
			} catch (error) {
				if (!isAbortError(error)) throw error;
				return;
			}
		}
	};

	const toggle = async (
		ctx: ExtensionContext,
		nextEnabled: boolean,
	): Promise<boolean> => {
		if (settingsRuntime.get().kind === "invalid") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-usage.json is invalid; repair it and reload before changing automatic wait.",
					"error",
				);
			}
			return false;
		}
		try {
			await settingsRuntime.update(
				{ codexAutoWait5h: nextEnabled },
				sessionController.signal,
			);
		} catch (error) {
			if (isAbortError(error)) return false;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Could not save automatic-wait setting: ${errorMessage(error)}`,
					"error",
				);
			}
			return false;
		}
		if (!nextEnabled) {
			sessionController.abort();
			sessionController = new AbortController();
			clearWaiting();
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				nextEnabled
					? "Automatic waiting for an exhausted Codex 5h limit is enabled."
					: "Automatic waiting for an exhausted Codex 5h limit is disabled.",
				"info",
			);
		}
		return true;
	};

	pi.registerCommand("autowait", {
		description: "Toggle automatic waiting for an exhausted Codex 5h limit",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (!ctx.hasUI) throw new Error("/autowait does not accept arguments.");
				ctx.ui.notify("/autowait does not accept arguments.", "warning");
				return;
			}
			if (!ctx.hasUI) throw new Error("/autowait requires TUI or RPC mode.");
			if (ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify(
					"/autowait is available only for the active OpenAI Codex model.",
					"warning",
				);
				return;
			}
			await toggle(ctx, !enabled());
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await waitForAvailability(ctx);
	});
	pi.on("session_start", () => {
		sessionController.abort();
		sessionController = new AbortController();
		clearWaiting();
	});
	pi.on("model_select", () => {
		sessionController.abort();
		sessionController = new AbortController();
		clearWaiting();
	});
	pi.on("session_shutdown", () => {
		sessionController.abort();
		clearWaiting();
	});

	return {
		enabled,
		observe,
		toggle,
		decorateStatus(model: PiModel | undefined, status: string): string {
			if (
				!enabled() ||
				!waiting ||
				waiting.modelIdentity !== modelIdentity(model)
			)
				return status;
			return `codex waiting until ${formatWaitTime(waiting.resetsAtMs)}`;
		},
	};
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, milliseconds);
		const abort = () => done(abortError());
		function done(error?: Error) {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

function formatWaitTime(timestampMs: number): string {
	const value = new Date(timestampMs);
	if (Number.isNaN(value.getTime())) return "an unknown time";
	const time = `${value.getHours().toString().padStart(2, "0")}:${value
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	return value.toDateString() === new Date().toDateString()
		? time
		: `${time} on ${value.getDate()} ${value.toLocaleDateString(undefined, { month: "short" })}`;
}

function abortError(): Error {
	return Object.assign(new Error("Automatic wait aborted."), {
		name: "AbortError",
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
