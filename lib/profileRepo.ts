import { getSupabaseServer } from "@/lib/supabaseClient";
import type { AuthenticatedUser } from "@/lib/serverAuth";
import type { MagiPaymentStatus, MagiProfile, MagiUsageMode } from "@/lib/magiTypes";

export const PROFILE_SELECT =
	"id, email, display_name, usage_mode, payment_status, stripe_checkout_session_id, created_at, updated_at";

export type ProfilePatch = {
	usage_mode?: MagiUsageMode | null;
	payment_status?: MagiPaymentStatus | null;
	stripe_checkout_session_id?: string | null;
};

export async function ensureProfile(user: AuthenticatedUser): Promise<MagiProfile> {
	const supabase = getSupabaseServer();
	const { data: existing, error: readError } = await supabase
		.from("profiles")
		.select(PROFILE_SELECT)
		.eq("id", user.id)
		.maybeSingle();
	if (readError) throw readError;
	if (existing) return existing as MagiProfile;

	const now = new Date().toISOString();
	const { data, error } = await supabase
		.from("profiles")
		.insert({
			id: user.id,
			email: user.email,
			created_at: now,
			updated_at: now,
		})
		.select(PROFILE_SELECT)
		.single();
	if (error) throw error;
	return data as MagiProfile;
}

export async function updateProfile(user: AuthenticatedUser, patch: ProfilePatch): Promise<MagiProfile> {
	await ensureProfile(user);
	const { data, error } = await getSupabaseServer()
		.from("profiles")
		.update({
			...patch,
			email: user.email,
			updated_at: new Date().toISOString(),
		})
		.eq("id", user.id)
		.select(PROFILE_SELECT)
		.single();
	if (error) throw error;
	return data as MagiProfile;
}
