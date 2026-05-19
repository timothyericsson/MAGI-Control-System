import type { MagiProfile } from "@/lib/magiTypes";

export type ProviderKeyMap = {
	openai?: string;
	anthropic?: string;
	grok?: string;
	xai?: string;
};

export function isHostedPaidProfile(profile: Pick<MagiProfile, "usage_mode" | "payment_status"> | null | undefined): boolean {
	return profile?.usage_mode === "paid" && profile.payment_status === "paid";
}

export function getHostedProviderKeys(): ProviderKeyMap {
	return {
		openai: process.env.OPENAI_API_KEY || undefined,
		anthropic: process.env.ANTHROPIC_API_KEY || undefined,
		grok: process.env.XAI_API_KEY || process.env.GROK_API_KEY || undefined,
		xai: process.env.XAI_API_KEY || process.env.GROK_API_KEY || undefined,
	};
}

export function assertHostedProviderKeys(keys: ProviderKeyMap): void {
	const missing: string[] = [];
	if (!keys.openai) missing.push("OPENAI_API_KEY");
	if (!keys.anthropic) missing.push("ANTHROPIC_API_KEY");
	if (!keys.grok && !keys.xai) missing.push("XAI_API_KEY");
	if (missing.length > 0) {
		throw new Error(`Hosted MAGI keys are not configured: ${missing.join(", ")}`);
	}
}
