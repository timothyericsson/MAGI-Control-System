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
import { DEFAULT_MODELS, canonicalModelFor } from "@/lib/magiModels";
import type {
        MagiAgent,
        MagiMessage,
        MagiMessageKind,
        MagiStepDiagnostics,
        MagiVote,
        MagiWorkflowStep,
        StepRequestBody,
} from "@/lib/magiTypes";

type ProviderKeyMap = { openai?: string; anthropic?: string; grok?: string; xai?: string };

type AgentChatResult = {
        content: string;
        providerUsed: "openai" | "anthropic" | "grok";
};

function keyForAgent(agent: MagiAgent, keys?: ProviderKeyMap): string | undefined {
        if (!keys) return undefined;
        if (agent.provider === "openai") return keys.openai;
        if (agent.provider === "anthropic") return keys.anthropic;
        if (agent.provider === "grok") return keys.grok ?? keys.xai;
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

function previewText(content: string, maxLength = 120): string {
        const normalized = content.replace(/\s+/g, " ").trim();
        if (normalized.length <= maxLength) return normalized;
        return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
        if (!meta || typeof meta !== "object") return {};
        return meta as Record<string, unknown>;
}

function readMetaNumber(meta: Record<string, unknown>, key: string): number | null {
        const raw = meta[key];
        if (typeof raw === "number" && Number.isFinite(raw)) return raw;
        if (typeof raw === "string") {
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed)) return parsed;
        }
        return null;
}

function readMetaBoolean(meta: Record<string, unknown>, key: string): boolean {
        const raw = meta[key];
        if (typeof raw === "boolean") return raw;
        if (typeof raw === "number") return raw !== 0;
        if (typeof raw === "string") {
                const lowered = raw.toLowerCase();
                return lowered === "true" || lowered === "1" || lowered === "yes";
        }
        return false;
}

function buildDiagnostics(params: {
        step: MagiWorkflowStep;
        agents: MagiAgent[];
        messages: MagiMessage[];
        votes: MagiVote[];
        events: string[];
        winning?: { id: number; score: number } | null;
        consensusMessageId?: number | null;
}): MagiStepDiagnostics {
        const proposals = params.messages.filter((m) => m.role === "agent_proposal");
        const critiques = params.messages.filter((m) => m.role === "agent_critique");
        const consensusMessages = params.messages.filter((m) => m.role === "consensus");

        const perAgent = params.agents.map((agent) => {
                const authoredProposals = proposals.filter((m) => m.agent_id === agent.id);
                const authoredCritiques = critiques.filter((m) => m.agent_id === agent.id);
                const agentVotes = params.votes.filter((v) => v.agent_id === agent.id);
                const proposalIds = new Set(authoredProposals.map((p) => p.id));
                const critiquesReceived = critiques.filter((c) => {
                        const meta = normalizeMeta(c.meta);
                        const targetId = readMetaNumber(meta, "targetMessageId");
                        return targetId !== null && proposalIds.has(targetId);
                });

                const proposalSummaries = authoredProposals.map((p) => {
                        const meta = normalizeMeta(p.meta);
                        return {
                                id: p.id,
                                fallback: readMetaBoolean(meta, "fallback"),
                                preview: previewText(p.content),
                        };
                });
                const critiqueSummaries = authoredCritiques.map((c) => {
                        const meta = normalizeMeta(c.meta);
                        return {
                                id: c.id,
                                targetMessageId: readMetaNumber(meta, "targetMessageId"),
                                fallback: readMetaBoolean(meta, "fallback"),
                                preview: previewText(c.content),
                        };
                });
                const critiqueReceivedSummaries = critiquesReceived.map((c) => {
                        const meta = normalizeMeta(c.meta);
                        return {
                                id: c.id,
                                targetMessageId: readMetaNumber(meta, "targetMessageId"),
                                fallback: readMetaBoolean(meta, "fallback"),
                                preview: previewText(c.content),
                        };
                });
                const voteSummaries = agentVotes.map((v) => {
                        const rationale = v.rationale ?? null;
                        const fallback = typeof rationale === "string" && rationale.toLowerCase().includes("heuristic");
                        const rawScore = (v as unknown as { score: number | string | null | undefined }).score;
                        const parsedScore =
                                typeof rawScore === "number"
                                        ? rawScore
                                        : typeof rawScore === "string"
                                                ? Number(rawScore)
                                                : null;
                        const score =
                                typeof parsedScore === "number" && Number.isFinite(parsedScore) ? parsedScore : 0;
                        return {
                                id: v.id,
                                targetMessageId: v.target_message_id,
                                score,
                                rationale,
                                fallback,
                        };
                });

                const fallbackCount =
                        proposalSummaries.filter((p) => p.fallback).length +
                        critiqueSummaries.filter((c) => c.fallback).length +
                        voteSummaries.filter((v) => v.fallback).length;

                return {
                        agentId: agent.id,
                        name: agent.name,
                        provider: agent.provider,
                        proposals: proposalSummaries,
                        critiquesAuthored: critiqueSummaries,
                        critiquesReceived: critiqueReceivedSummaries,
                        votesCast: voteSummaries,
                        fallbackCount,
                };
        });

        const diagnostics: MagiStepDiagnostics = {
                step: params.step,
                timestamp: new Date().toISOString(),
                totals: {
                        proposals: proposals.length,
                        critiques: critiques.length,
                        votes: params.votes.length,
                        consensus: consensusMessages.length,
                },
                agents: perAgent,
                events: params.events.slice(),
        };

        if (params.winning) {
                diagnostics.winningProposalId = params.winning.id;
                diagnostics.winningScore = params.winning.score;
        }
        if (typeof params.consensusMessageId !== "undefined") {
                diagnostics.consensusMessageId = params.consensusMessageId;
        }

        return diagnostics;
}

