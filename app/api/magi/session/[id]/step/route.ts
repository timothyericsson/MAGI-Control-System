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
import { canonicalModelFor } from "@/lib/magiModels";
import { buildArtifactContextText } from "@/lib/codeArtifacts";
import { buildLiveUrlContext } from "@/lib/liveSiteContext";
import { performLiveHttpRequest } from "@/lib/liveHttpProxy";
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
httpRequestCount: number;
};

type ChatResultWithHttp = {
content: string;
httpRequests: number;
};

type OpenAIChatMessage = {
role: "system" | "user" | "assistant" | "tool";
content: string | any[];
name?: string;
tool_call_id?: string;
tool_calls?:
| null
| {
id: string;
function: { name: string; arguments: string };
}[];
};

const HTTP_TOOL_NAME = "magi_http_request";
const HTTP_TOOL_DESCRIPTION =
"Forward a cURL-style HTTP request via MAGI's relay so you can inspect live endpoints while auditing.";
const MAX_HTTP_TOOL_CALLS = 5;

const CONTEXT_CHAR_BUDGET = 26_000;
const CONTEXT_ARTIFACT_SHARE = 0.65;
const MIN_ARTIFACT_CHARS = 12_000;
const MIN_LIVE_CHARS = 4_000;

const HTTP_TOOL_PARAMETERS = {
type: "object",
properties: {
url: { type: "string", description: "Absolute http or https URL to fetch." },
method: {
type: "string",
enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
description: "HTTP method to use (defaults to GET).",
},
headers: {
type: "object",
additionalProperties: { type: "string" },
description: "Optional headers to include in the request.",
},
body: {
type: "string",
description: "Optional UTF-8 request body (use for POST/PUT/PATCH).",
},
},
required: ["url"],
};

function normalizeHeaderRecord(candidate: unknown): Record<string, string> | undefined {
if (!candidate || typeof candidate !== "object") return undefined;
const result: Record<string, string> = {};
for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
if (typeof value === "string") {
result[key] = value;
}
}
return Object.keys(result).length ? result : undefined;
}

function formatToolResultPayload(payload: unknown): string {
        return JSON.stringify(payload, null, 2);
}

function trimTextToLength(text: string | null, maxChars: number): { text: string | null; trimmed: boolean } {
        if (!text || text.length <= maxChars) {
                return { text, trimmed: false };
        }
        const sliced = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
        return { text: sliced, trimmed: true };
}

function rebalanceContextBudgets(artifact: string | null, live: string | null) {
        const artifactLen = artifact?.length ?? 0;
        const liveLen = live?.length ?? 0;
        const total = artifactLen + liveLen;
        let artifactTrimmed = false;
        let liveTrimmed = false;
        let artifactResult = artifact;
        let liveResult = live;

        if (artifactResult && liveResult && total > CONTEXT_CHAR_BUDGET) {
                const artifactTarget = Math.max(
                        MIN_ARTIFACT_CHARS,
                        Math.round(CONTEXT_CHAR_BUDGET * CONTEXT_ARTIFACT_SHARE)
                );
                const liveTarget = Math.max(MIN_LIVE_CHARS, CONTEXT_CHAR_BUDGET - artifactTarget);
                const artifactCut = trimTextToLength(artifactResult, artifactTarget);
                const liveCut = trimTextToLength(liveResult, liveTarget);
                artifactResult = artifactCut.text;
                liveResult = liveCut.text;
                artifactTrimmed = artifactCut.trimmed;
                liveTrimmed = liveCut.trimmed;
                return { artifact: artifactResult, live: liveResult, artifactTrimmed, liveTrimmed };
        }

        if (!liveResult && artifactResult && artifactLen > CONTEXT_CHAR_BUDGET) {
                const artifactCut = trimTextToLength(artifactResult, CONTEXT_CHAR_BUDGET);
                artifactResult = artifactCut.text;
                artifactTrimmed = artifactCut.trimmed;
        } else if (!artifactResult && liveResult && liveLen > CONTEXT_CHAR_BUDGET) {
                const liveCut = trimTextToLength(liveResult, CONTEXT_CHAR_BUDGET);
                liveResult = liveCut.text;
                liveTrimmed = liveCut.trimmed;
        }

        return { artifact: artifactResult, live: liveResult, artifactTrimmed, liveTrimmed };
}

