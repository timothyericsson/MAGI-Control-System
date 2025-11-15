"use server";

import { NextRequest } from "next/server";
import { assertUser } from "@/lib/magiRepo";
import { getArtifactById } from "@/lib/codeArtifacts";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
	try {
		const { searchParams } = new URL(req.url);
		const userId = assertUser(searchParams.get("userId") || undefined);
		const artifact = await getArtifactById(params.id);
		if (!artifact || artifact.user_id !== userId) {
			return new Response(JSON.stringify({ ok: false, error: "Artifact not found" }), { status: 404 });
		}
		return new Response(
			JSON.stringify({
				ok: true,
				artifact: {
					id: artifact.id,
					original_filename: artifact.original_filename,
					status: artifact.status,
					ready_at: artifact.ready_at,
					manifest: artifact.manifest,
					created_at: artifact.created_at,
					updated_at: artifact.updated_at,
				},
			}),
			{ status: 200, headers: { "Cache-Control": "no-store" } }
		);
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