async function callOpenAIChat(
        apiKey: string,
        model: string,
        messages: { role: string; content: string }[],
        userLabel?: string
): Promise<string> {
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
                        ...(userLabel ? { user: userLabel } : {}),
                }),
        });
        if (!res.ok) throw new Error(`openai error ${res.status}`);
        const data = await res.json();
        const txt = data?.choices?.[0]?.message?.content ?? "";
        return String(txt).trim();
}

async function callXAIChat(
        apiKey: string,
        model: string,
        messages: { role: string; content: string }[],
        userLabel?: string
): Promise<string> {
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
                        ...(userLabel ? { user: userLabel } : {}),
                }),
        });
        if (!res.ok) throw new Error(`xai error ${res.status}`);
        const data = await res.json();
        const txt = data?.choices?.[0]?.message?.content ?? "";
        return String(txt).trim();
}

async function callAnthropic(
        apiKey: string,
        model: string | null | undefined,
        messages: { role: "user" | "assistant" | "system"; content: string }[],
        userLabel?: string
): Promise<string> {
        const resolvedModel = canonicalModelFor("anthropic", model);
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
                        model: resolvedModel || DEFAULT_MODELS.anthropic,
                        max_tokens: 400,
                        system: sys,
                        messages: userTurns,
                        temperature: 0.3,
                        ...(userLabel ? { metadata: { user_id: userLabel } } : {}),
                }),
        });
        if (!res.ok) {
                let detail = "";
                try {
                        detail = await res.text();
                } catch {
                        detail = "";
                }
                if (res.status === 404 && resolvedModel !== DEFAULT_MODELS.anthropic) {
                        return callAnthropic(apiKey, DEFAULT_MODELS.anthropic, messages, userLabel);
                }
                const trimmedDetail = detail.trim();
                throw new Error(`anthropic error ${res.status}${trimmedDetail ? `: ${trimmedDetail}` : ""}`);
        }
        const data = await res.json();
        const textBlocks = Array.isArray(data?.content)
                ? data.content.filter(
                          (block: any) =>
                                  block &&
                                  typeof block === "object" &&
                                  block.type === "text" &&
                                  typeof block.text === "string"
                  )
                : [];
        const combinedText = textBlocks.map((block: any) => block.text.trim()).filter(Boolean).join("\n\n");
        return combinedText || "";
}

