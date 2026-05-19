import { NextRequest } from "next/server";
import { apiErrorResponse, requireAuthenticatedUser } from "@/lib/serverAuth";
import { ensureProfile } from "@/lib/profileRepo";
import { isHostedPaidProfile } from "@/lib/hostedKeys";
import { getHostedDailyUsage } from "@/lib/usageRepo";

export async function GET(req: NextRequest) {
	try {
		const user = await requireAuthenticatedUser(req);
		const profile = await ensureProfile(user);
		const hostedPaid = isHostedPaidProfile(profile);
		const usage = await getHostedDailyUsage(user.id, hostedPaid);
		return new Response(JSON.stringify({ ok: true, hostedPaid, usage }), {
			status: 200,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return apiErrorResponse(error);
	}
}
