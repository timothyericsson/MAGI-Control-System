import { NextRequest } from "next/server";
import { apiErrorResponse, requireAuthenticatedUser } from "@/lib/serverAuth";
import { ensureProfile, updateProfile } from "@/lib/profileRepo";
import type { MagiPaymentStatus, MagiUsageMode } from "@/lib/magiTypes";

const USAGE_MODES: MagiUsageMode[] = ["bring_keys", "paid"];
const PAYMENT_STATUSES: MagiPaymentStatus[] = ["not_required", "pay_later", "checkout_started", "paid"];

function isUsageMode(value: unknown): value is MagiUsageMode {
	return typeof value === "string" && USAGE_MODES.includes(value as MagiUsageMode);
}

function isPaymentStatus(value: unknown): value is MagiPaymentStatus {
	return typeof value === "string" && PAYMENT_STATUSES.includes(value as MagiPaymentStatus);
}

export async function GET(req: NextRequest) {
	try {
		const user = await requireAuthenticatedUser(req);
		const profile = await ensureProfile(user);
		return new Response(JSON.stringify({ ok: true, profile }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return apiErrorResponse(error);
	}
}

export async function PATCH(req: NextRequest) {
	try {
		const user = await requireAuthenticatedUser(req);
		const body = (await req.json().catch(() => ({}))) as {
			usageMode?: unknown;
			paymentStatus?: unknown;
		};
		const patch: {
			usage_mode?: MagiUsageMode;
			payment_status?: MagiPaymentStatus;
			stripe_checkout_session_id?: null;
		} = {};

		if ("usageMode" in body) {
			if (!isUsageMode(body.usageMode)) {
				return new Response(JSON.stringify({ ok: false, error: "Invalid usage mode" }), { status: 400 });
			}
			patch.usage_mode = body.usageMode;
			if (body.usageMode === "bring_keys") {
				patch.payment_status = "not_required";
				patch.stripe_checkout_session_id = null;
			}
		}

		if ("paymentStatus" in body) {
			if (!isPaymentStatus(body.paymentStatus)) {
				return new Response(JSON.stringify({ ok: false, error: "Invalid payment status" }), { status: 400 });
			}
			patch.payment_status = body.paymentStatus;
		}

		if (!("usage_mode" in patch) && !("payment_status" in patch)) {
			return new Response(JSON.stringify({ ok: false, error: "Invalid usage mode" }), { status: 400 });
		}

		const profile = await updateProfile(user, patch);

		return new Response(JSON.stringify({ ok: true, profile }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return apiErrorResponse(error);
	}
}
