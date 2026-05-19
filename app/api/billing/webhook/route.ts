import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabaseClient";

export const runtime = "nodejs";

type StripeEvent = {
	id: string;
	type: string;
	data: {
		object: Record<string, any>;
	};
};

function getSignatureParts(header: string): { timestamp: string; signatures: string[] } {
	const parts = header.split(",").map((part) => part.trim());
	const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) || "";
	const signatures = parts
		.filter((part) => part.startsWith("v1="))
		.map((part) => part.slice(3))
		.filter(Boolean);
	return { timestamp, signatures };
}

function verifyStripeSignature(payload: string, signatureHeader: string, secret: string): boolean {
	const { timestamp, signatures } = getSignatureParts(signatureHeader);
	if (!timestamp || signatures.length === 0) return false;

	const signedPayload = `${timestamp}.${payload}`;
	const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
	const expectedBuffer = Buffer.from(expected, "hex");

	return signatures.some((signature) => {
		const actualBuffer = Buffer.from(signature, "hex");
		return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
	});
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function asTimestamp(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return new Date(value * 1000).toISOString();
}

function isPaidSubscriptionStatus(status: string | null): boolean {
	return status === "active" || status === "trialing";
}

async function upsertSubscriptionFromCheckout(session: Record<string, any>) {
	const userId = asString(session.client_reference_id) || asString(session.metadata?.user_id);
	if (!userId) return;

	const stripeCustomerId = asString(session.customer);
	const stripeSubscriptionId = asString(session.subscription);
	const stripeCheckoutSessionId = asString(session.id);
	const stripePriceId = process.env.STRIPE_PRICE_ID || null;
	const supabase = getSupabaseServer();

	await supabase.from("magi_subscriptions").upsert(
		{
			user_id: userId,
			stripe_customer_id: stripeCustomerId,
			stripe_subscription_id: stripeSubscriptionId,
			stripe_checkout_session_id: stripeCheckoutSessionId,
			stripe_price_id: stripePriceId,
			status: session.payment_status === "paid" ? "checkout_paid" : "checkout_completed",
			updated_at: new Date().toISOString(),
		},
		{ onConflict: "stripe_checkout_session_id" }
	);

	await supabase
		.from("profiles")
		.update({
			usage_mode: "paid",
			payment_status: session.payment_status === "paid" ? "paid" : "checkout_started",
			stripe_customer_id: stripeCustomerId,
			stripe_subscription_id: stripeSubscriptionId,
			stripe_checkout_session_id: stripeCheckoutSessionId,
			updated_at: new Date().toISOString(),
		})
		.eq("id", userId);
}

async function upsertSubscription(subscription: Record<string, any>) {
	const stripeSubscriptionId = asString(subscription.id);
	if (!stripeSubscriptionId) return;

	const userId = asString(subscription.metadata?.user_id);
	const stripeCustomerId = asString(subscription.customer);
	const status = asString(subscription.status) || "unknown";
	const currentPeriodEnd = asTimestamp(subscription.current_period_end);
	const stripePriceId = asString(subscription.items?.data?.[0]?.price?.id);
	const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
	const supabase = getSupabaseServer();

	const { data: existing } = await supabase
		.from("magi_subscriptions")
		.select("user_id")
		.eq("stripe_subscription_id", stripeSubscriptionId)
		.maybeSingle();
	const resolvedUserId = userId || existing?.user_id;
	if (!resolvedUserId) return;

	await supabase.from("magi_subscriptions").upsert(
		{
			user_id: resolvedUserId,
			stripe_customer_id: stripeCustomerId,
			stripe_subscription_id: stripeSubscriptionId,
			stripe_price_id: stripePriceId,
			status,
			current_period_end: currentPeriodEnd,
			cancel_at_period_end: cancelAtPeriodEnd,
			updated_at: new Date().toISOString(),
		},
		{ onConflict: "stripe_subscription_id" }
	);

	await supabase
		.from("profiles")
		.update({
			usage_mode: "paid",
			payment_status: isPaidSubscriptionStatus(status) ? "paid" : "checkout_started",
			stripe_customer_id: stripeCustomerId,
			stripe_subscription_id: stripeSubscriptionId,
			updated_at: new Date().toISOString(),
		})
		.eq("id", resolvedUserId);
}

async function markSubscriptionCancelled(subscription: Record<string, any>) {
	const stripeSubscriptionId = asString(subscription.id);
	if (!stripeSubscriptionId) return;

	const supabase = getSupabaseServer();
	const { data: existing } = await supabase
		.from("magi_subscriptions")
		.select("user_id")
		.eq("stripe_subscription_id", stripeSubscriptionId)
		.maybeSingle();
	const userId = asString(subscription.metadata?.user_id) || existing?.user_id;

	await supabase
		.from("magi_subscriptions")
		.update({
			status: asString(subscription.status) || "canceled",
			cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
			updated_at: new Date().toISOString(),
		})
		.eq("stripe_subscription_id", stripeSubscriptionId);

	if (userId) {
		await supabase
			.from("profiles")
			.update({
				payment_status: "pay_later",
				updated_at: new Date().toISOString(),
			})
			.eq("id", userId);
	}
}

export async function POST(req: NextRequest) {
	const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
	if (!webhookSecret) {
		return new Response(JSON.stringify({ ok: false, error: "Stripe webhook is not configured." }), { status: 501 });
	}

	const signature = req.headers.get("stripe-signature") || "";
	const payload = await req.text();
	if (!verifyStripeSignature(payload, signature, webhookSecret)) {
		return new Response(JSON.stringify({ ok: false, error: "Invalid Stripe signature." }), { status: 400 });
	}

	const event = JSON.parse(payload) as StripeEvent;
	if (event.type === "checkout.session.completed") {
		await upsertSubscriptionFromCheckout(event.data.object);
	}
	if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
		await upsertSubscription(event.data.object);
	}
	if (event.type === "customer.subscription.deleted") {
		await markSubscriptionCancelled(event.data.object);
	}

	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Cache-Control": "no-store" },
	});
}
