import { getSupabaseServer } from "@/lib/supabaseClient";
import type {
	MagiAgent,
	MagiConsensus,
	MagiMessage,
	MagiMessageKind,
	MagiSession,
	MagiSessionStatus,
	MagiVote,
} from "@/lib/magiTypes";

const DEFAULT_AGENTS: Array<{
        slug: MagiAgent["slug"];
        name: string;
        provider: MagiAgent["provider"];
        model: string | null;
        color: string | null;
}> = [
        { slug: "casper", name: "CASPER", provider: "openai", model: "gpt-4o-mini", color: "#38bdf8" },
        { slug: "balthasar", name: "BALTHASAR", provider: "anthropic", model: "claude-3-5-sonnet", color: "#f472b6" },
        { slug: "melchior", name: "MELCHIOR", provider: "grok", model: "grok-2-mini", color: "#facc15" },
];

export async function listAgents(): Promise<MagiAgent[]> {
        const supabase = getSupabaseServer();
        const { data, error } = await supabase.from("magi_agents").select("*").order("slug", { ascending: true });
        if (error) throw error;
        const present = new Set((data || []).map((row: { slug: string }) => row.slug));
        const missing = DEFAULT_AGENTS.filter((agent) => !present.has(agent.slug));
        if (missing.length > 0) {
                const { error: seedError } = await supabase
                        .from("magi_agents")
                        .upsert(missing, { onConflict: "slug" });
                if (seedError) throw seedError;
                const { data: refreshed, error: refreshError } = await supabase
                        .from("magi_agents")
                        .select("*")
                        .order("slug", { ascending: true });
                if (refreshError) throw refreshError;
                return refreshed as unknown as MagiAgent[];
        }
        return (data || []) as unknown as MagiAgent[];
}

export async function createSession(userId: string, question: string): Promise<MagiSession> {
	const supabase = getSupabaseServer();
	const { data, error } = await supabase
		.from("magi_sessions")
		.insert([{ user_id: userId, question, status: "running" as MagiSessionStatus }])
		.select("*")
		.single();
	if (error) throw error;
	return data as unknown as MagiSession;
}

export async function addMessage(params: {
	sessionId: string;
	role: MagiMessageKind;
	content: string;
	agentId?: string | null;
	model?: string | null;
	tokens?: number | null;
	meta?: Record<string, unknown>;
}): Promise<MagiMessage> {
	const supabase = getSupabaseServer();
	const { data, error } = await supabase
		.from("magi_messages")
		.insert([
			{
				session_id: params.sessionId,
				role: params.role,
				content: params.content,
				agent_id: params.agentId ?? null,
				model: params.model ?? null,
				tokens: params.tokens ?? null,
				meta: params.meta ?? {},
			},
		])
		.select("*")
		.single();
	if (error) throw error;
	return data as unknown as MagiMessage;
}

export async function addVote(params: {
	sessionId: string;
	agentId: string;
	targetMessageId: number;
	score: number;
	rationale?: string | null;
}): Promise<MagiVote> {
	const supabase = getSupabaseServer();
	const { data, error } = await supabase
		.from("magi_votes")
		.insert([
			{
				session_id: params.sessionId,
				agent_id: params.agentId,
				target_message_id: params.targetMessageId,
				score: params.score,
				rationale: params.rationale ?? null,
			},
		])
		.select("*")
		.single();
	if (error) throw error;
	return data as unknown as MagiVote;
}

export async function setSessionStatus(sessionId: string, status: MagiSessionStatus, errorText?: string | null) {
	const supabase = getSupabaseServer();
	const { error } = await supabase
		.from("magi_sessions")
		.update({ status, error: errorText ?? null })
		.eq("id", sessionId);
	if (error) throw error;
}

export async function upsertConsensus(params: {
	sessionId: string;
	finalMessageId: number | null;
	summary?: string | null;
}): Promise<MagiConsensus> {
	const supabase = getSupabaseServer();
	const { data, error } = await supabase
		.from("magi_consensus")
		.upsert({
			session_id: params.sessionId,
			final_message_id: params.finalMessageId,
			summary: params.summary ?? null,
		})
		.select("*")
		.single();
	if (error) throw error;
	return data as unknown as MagiConsensus;
}

export async function getSessionFull(sessionId: string): Promise<{
	session: MagiSession | null;
	messages: MagiMessage[];
	votes: MagiVote[];
	consensus: MagiConsensus | null;
	agents: MagiAgent[];
}> {
	const supabase = getSupabaseServer();
	const [{ data: session }, { data: messages }, { data: votes }, { data: consensus }, agents] = await Promise.all([
		supabase.from("magi_sessions").select("*").eq("id", sessionId).single(),
		supabase.from("magi_messages").select("*").eq("session_id", sessionId).order("created_at", { ascending: true }),
		supabase.from("magi_votes").select("*").eq("session_id", sessionId).order("created_at", { ascending: true }),
		supabase.from("magi_consensus").select("*").eq("session_id", sessionId).maybeSingle(),
		listAgents(),
	]);
	return {
		session: (session || null) as unknown as MagiSession | null,
		messages: (messages || []) as unknown as MagiMessage[],
		votes: (votes || []) as unknown as MagiVote[],
		consensus: (consensus || null) as unknown as MagiConsensus | null,
		agents,
	};
}

export function assertUser(userId?: string): string {
	if (!userId) {
		throw new Error("Missing userId");
	}
	return userId;
}


