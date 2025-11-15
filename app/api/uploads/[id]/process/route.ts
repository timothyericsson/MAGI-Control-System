import { NextRequest } from "next/server";
import { assertUser } from "@/lib/magiRepo";
import { getArtifactById, processArtifactZip, updateArtifact } from "@/lib/codeArtifacts";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
	try {
		const body = await req.json();
		const userId = assertUser(body.userId);
		const artifact = await getArtifactById(params.id);
		if (!artifact || artifact.user_id !== userId) {
			return new Response(JSON.stringify({ ok: false, error: "Artifact not found" }), { status: 404 });
		}
		if (artifact.status === "processing") {
			return new Response(JSON.stringify({ ok: true, status: "processing" }), { status: 202 });
		}
		if (artifact.status === "ready") {
			return new Response(JSON.stringify({ ok: true, status: "ready" }), { status: 200 });
		}

		await updateArtifact(artifact.id, { status: "processing", updated_at: new Date().toISOString() });
		try {
			await processArtifactZip(artifact);
			return new Response(JSON.stringify({ ok: true, status: "ready" }), { status: 200 });
		} catch (err: any) {
			await updateArtifact(artifact.id, { status: "failed", updated_at: new Date().toISOString() });
			throw err;
		}
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