async function runHttpToolCall(rawArgs: any): Promise<string> {
const url = typeof rawArgs?.url === "string" ? rawArgs.url : "";
const method = typeof rawArgs?.method === "string" ? rawArgs.method : undefined;
const headers = normalizeHeaderRecord(rawArgs?.headers);
const body = typeof rawArgs?.body === "string" ? rawArgs.body : undefined;
if (!url) {
return formatToolResultPayload({ ok: false, error: "Request requires a url" });
}
try {
const response = await performLiveHttpRequest({ url, method, headers, body });
return formatToolResultPayload({ ok: true, response });
} catch (err: any) {
return formatToolResultPayload({ ok: false, error: err?.message || "Request failed" });
}
}

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

function parseVoteResponse(raw: string | null | undefined): { score?: number | string; reason?: string } | null {
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;

        const tryParse = (candidate: string) => {
                try {
                        const parsed = JSON.parse(candidate);
                        return typeof parsed === "object" && parsed !== null ? (parsed as any) : null;
                } catch (err) {
                        return null;
                }
        };

        const direct = tryParse(trimmed);
        if (direct) return direct;

        const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) {
                const fromFence = tryParse(fenceMatch[1]);
                if (fromFence) return fromFence;
        }

        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                const candidate = trimmed.slice(firstBrace, lastBrace + 1);
                const parsed = tryParse(candidate);
                if (parsed) return parsed;
        }

        return null;
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
messages: OpenAIChatMessage[],
userLabel?: string,
options?: { enableHttpTool?: boolean }
): Promise<ChatResultWithHttp> {
return callOpenAICompatibleChat({
apiKey,
model,
messages,
userLabel,
baseUrl: "https://api.openai.com/v1/chat/completions",
enableHttpTool: options?.enableHttpTool ?? false,
});
}

async function callXAIChat(
apiKey: string,
model: string,
messages: OpenAIChatMessage[],
userLabel?: string,
options?: { enableHttpTool?: boolean }
): Promise<ChatResultWithHttp> {
return callOpenAICompatibleChat({
apiKey,
model,
messages,
userLabel,
baseUrl: "https://api.x.ai/v1/chat/completions",
enableHttpTool: options?.enableHttpTool ?? false,
});
}

async function callOpenAICompatibleChat(params: {
apiKey: string;
model: string;
messages: OpenAIChatMessage[];
userLabel?: string;
baseUrl: string;
enableHttpTool: boolean;
}): Promise<ChatResultWithHttp> {
const { apiKey, model, messages, userLabel, baseUrl, enableHttpTool } = params;
if (!model) {
throw new Error("model not specified");
}
const conversation: OpenAIChatMessage[] = messages.map((m) => ({ ...m }));
let toolCalls = 0;
while (true) {
const payload: Record<string, unknown> = {
model,
messages: conversation,
temperature: 0.3,
};
if (userLabel) payload.user = userLabel;
if (enableHttpTool) {
payload.tools = [
{
type: "function",
function: {
name: HTTP_TOOL_NAME,
description: HTTP_TOOL_DESCRIPTION,
parameters: HTTP_TOOL_PARAMETERS,
},
},
];
}
const res = await fetch(baseUrl, {
method: "POST",
headers: {
Authorization: `Bearer ${apiKey}`,
"Content-Type": "application/json",
},
body: JSON.stringify(payload),
});
if (!res.ok) {
throw new Error(`${baseUrl.includes("x.ai") ? "xai" : "openai"} error ${res.status}`);
}
const data = await res.json();
const choice = data?.choices?.[0];
const message = choice?.message;
if (!message) {
return { content: "", httpRequests: toolCalls };
}
if (enableHttpTool && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
conversation.push(message as OpenAIChatMessage);
for (const call of message.tool_calls) {
if (!call?.function || call.function.name !== HTTP_TOOL_NAME) {
continue;
}
toolCalls += 1;
let args: any = {};
try {
args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
} catch {
args = {};
}
let content = "";
if (toolCalls > MAX_HTTP_TOOL_CALLS) {
content = formatToolResultPayload({ ok: false, error: "HTTP relay tool call limit reached" });
} else {
content = await runHttpToolCall(args);
}
conversation.push({
role: "tool",
content,
tool_call_id: call.id,
});
}
continue;
}
const rawContent = Array.isArray(message.content)
? message.content
.map((part: any) => {
if (typeof part === "string") return part;
if (part && typeof part.text === "string") return part.text;
return "";
})
.filter(Boolean)
.join("\n\n")
: String(message.content ?? "");
const txt = rawContent.trim();
conversation.push({ role: "assistant", content: txt });
return { content: txt, httpRequests: toolCalls };
}
}

