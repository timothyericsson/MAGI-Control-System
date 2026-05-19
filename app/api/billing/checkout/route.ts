import { NextRequest } from "next/server";
import { apiErrorResponse, requireAuthenticatedUser } from "@/lib/serverAuth";
import { updateProfile } from "@/lib/profileRepo";

function getOrigin(req: NextRequest): string {
	const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL;
	if (configured) return configured.replace(/\/$/, "");
	const proto = req.headers.get("x-forwarded-proto") || "http";
	const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
	return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
	try {
		const user = await requireAuthenticatedUser(req);
		const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
		const priceId = process.env.STRIPE_PRICE_ID;

		if (!stripeSecretKey || !priceId) {
			return new Response(
				JSON.stringify({
					ok: false,
					error: "Stripe checkout is not configured yet. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID.",
				}),
				{ status: 501 }
			);
		}

		const origin = getOrigin(req);
		const params = new URLSearchParams({
			mode: "payment",
			"line_items[0][price]": priceId,
			"line_items[0][quantity]": "1",
			success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${origin}/?checkout=cancelled`,
			client_reference_id: user.id,
			"metadata[user_id]": user.id,
			"metadata[usage_mode]": "paid",
		});
		if (user.email) {
			params.set("customer_email", user.email);
		}

		const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${stripeSecretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params,
			cache: "no-store",
		});
		const payload = await stripeRes.json().catch(() => ({}));
		if (!stripeRes.ok || typeof payload?.url !== "string") {
			return new Response(
				JSON.stringify({
					ok: false,
					error: payload?.error?.message || "Stripe checkout could not be started.",
				}),
				{ status: 502 }
			);
		}

		await updateProfile(user, {
			usage_mode: "paid",
			payment_status: "checkout_started",
			stripe_checkout_session_id: typeof payload.id === "string" ? payload.id : null,
		});

		return new Response(JSON.stringify({ ok: true, url: payload.url }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return apiErrorResponse(error);
	}
}
