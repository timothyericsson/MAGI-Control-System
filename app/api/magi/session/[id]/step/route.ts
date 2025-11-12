"use server";

import { NextRequest } from "next/server";
import {
	addMessage,
	addVote,
	getSessionFull,
	listAgents,
	setSessionStatus,
	upsertConsensus,
} from "@/lib/magiRepo";
import type { MagiAgent, MagiMessage, MagiMessageKind, StepRequestBody } from "@/lib/magiTypes";

type ProviderKeyMap = { openai?: string; anthropic?: string; grok?: string };

function keyForAgent(agent: MagiAgent, keys?: ProviderKeyMap): string | undefined {
	if (!keys) return undefined;
	if (agent.provider === "openai") return keys.openai;
	if (agent.provider === "anthropic") return keys.anthropic;
	if (agent.provider === "grok") return keys.grok;
	return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
		promise
			.then((v) => {
				clearTimeout(id);
				resolve(v);
			})
			.catch((e) => {
				clearTimeout(id);
				reject(e);
			});
	});
}

async function callOpenAIChat(apiKey: string, model: string, messages: { role: string; content: string }[]): Promise<string> {
	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model || "gpt-4o-mini",
			messages,
			temperature: 0.3,
		}),
	});
	if (!res.ok) throw new Error(`openai error ${res.status}`);
	const data = await res.json();
	const txt = data?.choices?.[0]?.message?.content ?? "";
	return String(txt).trim();
}

async function callXAIChat(apiKey: string, model: string, messages: { role: string; content: string }[]): Promise<string> {
	// xAI is OpenAI-compatible for chat completions
	const res = await fetch("https://api.x.ai/v1/chat/completions", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model || "grok-2-mini",
			messages,
			temperature: 0.3,
		}),
	});
	if (!res.ok) throw new Error(`xai error ${res.status}`);
	const data = await res.json();
	const txt = data?.choices?.[0]?.message?.content ?? "";
	return String(txt).trim();
}

async function callAnthropic(apiKey: string, model: string, messages: { role: "user" | "assistant" | "system"; content: string }[]): Promise<string> {
	// Convert to Anthropic messages API format
	const sys = messages.find((m) => m.role === "system")?.content;
	const userTurns = messages.filter((m) => m.role !== "system").map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: [{ type: "text", text: m.content }],
	}));
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model || "claude-3-5-sonnet",
			max_tokens: 400,
			system: sys,
			messages: userTurns,
			temperature: 0.3,
		}),
	});
	if (!res.ok) throw new Error(`anthropic error ${res.status}`);
	const data = await res.json();
	const txt = data?.content?.[0]?.text ?? "";
	return String(txt).trim();
}