async function callAnthropic(
apiKey: string,
model: string | null | undefined,
messages: { role: "user" | "assistant" | "system"; content: string }[],
userLabel?: string,
options?: { enableHttpTool?: boolean }
): Promise<ChatResultWithHttp> {
const resolvedModel = canonicalModelFor("anthropic", model);
const systemPrompt = messages.find((m) => m.role === "system")?.content;
const baseTurns = messages.filter((m) => m.role !== "system").map((m) => ({
role: m.role === "assistant" ? "assistant" : "user",
content: [{ type: "text", text: m.content }],
}));
const conversation: any[] = baseTurns.slice();
const includeTool = options?.enableHttpTool ?? false;
const tools = includeTool
? [
{
name: HTTP_TOOL_NAME,
description: HTTP_TOOL_DESCRIPTION,
input_schema: HTTP_TOOL_PARAMETERS,
},
]
: undefined;
let toolCalls = 0;
while (true) {
const payload: Record<string, unknown> = {
model: resolvedModel,
max_tokens: 400,
messages: conversation,
temperature: 0.3,
};
if (systemPrompt) payload.system = systemPrompt;
if (tools) payload.tools = tools;
if (userLabel) payload.metadata = { user_id: userLabel };
const res = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"x-api-key": apiKey,
"anthropic-version": "2023-06-01",
"Content-Type": "application/json",
},
body: JSON.stringify(payload),
});
if (!res.ok) {
let detail = "";
try {
detail = await res.text();
} catch {
detail = "";
}
const trimmedDetail = detail.trim();
throw new Error(`anthropic error ${res.status}${trimmedDetail ? `: ${trimmedDetail}` : ""}`);
}
const data = await res.json();
const contentBlocks: any[] = Array.isArray(data?.content) ? data.content : [];
conversation.push({ role: "assistant", content: contentBlocks });
if (tools) {
const toolUses = contentBlocks.filter(
(block) => block && block.type === "tool_use" && block.name === HTTP_TOOL_NAME
);
if (toolUses.length > 0) {
for (const toolUse of toolUses) {
toolCalls += 1;
const args = toolUse?.input ?? {};
let content = "";
if (toolCalls > MAX_HTTP_TOOL_CALLS) {
content = formatToolResultPayload({ ok: false, error: "HTTP relay tool call limit reached" });
} else {
content = await runHttpToolCall(args);
}
conversation.push({
role: "user",
content: [
{
type: "tool_result",
tool_use_id: toolUse.id,
content,
},
],
});
}
continue;
}
}
const textBlocks = contentBlocks
.filter((block) => block && block.type === "text" && typeof block.text === "string")
.map((block) => block.text.trim())
.filter(Boolean);
return { content: textBlocks.join("\n\n"), httpRequests: toolCalls };
}
}

