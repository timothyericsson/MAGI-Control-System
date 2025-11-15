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
		return new Response(JSON.stringify({ ok: true, sessions: data ?? [] }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


