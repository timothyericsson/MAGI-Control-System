"use server";

import { NextRequest } from "next/server";
import { addMessage, assertUser, createSession, setSessionStatus } from "@/lib/magiRepo";
import type { CreateSessionRequestBody } from "@/lib/magiTypes";

export async function POST(req: NextRequest) {
	try {
		const body = (await req.json()) as CreateSessionRequestBody;
		const userId = assertUser(body.userId);
		const question = (body.question || "").trim();
		if (!question) {
			return new Response(JSON.stringify({ ok: false, error: "Question is required" }), { status: 400 });
		}
		const session = await createSession(userId, question);
		await addMessage({
			sessionId: session.id,
			role: "user",
			content: question,
			agentId: null,
		});
		await setSessionStatus(session.id, "running");
		return new Response(JSON.stringify({ ok: true, sessionId: session.id }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