async function agentChat(
        agent: MagiAgent,
        keys: ProviderKeyMap | undefined,
        messages: { role: "system" | "user" | "assistant"; content: string }[]
): Promise<AgentChatResult> {
        const model = canonicalModelFor(agent.provider, agent.model);

        async function invokePrimary(provider: "openai" | "anthropic" | "grok", apiKey: string, label: string) {
                if (provider === "openai") {
                        const txt = await withTimeout(callOpenAIChat(apiKey, model, messages, agent.slug), 20000, label);
                        return { content: txt, providerUsed: "openai" as const };
                }
                if (provider === "anthropic") {
                        const txt = await withTimeout(
                                callAnthropic(apiKey, model, messages as any, agent.slug),
                                20000,
                                label
                        );
                        return { content: txt, providerUsed: "anthropic" as const };
                }
                const txt = await withTimeout(callXAIChat(apiKey, model, messages, agent.slug), 20000, label);
                return { content: txt, providerUsed: "grok" as const };
        }

        const primaryKey = keyForAgent(agent, keys);
        let primaryError: Error | null = null;

        if (primaryKey) {
                try {
                        return await invokePrimary(agent.provider, primaryKey, agent.provider);
                } catch (err: any) {
                        primaryError = err instanceof Error ? err : new Error(String(err));
                }
        } else {
                primaryError = new Error(`Missing key for ${agent.provider}`);
        }

        throw primaryError ?? new Error(`Unable to reach ${agent.name}`);
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
                        const stageEvents: string[] = [];
                        const userQuestion = full.messages.find((m) => m.role === "user")?.content ?? "";
                        await Promise.all(
                                agents.map(async (a) => {
                                        let content = "";
                                        let fallbackUsed = false;
                                        let chatResult: AgentChatResult | null = null;
                                        try {
                                                chatResult = await agentChat(a, keys, [
                                                        { role: "system", content: `You are ${a.name}. Provide a concise, helpful answer. Keep it under 120 words.` },
                                                        { role: "user", content: userQuestion },
                                                ]);
                                                content = chatResult.content;
                                                if (!content) {
                                                        fallbackUsed = true;
                                                        stageEvents.push(`[${a.name}] proposal empty response; using fallback text.`);
                                                        content = `[${a.name}] Proposal for: ${userQuestion}`;
                                                }
                                        } catch (err: any) {
                                                fallbackUsed = true;
                                                stageEvents.push(`[${a.name}] proposal fallback: ${err?.message || "unknown error"}`);
                                                content = `[${a.name}] Proposal for: ${userQuestion}`;
                                        }
                                        const actualProvider = chatResult?.providerUsed ?? a.provider;
                                        const meta: Record<string, unknown> = {
                                                provider: a.provider,
                                                stage: "proposal",
                                                fallback: fallbackUsed,
                                                actualProvider,
                                        };
                                        const message = await addMessage({
                                                sessionId,
                                                role: "agent_proposal",
                                                agentId: a.id,
                                                content,
                                                model: a.model ?? null,
                                                meta,
                                        });
                                        stageEvents.push(
                                                `[${a.name}] proposal stored as #${message.id} via ${actualProvider}${fallbackUsed ? " (fallback)" : ""}`
                                        );
                                })
                        );
                        let refreshedState = await getSessionFull(sessionId);
                        let proposals = refreshedState.messages.filter((m) => m.role === "agent_proposal");
                        if (proposals.length === 0) {
                                stageEvents.push("No proposals generated from agents; inserting synthetic fallbacks.");
                                const generic = [
                                        { name: "CASPER", content: `[CASPER] Proposal for: ${userQuestion}` },
                                        { name: "BALTHASAR", content: `[BALTHASAR] Proposal for: ${userQuestion}` },
                                        { name: "MELCHIOR", content: `[MELCHIOR] Proposal for: ${userQuestion}` },
                                ];
                                await Promise.all(
                                        generic.map(async (g) => {
                                                const message = await addMessage({
                                                        sessionId,
                                                        role: "agent_proposal",
                                                        agentId: null,
                                                        content: g.content,
                                                        model: null,
                                                        meta: { provider: "synthetic", stage: "proposal", fallback: true },
                                                });
                                                stageEvents.push(`[synthetic] ${g.name} proposal stored as #${message.id} (fallback)`);
                                        })
                                );
                                refreshedState = await getSessionFull(sessionId);
                                proposals = refreshedState.messages.filter((m) => m.role === "agent_proposal");
                        }
                        stageEvents.push(`Total proposals recorded: ${proposals.length}`);
                        const diagnostics = buildDiagnostics({
                                step: "propose",
                                agents,
                                messages: refreshedState.messages,
                                votes: refreshedState.votes,
                                events: stageEvents,
                        });
                        return new Response(JSON.stringify({ ok: true, next: "critique", proposals, diagnostics }), {
                                status: 200,
                                headers: { "Cache-Control": "no-store" },
                        });
                }

                if (step === "critique") {
                        const stageEvents: string[] = [];
                        const proposals = full.messages.filter((m) => m.role === "agent_proposal");
                        await Promise.all(
                                agents.flatMap((critic) => {
                                        return proposals
                                                .filter((p) => p.agent_id !== critic.id)
                                                .map(async (p) => {
                                                        let critique = "";
                                                        let fallbackUsed = false;
                                                        let chatResult: AgentChatResult | null = null;
                                                        const textForCritique = proposals.find((x) => x.id === p.id)?.content ?? "";
                                                        try {
                                                                chatResult = await agentChat(critic, keys, [
                                                                        { role: "system", content: `You are ${critic.name}. Provide a brief, constructive critique (1-2 sentences).` },
                                                                        { role: "user", content: `Critique this proposal:\n\n${textForCritique}` },
                                                                ]);
                                                                critique = chatResult.content;
                                                                if (!critique) {
                                                                        fallbackUsed = true;
                                                                        stageEvents.push(`[${critic.name}] critique empty for proposal #${p.id}; using fallback text.`);
                                                                        critique = `[${critic.name}] critique of message ${p.id}: consider evidence and clarify assumptions.`;
                                                                }
                                                        } catch (err: any) {
                                                                fallbackUsed = true;
                                                                stageEvents.push(`[${critic.name}] critique fallback for proposal #${p.id}: ${err?.message || "unknown error"}`);
                                                                critique = `[${critic.name}] critique of message ${p.id}: consider evidence and clarify assumptions.`;
                                                        }
                                                        const actualProvider = chatResult?.providerUsed ?? critic.provider;
                                                        const meta: Record<string, unknown> = {
                                                                targetMessageId: p.id,
                                                                stage: "critique",
                                                                fallback: fallbackUsed,
                                                                actualProvider,
                                                        };
                                                        const message = await addMessage({
                                                                sessionId,
                                                                role: "agent_critique",
                                                                agentId: critic.id,
                                                                content: critique,
                                                                model: critic.model ?? null,
                                                                meta,
                                                        });
                                                        stageEvents.push(
                                                                `[${critic.name}] critique stored as #${message.id} targeting proposal #${p.id} via ${actualProvider}${fallbackUsed ? " (fallback)" : ""}`
                                                        );
                                                });
                                })
                        );
                        const refreshed = await getSessionFull(sessionId);
                        const critiques = refreshed.messages.filter((m) => m.role === "agent_critique");
                        stageEvents.push(`Total critiques recorded: ${critiques.length}`);
                        const diagnostics = buildDiagnostics({
                                step: "critique",
                                agents,
                                messages: refreshed.messages,
                                votes: refreshed.votes,
                                events: stageEvents,
                        });
                        return new Response(JSON.stringify({ ok: true, next: "vote", critiques, diagnostics }), {
                                status: 200,
                                headers: { "Cache-Control": "no-store" },
                        });
                }

                if (step === "vote") {
                        const stageEvents: string[] = [];
                        const proposals = full.messages.filter((m) => m.role === "agent_proposal");
                        await Promise.all(
                                agents.flatMap((a) =>
                                        proposals.map(async (p) => {
                                                let score = 50;
                                                let rationale = "";
                                                let fallbackUsed = false;
                                                try {
                                                        const chatResult = await agentChat(a, keys, [
                                                                { role: "system", content: `You are ${a.name}. Evaluate the quality, clarity, and factuality of the proposal. Reply ONLY with a JSON object: {"score": 0-100, "reason": "short rationale"}.` },
                                                                { role: "user", content: `Proposal:\n\n${p.content}\n\nScore it.` },
                                                        ]);
                                                        try {
                                                                const j = JSON.parse(chatResult.content);
                                                                if (typeof j.score === "number") score = Math.max(0, Math.min(100, Math.round(j.score)));
                                                                if (typeof j.reason === "string") rationale = j.reason;
                                                        } catch (parseErr: any) {
                                                                fallbackUsed = true;
                                                                stageEvents.push(`[${a.name}] vote JSON parse fallback for proposal #${p.id}: ${parseErr?.message || "invalid JSON"}`);
                                                                score = Math.max(30, Math.min(90, Math.round(Math.sqrt(p.content.length))));
                                                                rationale = `${a.name} heuristic score`;
                                                        }
                                                } catch (err: any) {
                                                        fallbackUsed = true;
                                                        stageEvents.push(`[${a.name}] vote fallback for proposal #${p.id}: ${err?.message || "unknown error"}`);
                                                        score = Math.max(30, Math.min(90, Math.round(Math.sqrt(p.content.length))));
                                                        rationale = `${a.name} heuristic score (fallback)`;
                                                }
                                                const voteRecord = await addVote({
                                                        sessionId,
                                                        agentId: a.id,
                                                        targetMessageId: p.id,
                                                        score,
                                                        rationale,
                                                });
                                                stageEvents.push(`[${a.name}] scored proposal #${p.id} = ${score}${fallbackUsed ? " (fallback)" : ""}`);
                                                return voteRecord;
                                        })
                                )
                        );
                        const refreshed = await getSessionFull(sessionId);
                        stageEvents.push(`Total votes recorded: ${refreshed.votes.length}`);
                        const diagnostics = buildDiagnostics({
                                step: "vote",
                                agents,
                                messages: refreshed.messages,
                                votes: refreshed.votes,
                                events: stageEvents,
                        });
                        return new Response(JSON.stringify({ ok: true, next: "consensus", votes: refreshed.votes, diagnostics }), {
                                status: 200,
                                headers: { "Cache-Control": "no-store" },
                        });
                }

                if (step === "consensus") {
                        const stageEvents: string[] = [];
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
                                        meta: { fromMessageId: best.msg.id, totalScore: best.score, stage: "consensus" },
                                });
                                finalMessageId = consensusMsg.id;
                                stageEvents.push(
                                        `Consensus selected proposal #${best.msg.id} (score ${best.score}) as message #${consensusMsg.id}`
                                );
                                await upsertConsensus({ sessionId, finalMessageId, summary: null });
                                await setSessionStatus(sessionId, "consensus");
                        } else {
                                stageEvents.push("Consensus failed: no proposals available.");
                                await setSessionStatus(sessionId, "error", "No proposals available for consensus");
                        }
                        const refreshed = await getSessionFull(sessionId);
                        const finalMessage = refreshed.messages.find((m) => m.id === finalMessageId) || null;
                        const diagnostics = buildDiagnostics({
                                step: "consensus",
                                agents,
                                messages: refreshed.messages,
                                votes: refreshed.votes,
                                events: stageEvents,
                                winning: best ? { id: best.msg.id, score: best.score } : null,
                                consensusMessageId: finalMessageId,
                        });
                        return new Response(JSON.stringify({ ok: true, finalMessageId, finalMessage, diagnostics }), {
                                status: 200,
                                headers: { "Cache-Control": "no-store" },
                        });
                }

		return new Response(JSON.stringify({ ok: false, error: "Unsupported step" }), { status: 400 });
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || "Unexpected error" }), { status: 500 });
	}
}


