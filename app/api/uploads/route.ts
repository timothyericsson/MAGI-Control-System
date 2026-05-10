"use server";

import { NextRequest } from "next/server";
import { CODE_BUCKET, MAX_UPLOAD_BYTES, createArtifactRecord } from "@/lib/codeArtifacts";
import { getSupabaseServer } from "@/lib/supabaseClient";
import { apiErrorResponse, requireAuthenticatedUserId } from "@/lib/serverAuth";

export async function POST(req: NextRequest) {
	try {
		const body = await req.json();
		const userId = await requireAuthenticatedUserId(req);
		const filename = (body.filename || "").trim();
		const size = Number(body.size);

		if (!filename || !filename.toLowerCase().endsWith(".zip")) {
			return new Response(JSON.stringify({ ok: false, error: "Only .zip files are supported" }), { status: 400 });
		}
		if (!Number.isFinite(size) || size <= 0) {
			return new Response(JSON.stringify({ ok: false, error: "File size must be provided" }), { status: 400 });
		}
		if (size > MAX_UPLOAD_BYTES) {
			return new Response(
				JSON.stringify({ ok: false, error: `File too large. Max size is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.` }),
				{ status: 400 }
			);
		}

		const artifact = await createArtifactRecord({ userId, filename, byteLength: size });
		const supabase = getSupabaseServer();
		const { data, error } = await supabase.storage
			.from(CODE_BUCKET)
			.createSignedUploadUrl(artifact.storage_path, { upsert: true });
		if (error) {
			return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
		}

		return new Response(
			JSON.stringify({
				ok: true,
				artifactId: artifact.id,
				uploadUrl: data?.signedUrl,
				path: artifact.storage_path,
				status: artifact.status,
			}),
			{ status: 200 }
		);
	} catch (e: any) {
		return apiErrorResponse(e);
	}
}

export async function GET(req: NextRequest) {
	try {
		const userId = await requireAuthenticatedUserId(req);
		const supabase = getSupabaseServer();
		const { data, error } = await supabase
			.from("magi_code_artifacts")
			.select("id, original_filename, status, ready_at, created_at, updated_at, manifest")
			.eq("user_id", userId)
			.order("created_at", { ascending: false })
			.limit(25);
		if (error) {
			return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
		}
		return new Response(JSON.stringify({ ok: true, artifacts: data ?? [] }), { status: 200, headers: { "Cache-Control": "no-store" } });
	} catch (e: any) {
		return apiErrorResponse(e);
	}
}
