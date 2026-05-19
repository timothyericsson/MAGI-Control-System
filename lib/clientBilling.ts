"use client";

import { getClientAuthContext } from "@/lib/clientAuth";

export async function startStripeCheckout(): Promise<void> {
	const auth = await getClientAuthContext();
	const res = await fetch("/api/billing/checkout", {
		method: "POST",
		headers: auth.headers,
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || !json?.ok || typeof json.url !== "string") {
		throw new Error(json?.error || "Unable to start checkout.");
	}
	window.location.assign(json.url);
}