async function agentChat(
agent: MagiAgent,
keys: ProviderKeyMap | undefined,
messages: { role: "system" | "user" | "assistant"; content: string }[],
options?: { enableHttpTool?: boolean }
): Promise<AgentChatResult> {
const model = canonicalModelFor(agent.provider, agent.model);

async function invokePrimary(provider: "openai" | "anthropic" | "grok", apiKey: string, label: string) {
if (provider === "openai") {
const result = await withTimeout(
callOpenAIChat(apiKey, model, messages as OpenAIChatMessage[], agent.slug, options),
20000,
label
);
return { content: result.content, providerUsed: "openai" as const, httpRequestCount: result.httpRequests };
}
if (provider === "anthropic") {
const result = await withTimeout(
callAnthropic(apiKey, model, messages as any, agent.slug, options),
20000,
label
);
return { content: result.content, providerUsed: "anthropic" as const, httpRequestCount: result.httpRequests };
}
const result = await withTimeout(
callXAIChat(apiKey, model, messages as OpenAIChatMessage[], agent.slug, options),
20000,
label
);
return { content: result.content, providerUsed: "grok" as const, httpRequestCount: result.httpRequests };
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

		if (!["propose", "vote", "consensus"].includes(step)) {
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
const artifactContextPromise = full.session?.artifact_id
? buildArtifactContextText(full.session.artifact_id, {
question: userQuestion,
maxChars: 24_000,
})
: Promise.resolve(null);
const liveUrlContextPromise = full.session?.live_url
? buildLiveUrlContext(full.session.live_url)
: Promise.resolve(null);
const [artifactContextResult, liveUrlContextRaw] = await Promise.all([
artifactContextPromise,
liveUrlContextPromise,
]);
let artifactContext = artifactContextResult?.text ?? null;
let liveUrlContext = liveUrlContextRaw;
if (artifactContextResult) {
stageEvents.push(
`Artifact context (~${artifactContextResult.approxTokens.toLocaleString()} tokens from ${artifactContextResult.fileCount} files)`
);
if (artifactContextResult.truncated) {
stageEvents.push("Artifact context truncated to stay under prompt budget");
}
}
const trimmedContext = rebalanceContextBudgets(artifactContext, liveUrlContext);
artifactContext = trimmedContext.artifact;
liveUrlContext = trimmedContext.live;
if (trimmedContext.artifactTrimmed && artifactContext) {
stageEvents.push(`Artifact context trimmed to ${artifactContext.length.toLocaleString()} chars`);
}
if (trimmedContext.liveTrimmed && liveUrlContext) {
stageEvents.push(`Live snapshot trimmed to ${liveUrlContext.length.toLocaleString()} chars`);
}
                        for (const a of agents) {
                                let chatResult: AgentChatResult | null = null;
                                try {
const systemPrompts = [
`You are ${a.name}. Provide a concise, security-focused audit response. Highlight high-risk vulnerabilities, abuse cases, and hardening steps. Keep it under 160 words.`,
];
                                        if (artifactContext) {
                                                systemPrompts.push(
                                                        "Repository context:\n" +
                                                                artifactContext +
                                                                "\n\nYour findings must reference file paths and explain why each issue is risky."
                                                );
                                        } else {
                                                systemPrompts.push("Reference concrete code risks where possible.");
                                        }
if (liveUrlContext) {
systemPrompts.push(
"Live URL probe results:\n" +
liveUrlContext +
"\n\nIncorporate any exposed endpoints, headers, or responses into the audit."
);
}
systemPrompts.push(
"You can issue additional HTTP requests using the MAGI curl tool whenever you need to inspect a live endpoint. Always summarize what you learned from each probe."
);
chatResult = await agentChat(a, keys, [
{ role: "system", content: systemPrompts.join("\n\n") },
{ role: "user", content: userQuestion },
], { enableHttpTool: true });
                                } catch (err: any) {
                                        const message = err?.message || "unknown error";
                                        stageEvents.push(`[${a.name}] proposal failed: ${message}`);
                                        await setSessionStatus(sessionId, "error", `${a.name} proposal failed`);
                                        throw new Error(`${a.name} proposal failed: ${message}`);
                                }

                                const actualProvider = chatResult?.providerUsed ?? a.provider;
                                const content = chatResult?.content?.trim() ?? "";

                                if (!content) {
                                        stageEvents.push(`[${a.name}] proposal failed: empty response`);
                                        await setSessionStatus(sessionId, "error", `${a.name} proposal returned empty response`);
                                        throw new Error(`${a.name} proposal returned empty response`);
                                }

const meta: Record<string, unknown> = {
provider: a.provider,
stage: "proposal",
fallback: false,
actualProvider,
httpRequestCount: chatResult?.httpRequestCount ?? 0,
};
                                const message = await addMessage({
                                        sessionId,
                                        role: "agent_proposal",
                                        agentId: a.id,
                                        content,
                                        model: a.model ?? null,
                                        meta,
                                });
                                stageEvents.push(`[${a.name}] proposal stored as #${message.id} via ${actualProvider}`);
                        }
                        const refreshedState = await getSessionFull(sessionId);
                        const proposals = refreshedState.messages.filter((m) => m.role === "agent_proposal");
                        stageEvents.push(`Total proposals recorded: ${proposals.length}`);
                        const diagnostics = buildDiagnostics({
                                step: "propose",
                                agents,
                                messages: refreshedState.messages,
                                votes: refreshedState.votes,
                                events: stageEvents,
                        });
                        return new Response(JSON.stringify({ ok: true, next: "vote", proposals, diagnostics }), {
                                status: 200,
                                headers: { "Cache-Control": "no-store" },
                        });
                }

                // Critique step removed: proceed directly from proposals to voting

                if (step === "vote") {
                        const stageEvents: string[] = [];
                        const proposals = full.messages.filter((m) => m.role === "agent_proposal");
                        await Promise.all(
                                agents.flatMap((a) => {
                                        const targetableProposals = proposals.filter((p) => p.agent_id !== a.id);
                                        if (targetableProposals.length === 0) {
                                                stageEvents.push(`[${a.name}] skipped voting: no other proposals available`);
                                                return [] as Promise<unknown>[];
                                        }
                                        return targetableProposals.map(async (p) => {
                                                let score = 50;
                                                let rationale = "";
                                                let fallbackUsed = false;
                                                try {
                                                        const chatResult = await agentChat(a, keys, [
                                                                { role: "system", content: `You are ${a.name}. Evaluate the proposal's quality, clarity, factuality, risks, and tradeoffs. Provide a detailed rationale of at least 3 sentences, referencing specifics. Reply ONLY with a JSON object: {"score": 0-100, "reason": "detailed rationale"}.` },
                                                                { role: "user", content: `Proposal:\n\n${p.content}\n\nScore it.` },
                                                        ]);
                                                        const parsed = parseVoteResponse(chatResult.content);
                                                        if (parsed) {
                                                                if (typeof parsed.score === "number") {
                                                                        score = Math.max(0, Math.min(100, Math.round(parsed.score)));
                                                                } else if (typeof parsed.score === "string") {
                                                                        const parsedScore = Number(parsed.score);
                                                                        if (Number.isFinite(parsedScore)) {
                                                                                score = Math.max(0, Math.min(100, Math.round(parsedScore)));
                                                                        }
                                                                }
                                                                if (typeof parsed.reason === "string" && parsed.reason.trim()) {
                                                                        rationale = parsed.reason.trim();
                                                                }
                                                        } else {
                                                                fallbackUsed = true;
                                                                stageEvents.push(`[${a.name}] vote JSON parse fallback for proposal #${p.id}: unable to parse structured vote`);
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
                                        });
                                })
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
                                await upsertConsensus({ sessionId, finalMessageId, summary: best.msg.content });
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


