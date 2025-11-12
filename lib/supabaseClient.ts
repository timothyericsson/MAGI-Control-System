import { createClient } from "@supabase/supabase-js";

export const supabaseBrowser = typeof window !== "undefined"
	? createClient(
			process.env.NEXT_PUBLIC_SUPABASE_URL || "",
			process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
		)
	: undefined;

// For server-side secure operations only (do not expose to client)
export function getSupabaseServer() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
	if (!url || !serviceKey) {
		throw new Error("Supabase server credentials are not configured");
	}
	return createClient(url, serviceKey);
}


