"use server";

import { NextRequest } from "next/server";
import { getArtifactById } from "@/lib/codeArtifacts";
import { apiErrorResponse, requireAuthenticatedUserId } from "@/lib/serverAuth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	try {
		const userId = await requireAuthenticatedUserId(req);
		const { id } = await params;
		const artifact = await getArtifactById(id);
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
		return apiErrorResponse(e);
	}
}
