"use server";

import { NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabaseClient";

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = new URL(req.url);
		const userId = (searchParams.get("userId") || "").trim();
		if (!userId) {
			return new Response(JSON.stringify({ ok: false, error: "Missing userId" }), { status: 400 });
		}
		const supabase = getSupabaseServer();
		const { data, error } = await supabase
			.from("magi_sessions")
			.select("id, user_id, question, status, error, created_at, updated_at")
			.eq("user_id", userId)
			.order("created_at", { ascending: false });
		if (error) {
			return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
		}

		const sessions = data ?? [];
		let consensusBySession: Record<string, { final_message_id: number | null; summary: string | null }> = {};
		if (sessions.length > 0) {
			const sessionIds = sessions.map((s) => s.id);
			const { data: consensusRows, error: consensusError } = await supabase
				.from("magi_consensus")
				.select("session_id, final_message_id, summary")
				.in("session_id", sessionIds);
			if (consensusError) {
				return new Response(JSON.stringify({ ok: false, error: consensusError.message }), {
					status: 500,
				});
			}
			consensusBySession = (consensusRows || []).reduce((acc, row) => {
				acc[row.session_id] = {
					final_message_id: row.final_message_id,
					summary: row.summary,
				};
				return acc;
			}, {} as Record<string, { final_message_id: number | null; summary: string | null }>);
		}

		const enriched = sessions.map((s) => {
			const consensus = consensusBySession[s.id] || { final_message_id: null, summary: null };
			return {
				...s,
				finalMessageId: consensus.final_message_id,
				consensusSummary: consensus.summary,
			};
		});

		return new Response(JSON.stringify({ ok: true, sessions: enriched }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


