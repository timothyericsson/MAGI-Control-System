"use client";

import { supabaseBrowser } from "@/lib/supabaseClient";

export type ClientAuthContext = {
	userId: string;
	accessToken: string;
	headers: Record<string, string>;
};

export async function getClientAuthContext(): Promise<ClientAuthContext> {
	if (!supabaseBrowser) {
		throw new Error("Auth not initialized");
	}
	const { data, error } = await supabaseBrowser.auth.getSession();
	if (error) {
		throw error;
	}
	const session = data.session;
	if (!session?.user?.id || !session.access_token) {
		throw new Error("You must be signed in.");
	}
	return {
		userId: session.user.id,
		accessToken: session.access_token,
		headers: {
			Authorization: `Bearer ${session.access_token}`,
		},
	};
}
