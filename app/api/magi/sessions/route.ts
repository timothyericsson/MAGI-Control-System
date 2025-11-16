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
                        .select("id, user_id, question, artifact_id, live_url, status, error, created_at, updated_at")
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

export async function DELETE(req: NextRequest) {
	try {
		const { searchParams } = new URL(req.url);
		const userId = (searchParams.get("userId") || "").trim();
		if (!userId) {
			return new Response(JSON.stringify({ ok: false, error: "Missing userId" }), { status: 400 });
		}
		const supabase = getSupabaseServer();
		const { data: sessions, error } = await supabase
			.from("magi_sessions")
			.select("id")
			.eq("user_id", userId);
		if (error) {
			return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
		}
		const ids = (sessions || []).map((s) => s.id);
		if (ids.length === 0) {
			return new Response(JSON.stringify({ ok: true, cleared: 0 }), {
				status: 200,
				headers: { "Cache-Control": "no-store" },
			});
		}

		const tablesToClear = [
			{ table: "magi_votes", column: "session_id" },
			{ table: "magi_messages", column: "session_id" },
			{ table: "magi_consensus", column: "session_id" },
		];
		for (const { table, column } of tablesToClear) {
			const { error: deleteError } = await supabase.from(table).delete().in(column, ids);
			if (deleteError) {
				return new Response(JSON.stringify({ ok: false, error: deleteError.message }), { status: 500 });
			}
		}

		const { error: sessionDeleteError } = await supabase.from("magi_sessions").delete().in("id", ids);
		if (sessionDeleteError) {
			return new Response(JSON.stringify({ ok: false, error: sessionDeleteError.message }), { status: 500 });
		}

		return new Response(JSON.stringify({ ok: true, cleared: ids.length }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}



