"use server";

import { NextRequest } from "next/server";
import { getSessionFull } from "@/lib/magiRepo";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
	try {
		const { id } = params;
		const full = await getSessionFull(id);
		return new Response(JSON.stringify({ ok: true, ...full }), {
			status: 200,
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


