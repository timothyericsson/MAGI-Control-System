import { createClient } from "@supabase/supabase-js";

export type AuthenticatedUser = {
	id: string;
	email: string | null;
};

export class AuthError extends Error {
	status = 401;

	constructor(message = "Unauthorized") {
		super(message);
		this.name = "AuthError";
	}
}

function getBearerToken(req: Request): string {
	const header = req.headers.get("authorization") || "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) {
		throw new AuthError("Missing authorization token");
	}
	return match[1].trim();
}

export async function requireAuthenticatedUserId(req: Request): Promise<string> {
	const user = await requireAuthenticatedUser(req);
	return user.id;
}

export async function requireAuthenticatedUser(req: Request): Promise<AuthenticatedUser> {
	const token = getBearerToken(req);
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
	const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
	if (!url || !anonKey) {
		throw new Error("Supabase auth credentials are not configured");
	}

	const supabase = createClient(url, anonKey, {
		auth: {
			autoRefreshToken: false,
			persistSession: false,
		},
	});
	const { data, error } = await supabase.auth.getUser(token);
	if (error || !data.user?.id) {
		throw new AuthError("Invalid authorization token");
	}
	return {
		id: data.user.id,
		email: data.user.email ?? null,
	};
}

export function apiErrorResponse(error: unknown): Response {
	if (error instanceof AuthError) {
		return new Response(JSON.stringify({ ok: false, error: error.message }), { status: error.status });
	}
	if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
		const message = error instanceof Error ? error.message : "Unexpected error";
		return new Response(JSON.stringify({ ok: false, error: message }), {
			status: (error as { status: number }).status,
		});
	}
	const message = error instanceof Error ? error.message : "Unexpected error";
	return new Response(JSON.stringify({ ok: false, error: message }), { status: 500 });
}
