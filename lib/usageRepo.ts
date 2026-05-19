import { getSupabaseServer } from "@/lib/supabaseClient";

export const HOSTED_DAILY_RUN_LIMIT = 10;

export type HostedDailyUsage = {
	applies: boolean;
	limit: number;
	used: number;
	remaining: number;
	resetAt: string;
};

export class UsageLimitError extends Error {
	status = 429;

	constructor(message = "Daily hosted MAGI limit reached.") {
		super(message);
		this.name = "UsageLimitError";
	}
}

function utcDayWindow(now = new Date()): { start: string; end: string } {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const end = new Date(start);
	end.setUTCDate(end.getUTCDate() + 1);
	return { start: start.toISOString(), end: end.toISOString() };
}

export async function getHostedDailyUsage(userId: string, applies = true): Promise<HostedDailyUsage> {
	const { start, end } = utcDayWindow();
	if (!applies) {
		return {
			applies: false,
			limit: HOSTED_DAILY_RUN_LIMIT,
			used: 0,
			remaining: HOSTED_DAILY_RUN_LIMIT,
			resetAt: end,
		};
	}

	const { count, error } = await getSupabaseServer()
		.from("magi_usage_events")
		.select("id", { count: "exact", head: true })
		.eq("user_id", userId)
		.eq("event_type", "hosted_run")
		.gte("created_at", start)
		.lt("created_at", end);
	if (error) throw error;

	const used = count ?? 0;
	return {
		applies: true,
		limit: HOSTED_DAILY_RUN_LIMIT,
		used,
		remaining: Math.max(0, HOSTED_DAILY_RUN_LIMIT - used),
		resetAt: end,
	};
}

export async function assertHostedRunAvailable(userId: string): Promise<HostedDailyUsage> {
	const usage = await getHostedDailyUsage(userId, true);
	if (usage.remaining <= 0) {
		throw new UsageLimitError(`Daily hosted MAGI limit reached. You get ${usage.limit} runs per day.`);
	}
	return usage;
}

export async function recordHostedRun(userId: string, sessionId: string): Promise<HostedDailyUsage> {
	await getSupabaseServer().from("magi_usage_events").insert({
		user_id: userId,
		session_id: sessionId,
		event_type: "hosted_run",
	});
	return getHostedDailyUsage(userId, true);
}
