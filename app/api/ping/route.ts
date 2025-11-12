import { NextResponse } from "next/server";

type Provider = "openai" | "anthropic" | "grok";

async function pingOpenAI(apiKey: string): Promise<boolean> {
	try {
		const res = await fetch("https://api.openai.com/v1/models", {
			method: "GET",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
			},
			// Tiny timeout guard
			cache: "no-store",
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function pingAnthropic(apiKey: string): Promise<boolean> {
	try {
		const res = await fetch("https://api.anthropic.com/v1/models", {
			method: "GET",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			cache: "no-store",
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function pingGrok(apiKey: string): Promise<boolean> {
	try {
		// xAI API (Grok) models endpoint
		const res = await fetch("https://api.x.ai/v1/models", {
			method: "GET",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
			},
			cache: "no-store",
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function POST(req: Request) {
	try {
		const { provider, apiKey } = (await req.json()) as { provider: Provider; apiKey: string };
		if (!provider || !apiKey) {
			return NextResponse.json({ ok: false, error: "Missing provider or apiKey" }, { status: 400 });
		}

		let ok = false;
		if (provider === "openai") ok = await pingOpenAI(apiKey);
		else if (provider === "anthropic") ok = await pingAnthropic(apiKey);
		else if (provider === "grok") ok = await pingGrok(apiKey);
		else return NextResponse.json({ ok: false, error: "Unknown provider" }, { status: 400 });

		return NextResponse.json({ ok });
	} catch (e) {
		return NextResponse.json({ ok: false, error: "Unexpected error" }, { status: 500 });
	}
}


