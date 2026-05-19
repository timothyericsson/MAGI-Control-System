"use server";

import { NextRequest } from "next/server";
import { addMessage, createSession, setSessionStatus } from "@/lib/magiRepo";
import { getArtifactById } from "@/lib/codeArtifacts";
import { normalizeLiveUrl } from "@/lib/liveUrl";
import { apiErrorResponse, requireAuthenticatedUser } from "@/lib/serverAuth";
import { ensureProfile } from "@/lib/profileRepo";
import { assertHostedRunAvailable, recordHostedRun } from "@/lib/usageRepo";
import { isHostedPaidProfile } from "@/lib/hostedKeys";
import type { CreateSessionRequestBody } from "@/lib/magiTypes";

export async function POST(req: NextRequest) {
	try {
		const body = (await req.json()) as CreateSessionRequestBody;
		const user = await requireAuthenticatedUser(req);
		const userId = user.id;
		const profile = await ensureProfile(user);
		const hostedPaid = isHostedPaidProfile(profile);
		const question = (body.question || "").trim();
                const artifactId = typeof body.artifactId === "string" ? body.artifactId.trim() : "";
                const normalizedLiveUrl = normalizeLiveUrl(body.liveUrl);
                if (!question) {
                        return new Response(JSON.stringify({ ok: false, error: "Question is required" }), { status: 400 });
                }
		let resolvedArtifactId: string | null = null;
		if (artifactId) {
			const artifact = await getArtifactById(artifactId);
			if (!artifact || artifact.user_id !== userId) {
				return new Response(JSON.stringify({ ok: false, error: "Uploaded bundle not found" }), { status: 404 });
			}
			if (artifact.status !== "ready") {
				return new Response(JSON.stringify({ ok: false, error: "Uploaded bundle is still processing" }), { status: 409 });
			}
			resolvedArtifactId = artifact.id;
		}
		if (hostedPaid) {
			await assertHostedRunAvailable(userId);
		}
                const session = await createSession(userId, question, resolvedArtifactId, normalizedLiveUrl);
		await addMessage({
			sessionId: session.id,
			role: "user",
			content: question,
			agentId: null,
		});
		await setSessionStatus(session.id, "running");
		const usage = hostedPaid ? await recordHostedRun(userId, session.id) : null;
		return new Response(JSON.stringify({ ok: true, sessionId: session.id, usage }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (e: any) {
		return apiErrorResponse(e);
	}
}