async function agentChat(agent: MagiAgent, keys: ProviderKeyMap | undefined, messages: { role: "system" | "user" | "assistant"; content: string }[]): Promise<string> {
	const key = keyForAgent(agent, keys);
	const model = agent.model || (agent.provider === "openai" ? "gpt-4o-mini" : agent.provider === "anthropic" ? "claude-3-5-sonnet" : "grok-2-mini");
	if (!key) throw new Error(`Missing key for ${agent.provider}`);
	if (agent.provider === "openai") {
		return await withTimeout(callOpenAIChat(key, model, messages), 20000, "openai");
	}
	if (agent.provider === "anthropic") {
		// Anthropics roles are different; function adapts
		return await withTimeout(callAnthropic(key, model, messages as any), 20000, "anthropic");
	}
	// grok/xai
	return await withTimeout(callXAIChat(key, model, messages), 20000, "xai");
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
	try {
		const body = (await req.json()) as StepRequestBody;
		const { id: sessionId } = params;
		const { step } = body;
		const keys = (body?.keys || {}) as ProviderKeyMap;

		if (!["propose", "critique", "vote", "consensus"].includes(step)) {
			return new Response(JSON.stringify({ ok: false, error: "Invalid step" }), { status: 400 });
		}

		const agents = await listAgents();
		const full = await getSessionFull(sessionId);
		if (!full.session) {
			return new Response(JSON.stringify({ ok: false, error: "Session not found" }), { status: 404 });
		}

		if (step === "propose") {
			// Create proposals via real model calls; fallback to synthetic if a provider key is missing
			const userQuestion = full.messages.find((m) => m.role === "user")?.content ?? "";
			await Promise.all(
				agents.map(async (a) => {
					let content = "";
					try {
						content = await agentChat(a, keys, [
							{ role: "system", content: `You are ${a.name}. Provide a concise, helpful answer. Keep it under 120 words.` },
							{ role: "user", content: userQuestion },
						]);
					} catch {
						content = `[${a.name}] Proposal for: ${userQuestion}`;
					}
					await addMessage({
						sessionId,
						role: "agent_proposal",
						agentId: a.id,
						content,
						model: a.model ?? null,
						meta: { provider: a.provider, stage: "proposal" },
					});
				})
			);
			const refreshed = await getSessionFull(sessionId);
			const proposals = refreshed.messages.filter((m) => m.role === "agent_proposal");
			// Fallback: if nothing was created (e.g., empty agents table), insert generic proposals
			if (proposals.length === 0) {
				const generic = [
					{ name: "CASPER", content: `[CASPER] Proposal for: ${userQuestion}` },
					{ name: "BALTHASAR", content: `[BALTHASAR] Proposal for: ${userQuestion}` },
					{ name: "MELCHIOR", content: `[MELCHIOR] Proposal for: ${userQuestion}` },
				];
				await Promise.all(
					generic.map((g) =>
						addMessage({
							sessionId,
							role: "agent_proposal",
							agentId: null,
							content: g.content,
							model: null,
							meta: { provider: "synthetic", stage: "proposal" },
						})
					)
				);
			}
			const refreshed2 = await getSessionFull(sessionId);
			const proposals2 = refreshed2.messages.filter((m) => m.role === "agent_proposal");
			return new Response(JSON.stringify({ ok: true, next: "critique", proposals: proposals2 }), {
				status: 200,
				headers: { "Cache-Control": "no-store" },
			});
		}

		if (step === "critique") {
			// Each agent critiques the other proposals
			const proposals = full.messages.filter((m) => m.role === "agent_proposal");
			await Promise.all(
				agents.flatMap((critic) => {
					return proposals
						.filter((p) => p.agent_id !== critic.id)
						.map(async (p) => {
							let critique = "";
							const textForCritique = proposals.find((x) => x.id === p.id)?.content ?? "";
							try {
								critique = await agentChat(critic, keys, [
									{ role: "system", content: `You are ${critic.name}. Provide a brief, constructive critique (1-2 sentences).` },
									{ role: "user", content: `Critique this proposal:\n\n${textForCritique}` },
								]);
							} catch {
								critique = `[${critic.name}] critique of message ${p.id}: consider evidence and clarify assumptions.`;
							}
							await addMessage({
								sessionId,
								role: "agent_critique",
								agentId: critic.id,
								content: critique,
								model: critic.model ?? null,
								meta: { targetMessageId: p.id, stage: "critique" },
							});
						});
				})
			);
			const refreshed = await getSessionFull(sessionId);
			const critiques = refreshed.messages.filter((m) => m.role === "agent_critique");
			return new Response(JSON.stringify({ ok: true, next: "vote", critiques }), {
				status: 200,
				headers: { "Cache-Control": "no-store" },
			});
		}

		if (step === "vote") {
			// Ask each agent to score each proposal 0-100
			const proposals = full.messages.filter((m) => m.role === "agent_proposal");
			await Promise.all(
				agents.flatMap((a) =>
					proposals.map(async (p) => {
						let score = 50;
						let rationale = "";
						try {
							const response = await agentChat(a, keys, [
								{ role: "system", content: `You are ${a.name}. Evaluate the quality, clarity, and factuality of the proposal. Reply ONLY with a JSON object: {"score": 0-100, "reason": "short rationale"}.` },
								{ role: "user", content: `Proposal:\n\n${p.content}\n\nScore it.` },
							]);
							try {
								const j = JSON.parse(response);
								if (typeof j.score === "number") score = Math.max(0, Math.min(100, Math.round(j.score)));
								if (typeof j.reason === "string") rationale = j.reason;
							} catch {
								// Fallback: derive a heuristic
								score = Math.max(30, Math.min(90, Math.round(Math.sqrt(p.content.length))));
								rationale = `${a.name} heuristic score`;
							}
						} catch {
							score = Math.max(30, Math.min(90, Math.round(Math.sqrt(p.content.length))));
							rationale = `${a.name} heuristic score (fallback)`;
						}
						return addVote({
							sessionId,
							agentId: a.id,
							targetMessageId: p.id,
							score,
							rationale,
						});
					})
				)
			);
			const refreshed = await getSessionFull(sessionId);
			return new Response(JSON.stringify({ ok: true, next: "consensus", votes: refreshed.votes }), {
				status: 200,
				headers: { "Cache-Control": "no-store" },
			});
		}

		if (step === "consensus") {
			const fresh = await getSessionFull(sessionId);
			const proposals = fresh.messages.filter((m) => m.role === "agent_proposal");
			const totals = new Map<number, number>();
			for (const v of fresh.votes) {
				totals.set(v.target_message_id, (totals.get(v.target_message_id) || 0) + v.score);
			}
			let best: { msg: MagiMessage; score: number } | null = null;
			for (const p of proposals) {
				const score = totals.get(p.id) || 0;
				if (!best || score > best.score) {
					best = { msg: p, score };
				}
			}
			let finalMessageId: number | null = null;
			if (best) {
				const consensusMsg = await addMessage({
					sessionId,
					role: "consensus" as MagiMessageKind,
					content: best.msg.content,
					agentId: null,
					meta: { fromMessageId: best.msg.id, totalScore: best.score },
				});
				finalMessageId = consensusMsg.id;
				await upsertConsensus({ sessionId, finalMessageId, summary: null });
				await setSessionStatus(sessionId, "consensus");
			} else {
				await setSessionStatus(sessionId, "error", "No proposals available for consensus");
			}
			const refreshed = await getSessionFull(sessionId);
			const finalMessage = refreshed.messages.find((m) => m.id === finalMessageId) || null;
			return new Response(JSON.stringify({ ok: true, finalMessageId, finalMessage }), {
				status: 200,
				headers: { "Cache-Control": "no-store" },
			});
		}

		return new Response(JSON.stringify({ ok: false, error: "Unsupported step" }), { status: 400 });
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


