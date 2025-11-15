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

export async function listAgents(): Promise<MagiAgent[]> {
        const supabase = getSupabaseServer();
        const { data, error } = await supabase.from("magi_agents").select("*").order("slug", { ascending: true });
        if (error) throw error;
        return (data || []).map((agent: any) => ({
                ...agent,
                model: typeof agent.model === "string" ? agent.model.trim() : agent.model,
        })) as unknown as MagiAgent[];
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


