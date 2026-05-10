"use server";

import { NextRequest } from "next/server";
import { getSessionFull } from "@/lib/magiRepo";
import { apiErrorResponse, requireAuthenticatedUserId } from "@/lib/serverAuth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const userId = await requireAuthenticatedUserId(req);
		const full = await getSessionFull(id, userId);
		if (!full.session) {
			return new Response(JSON.stringify({ ok: false, error: "Session not found" }), { status: 404 });
		}
		return new Response(JSON.stringify({ ok: true, ...full }), {
			status: 200,
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (e: any) {
		return apiErrorResponse(e);
	}
}
