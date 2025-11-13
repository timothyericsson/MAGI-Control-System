"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "classnames";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { safeLoad } from "@/lib/localStore";
import type {
        MagiAgent,
        MagiConsensus,
        MagiMessage,
        MagiSession,
        MagiStepDiagnostics,
        MagiVote,
} from "@/lib/magiTypes";

function normalizeVoteScores(raw: MagiVote[] | null | undefined): MagiVote[] {
        if (!Array.isArray(raw)) return [];
        return raw.map((vote) => {
                const rawScore = (vote as unknown as { score: number | string | null | undefined }).score;
                const parsedScore =
                        typeof rawScore === "number"
                                ? rawScore
                                : typeof rawScore === "string"
                                        ? Number(rawScore)
                                        : null;
                const safeScore =
                        typeof parsedScore === "number" && Number.isFinite(parsedScore) ? parsedScore : 0;
                return safeScore === (vote as unknown as { score: number }).score
                        ? vote
                        : { ...vote, score: safeScore };
        });
}

type Step = "idle" | "creating" | "proposing" | "critiquing" | "voting" | "finalizing" | "done" | "error";

export default function MagiConsensusControl() {
	const [question, setQuestion] = useState("");
        const [step, setStep] = useState<Step>("idle");
        const [error, setError] = useState<string | null>(null);
        const [session, setSession] = useState<MagiSession | null>(null);
        const [messages, setMessages] = useState<MagiMessage[]>([]);
        const [consensus, setConsensus] = useState<MagiConsensus | null>(null);
        const [agents, setAgents] = useState<MagiAgent[]>([]);
        const [debug, setDebug] = useState<string | null>(null);
        // Local display buffers to avoid UI depending on DB read latency
        const [displayProposals, setDisplayProposals] = useState<MagiMessage[]>([]);
        const [displayCritiques, setDisplayCritiques] = useState<MagiMessage[]>([]);
        const [displayFinal, setDisplayFinal] = useState<MagiMessage | null>(null);
        const [votes, setVotes] = useState<MagiVote[]>([]);
        const [diagnostics, setDiagnostics] = useState<MagiStepDiagnostics[]>([]);

	const [verifiedAll, setVerifiedAll] = useState<boolean>(false);
	useEffect(() => {
		// Re-check on mount and when storage changes
		function compute() {
			const a = safeLoad("magi_provider_openai_verified");
			const b = safeLoad("magi_provider_anthropic_verified");
			const c = safeLoad("magi_provider_grok_verified");
			setVerifiedAll(Boolean(a && b && c));
		}
		compute();
		const i = setInterval(compute, 1000);
		return () => clearInterval(i);
	}, []);

        const getKeys = useCallback(() => {
                return {
                        openai: safeLoad("magi_provider_openai_api_key") || undefined,
                        anthropic: safeLoad("magi_provider_anthropic_api_key") || undefined,
                        grok: safeLoad("magi_provider_grok_api_key") || undefined,
                        xai: safeLoad("magi_provider_grok_api_key") || safeLoad("magi_provider_xai_api_key") || undefined,
                };
        }, []);

        const formatDiagnosticSummary = useCallback((diag: MagiStepDiagnostics) => {
                const agentSummary =
                        diag.agents
                                .map((a) => {
                                        const proposals = a.proposals.map((p) => `#${p.id}${p.fallback ? "*" : ""}`).join(", ") || "—";
                                        const critiques = a.critiquesAuthored
                                                .map((c) => `#${c.id}${c.fallback ? "*" : ""}`)
                                                .join(", ") || "—";
                                        const votes =
                                                a.votesCast
                                                        .map((v) => {
                                                                const score =
                                                                        typeof v.score === "number"
                                                                                ? v.score
                                                                                : Number(v.score) || 0;
                                                                return `#${v.targetMessageId}:${score}${v.fallback ? "*" : ""}`;
                                                        })
                                                        .join(", ") || "—";
                                        return `${a.name} P:${proposals} C:${critiques} V:${votes}`;
                                })
                                .join(" | ") || "—";
                const extras: string[] = [];
                if (typeof diag.winningProposalId === "number") {
                        const score = typeof diag.winningScore === "number" ? `(${diag.winningScore})` : "";
                        extras.push(`winner=#${diag.winningProposalId}${score}`);
                }
                if (typeof diag.consensusMessageId === "number") {
                        extras.push(`consensus=#${diag.consensusMessageId}`);
                }
                const extraStr = extras.length > 0 ? ` ${extras.join(" ")}` : "";
                return `step=${diag.step} proposals=${diag.totals.proposals} critiques=${diag.totals.critiques} votes=${diag.totals.votes} consensus=${diag.totals.consensus}${extraStr} :: ${agentSummary}`;
        }, []);

        const fetchFull = useCallback(async (sessionId: string) => {
                const res = await fetch(`/api/magi/session/${sessionId}?t=${Date.now()}`, { cache: "no-store" });
                const data = await res.json();
                if (!data.ok) throw new Error(data.error || "Failed to fetch session");
                setSession(data.session);
                setMessages(data.messages || []);
                setConsensus(data.consensus || null);
                setAgents(data.agents || []);
                setVotes(normalizeVoteScores(data.votes as MagiVote[] | undefined));
		// Update display buffers from fetched data if not already present
		const fetchedProposals: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_proposal");
		const fetchedCritiques: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_critique");
		const fetchedFinal: MagiMessage | undefined = (data.messages || []).find((m: MagiMessage) => m.role === "consensus");
		if (fetchedProposals.length > 0) setDisplayProposals(fetchedProposals);
		if (fetchedCritiques.length > 0) setDisplayCritiques(fetchedCritiques);
		if (fetchedFinal) setDisplayFinal(fetchedFinal);
	}, []);

        const fetchFullRaw = useCallback(async (sessionId: string) => {
                const res = await fetch(`/api/magi/session/${sessionId}?t=${Date.now()}`, { cache: "no-store" });
                return res.json();
        }, []);

        const waitFor = useCallback(
                async (sessionId: string, predicate: (payload: any) => boolean, label: string, timeoutMs = 15000, intervalMs = 300) => {
                        const start = Date.now();
                        while (Date.now() - start < timeoutMs) {
                                const data = await fetchFullRaw(sessionId);
                                if (data?.ok) {
                                        // keep UI in sync while waiting
				setSession(data.session);
				setMessages(data.messages || []);
				setConsensus(data.consensus || null);
				setAgents(data.agents || []);
				if (predicate(data)) {
					return true;
				}
			}
			await new Promise((r) => setTimeout(r, intervalMs));
                        }
                        setError(`${label} timed out. Please try again.`);
                        setStep("error");
                        return false;
                },
                [fetchFullRaw]
        );

        const runStep = useCallback(async (sessionId: string, s: "propose" | "critique" | "vote" | "consensus") => {
                const keys = getKeys();
                const res = await fetch(`/api/magi/session/${sessionId}/step`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ step: s, keys }),
                });
		const data = await res.json();
		if (!data.ok) throw new Error(data.error || `Step ${s} failed`);
		// Optimistically merge any returned artifacts so UI reflects immediately
		setMessages((prev) => {
			let next = prev.slice();
			if (Array.isArray(data.proposals)) {
				next = next.concat(data.proposals as MagiMessage[]);
				setDisplayProposals(data.proposals as MagiMessage[]);
			}
			if (Array.isArray(data.critiques)) {
				next = next.concat(data.critiques as MagiMessage[]);
				setDisplayCritiques(data.critiques as MagiMessage[]);
			}
			if (data.finalMessage) {
				next = next.concat([data.finalMessage as MagiMessage]);
				setDisplayFinal(data.finalMessage as MagiMessage);
			}
			return next;
                });
                if (Array.isArray(data.votes)) setVotes(normalizeVoteScores(data.votes as MagiVote[]));
                if (data.diagnostics) {
                        const diagArray = Array.isArray(data.diagnostics)
                                ? (data.diagnostics as MagiStepDiagnostics[])
                                : [data.diagnostics as MagiStepDiagnostics];
                        setDiagnostics((prev) => [...prev, ...diagArray]);
                        const last = diagArray[diagArray.length - 1];
                        setDebug(formatDiagnosticSummary(last));
                } else {
                        setDebug(
                                `step=${s} proposals=${Array.isArray(data.proposals) ? data.proposals.length : 0} critiques=${Array.isArray(data.critiques) ? data.critiques.length : 0} votes=${Array.isArray(data.votes) ? data.votes.length : 0} final=${data.finalMessage ? 1 : 0}`
                        );
                }
                // Always follow with a fresh pull in case there are additional rows (votes, etc.)
                await fetchFull(sessionId);
                // And a brief delayed refresh to avoid any replication lag
                setTimeout(() => fetchFull(sessionId), 150);
                return data;
        }, [fetchFull, formatDiagnosticSummary, getKeys]);

        const onRun = useCallback(async () => {
                setError(null);
                // reset view for a clean run
                setSession(null);
                setMessages([]);
                setConsensus(null);
                setAgents([]);
                setDisplayProposals([]);
                setDisplayCritiques([]);
                setDisplayFinal(null);
                setVotes([]);
                setDiagnostics([]);
                setDebug(null);
                if (!supabaseBrowser) {
                        setError("Auth not initialized");
                        return;
                }
		if (!verifiedAll) {
			setError("All three providers must be linked first.");
			return;
		}
		const q = question.trim();
		if (!q) {
			setError("Please enter a question.");
			return;
		}
		try {
			setStep("creating");
			const { data: auth } = await supabaseBrowser.auth.getSession();
			const userId = auth.session?.user?.id;
			if (!userId) {
				setError("You must be signed in.");
				setStep("error");
				return;
			}
                        const keys = getKeys();
                        const createRes = await fetch("/api/magi/session", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ question: q, userId, keys }),
                        });
			const created = await createRes.json();
			if (!created.ok) {
				throw new Error(created.error || "Failed to create session");
			}
			const sessionId: string = created.sessionId;
			await fetchFull(sessionId);

                        setStep("proposing");
                        const proposeData = await runStep(sessionId, "propose");
                        const returnedProposals = Array.isArray(proposeData?.proposals) ? proposeData.proposals.length : 0;
                        if (returnedProposals === 0) {
                                const okProposals = await waitFor(
                                        sessionId,
                                        (d) => Array.isArray(d?.messages) && d.messages.some((m: any) => m.role === "agent_proposal"),
                                        "Proposals"
                                );
                                if (!okProposals) return;
                        }

                        setStep("critiquing");
                        const critiqueData = await runStep(sessionId, "critique");
                        const returnedCritiques = Array.isArray(critiqueData?.critiques) ? critiqueData.critiques.length : 0;
                        if (returnedCritiques === 0) {
                                const okCritiques = await waitFor(
                                        sessionId,
                                        (d) => Array.isArray(d?.messages) && d.messages.some((m: any) => m.role === "agent_critique"),
                                        "Critiques"
                                );
                                if (!okCritiques) return;
                        }

                        setStep("voting");
                        const voteData = await runStep(sessionId, "vote");
                        const returnedVotes = Array.isArray(voteData?.votes) ? voteData.votes.length : 0;
                        if (returnedVotes === 0) {
                                const okVotes = await waitFor(
                                        sessionId,
                                        (d) => Array.isArray(d?.votes) && d.votes.length > 0,
                                        "Votes"
                                );
                                if (!okVotes) return;
                        }

                        setStep("finalizing");
                        const consensusData = await runStep(sessionId, "consensus");
                        const hasFinalMessage = Boolean(consensusData?.finalMessage) || Boolean(consensusData?.consensus);
                        if (!hasFinalMessage) {
                                const okConsensus = await waitFor(
                                        sessionId,
                                        (d) =>
                                                (Array.isArray(d?.messages) && d.messages.some((m: any) => m.role === "consensus")) ||
                                                Boolean(d?.consensus?.summary),
                                        "Consensus"
                                );
                                if (!okConsensus) return;
                        }

                        setStep("done");
                        setDebug("Consensus complete");
                } catch (e: any) {
                        setError(e?.message || "Unexpected error");
                        setStep("error");
                }
        }, [question, verifiedAll, fetchFull, runStep, getKeys, waitFor]);

        const proposals = displayProposals.length > 0 ? displayProposals : messages.filter((m) => m.role === "agent_proposal");
        const critiques = displayCritiques.length > 0 ? displayCritiques : messages.filter((m) => m.role === "agent_critique");
        const consensusMessage = displayFinal ?? messages.find((m) => m.role === "consensus") ?? null;
        const firstProposalByAgent: Record<string, MagiMessage | undefined> = useMemo(() => {
                const map: Record<string, MagiMessage | undefined> = {};
                for (const p of proposals) {
                        if (!p.agent_id || map[p.agent_id]) continue;
                        map[p.agent_id] = p;
                }
                return map;
        }, [proposals]);

        const agentById = useMemo(() => {
                const map: Record<string, MagiAgent> = {};
                for (const a of agents) {
                        map[a.id] = a;
                }
                return map;
        }, [agents]);

        const proposalById = useMemo(() => {
                const map: Record<number, MagiMessage> = {};
                for (const p of proposals) {
                        map[p.id] = p;
                }
                return map;
        }, [proposals]);

        const voteBreakdown = useMemo(() => {
                const aggregate = votes.reduce(
                        (acc, vote) => {
                                const current = acc.get(vote.target_message_id) || { total: 0, votes: [] as MagiVote[] };
                                current.total += vote.score;
                                current.votes.push(vote);
                                acc.set(vote.target_message_id, current);
                                return acc;
                        },
                        new Map<number, { total: number; votes: MagiVote[] }>()
                );
                return Array.from(aggregate.entries())
                        .sort((a, b) => b[1].total - a[1].total)
                        .map(([targetId, payload]) => ({ targetId, ...payload }));
        }, [votes]);

        const stageChips = useMemo(
                () =>
                        [
                                { key: "creating" as Step, label: "Session", complete: Boolean(session) },
                                { key: "proposing" as Step, label: "Proposals", complete: proposals.length > 0 },
                                { key: "critiquing" as Step, label: "Critiques", complete: critiques.length > 0 },
                                { key: "voting" as Step, label: "Voting", complete: votes.length > 0 },
                                { key: "finalizing" as Step, label: "Consensus", complete: Boolean(consensusMessage) },
                                { key: "done" as Step, label: "Complete", complete: step === "done" },
                        ].map((chip) => ({ ...chip, active: step === chip.key })),
                [session, proposals, critiques, votes, consensusMessage, step]
        );

        const runLabel = useMemo(() => {
                switch (step) {
                        case "creating":
                                return "Creating session…";
                        case "proposing":
                                return "Gathering proposals…";
                        case "critiquing":
                                return "Running critiques…";
                        case "voting":
                                return "Collecting votes…";
                        case "finalizing":
                                return "Synthesizing consensus…";
                        case "done":
                                return "Run Again";
                        case "error":
                                return "Retry Run";
                        default:
                                return "Run MAGI";
                }
        }, [step]);

	return (
		<section className="mt-8">
			<header className="mb-3">
				<h2 className="title-text text-lg font-bold text-white/90">MAGI Consensus</h2>
				<p className="ui-text text-white/60 text-sm">Ask once. Three cores deliberate, then answer.</p>
			</header>
                        <div className="magi-panel border-white/15 p-5">
                                <div className="flex flex-wrap gap-2 mb-4">
                                        {stageChips.map((chip) => (
                                                <span
                                                        key={chip.key}
                                                        className={clsx(
                                                                "ui-text text-xs px-2 py-0.5 rounded border tracking-[0.2em] uppercase",
                                                                chip.complete
                                                                        ? "bg-magiGreen/20 border-magiGreen/40 text-magiGreen/80"
                                                                        : chip.active
                                                                                ? "bg-white/15 border-white/40 text-white step-active"
                                                                                : "bg-white/5 border-white/15 text-white/55"
                                                        )}
                                                >
                                                        {chip.label}
                                                </span>
                                        ))}
                                </div>
                                <label className="ui-text text-sm text-white/70 block mb-2">Question</label>
                                <textarea
                                        value={question}
                                        onChange={(e) => setQuestion(e.target.value)}
                                        rows={4}
                                        className="w-full rounded-md bg-white/15 border border-white/30 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/40"
                                        placeholder="e.g., Outline a safe rollout plan for feature X"
                                />
                                <div className="mt-4 flex flex-wrap items-center gap-3">
                                        <button
                                                onClick={onRun}
                                                disabled={step !== "idle" && step !== "done" && step !== "error"}
                                                className="ui-text text-sm px-5 py-2 rounded-md border border-white/25 bg-white/10 hover:bg-white/15 transition disabled:opacity-60"
                                        >
                                                {runLabel}
                                        </button>
                                        {!verifiedAll && <span className="ui-text text-xs text-red-400">Link all three providers first</span>}
                                        {error && <span className="ui-text text-xs text-red-400">{error}</span>}
                                        {step !== "idle" && step !== "done" && step !== "error" && (
                                                <span className="ui-text text-xs text-white/60">Current step: {step}</span>
                                        )}
                                </div>
                                {session && (
                                        <div className="ui-text text-xs text-white/40 mt-3">
                                                Session ID: <span className="text-white/65">{session.id}</span>
                                        </div>
                                )}
                        </div>

                        {/* Live per-agent activity */}
                        {agents.length > 0 && (
                                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                                        {agents.map((a) => {
                                                const proposal = firstProposalByAgent[a.id];
                                                const status =
                                                        step === "proposing" && !proposal
                                                                ? "Thinking…"
                                                                : proposal
                                                                        ? "Proposed"
                                                                        : step === "done"
                                                                                ? "No proposal"
                                                                                : "Idle";
                                                return (
                                                        <div key={a.id} className="magi-panel border-white/15 p-3">
                                                                <div className="flex items-center justify-between">
                                                                        <div className="title-text text-sm font-bold">{a.name}</div>
                                                                        <div className="ui-text text-xs text-white/60">{status}</div>
                                                                </div>
                                                                <div className="ui-text text-xs text-white/50 mt-1 uppercase tracking-wider">{a.provider}</div>
                                                                <div className="mt-3 bg-white/5 border border-white/10 rounded p-3">
                                                                        <div className="title-text text-[11px] font-semibold uppercase tracking-widest text-white/60">
                                                                                Initial Proposal
                                                                        </div>
                                                                        <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">
                                                                                {proposal
                                                                                        ? proposal.content
                                                                                        : step === "proposing"
                                                                                                ? "Awaiting proposal…"
                                                                                                : "No proposal available."}
                                                                        </div>
                                                                </div>
                                                        </div>
                                                );
                                        })}
                                </div>
                        )}

                        {critiques.length > 0 && (
                                <div className="magi-panel border-white/15 p-5 mt-6">
                                        <div className="flex items-center justify-between">
                                                <h3 className="title-text text-sm font-bold text-white/85 uppercase tracking-[0.3em]">Critiques</h3>
                                                <span className="ui-text text-xs text-white/50">{critiques.length} entries</span>
                                        </div>
                                        <div className="mt-4 space-y-3">
                                                {critiques.map((crit) => (
                                                        <div key={crit.id} className="bg-white/5 border border-white/10 rounded p-3">
                                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                                        <span className="title-text text-xs uppercase tracking-[0.25em] text-white/70">
                                                                                {agentById[crit.agent_id ?? ""]?.name || "Unknown Agent"}
                                                                        </span>
                                                                        <span className="ui-text text-[11px] text-white/40">#{crit.id}</span>
                                                                </div>
                                                                <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">{crit.content}</div>
                                                        </div>
                                                ))}
                                        </div>
                                </div>
                        )}

                        {votes.length > 0 && (
                                <div className="magi-panel border-white/15 p-5 mt-6">
                                        <div className="flex items-center justify-between">
                                                <h3 className="title-text text-sm font-bold text-white/85 uppercase tracking-[0.3em]">Voting Summary</h3>
                                                <span className="ui-text text-xs text-white/50">{votes.length} votes cast</span>
                                        </div>
                                        <div className="mt-4 space-y-4">
                                                {voteBreakdown.map((entry) => {
                                                        const proposal = proposalById[entry.targetId];
                                                        return (
                                                                <div key={entry.targetId} className="bg-white/5 border border-white/10 rounded p-3">
                                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                                                <div className="title-text text-sm font-semibold text-white/85">
                                                                                        Proposal #{entry.targetId}
                                                                                </div>
                                                                                <div className="ui-text text-sm text-magiGreen">
                                                                                        Total score: {entry.total}
                                                                                </div>
                                                                        </div>
                                                                        {proposal && (
                                                                                <div className="ui-text text-xs text-white/60 mt-1 whitespace-pre-wrap">
                                                                                        {proposal.content}
                                                                                </div>
                                                                        )}
                                                                        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                                                                                {entry.votes.map((vote) => (
                                                                                        <div key={vote.id} className="bg-black/20 border border-white/10 rounded p-2">
                                                                                                <div className="title-text text-xs uppercase tracking-[0.25em] text-white/70">
                                                                                                        {agentById[vote.agent_id]?.name || "Agent"}
                                                                                                </div>
                                                                                                <div className="ui-text text-sm text-white/85 mt-1">Score: {vote.score}</div>
                                                                                                {vote.rationale && (
                                                                                                        <div className="ui-text text-xs text-white/60 mt-2 whitespace-pre-wrap">
                                                                                                                {vote.rationale}
                                                                                                        </div>
                                                                                                )}
                                                                                        </div>
                                                                                ))}
                                                                        </div>
                                                                </div>
                                                        );
                                                })}
                                        </div>
                                </div>
                        )}

                        {consensusMessage && (
                                <div className="magi-panel border-white/15 p-6 mt-6">
                                        <h3 className="title-text text-base font-bold text-white/90 uppercase tracking-[0.35em]">Consensus Output</h3>
                                        {consensus?.summary && (
                                                <p className="ui-text text-sm text-magiGreen mt-2">{consensus.summary}</p>
                                        )}
                                        <div className="ui-text text-base text-white/85 whitespace-pre-wrap mt-4">{consensusMessage.content}</div>
                                </div>
                        )}

                        {debug && (
                                <div className="ui-text text-xs text-white/50 mt-3">
                                        {debug}
                                </div>
                        )}

                        {diagnostics.length > 0 && (
                                <div className="magi-panel border-white/15 p-4 mt-4">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
                                                <h3 className="title-text text-sm font-bold">Diagnostics</h3>
                                                <span className="ui-text text-[11px] text-white/50">* indicates fallback or heuristic output</span>
                                        </div>
                                        <div className="space-y-3">
                                                {diagnostics.map((diag, idx) => (
                                                        <div key={`${diag.step}-${diag.timestamp}-${idx}`} className="bg-white/5 border border-white/10 rounded p-3">
                                                                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                                                                        <div>
                                                                                <div className="title-text text-sm font-semibold capitalize">{diag.step}</div>
                                                                                <div className="ui-text text-xs text-white/60">
                                                                                        {new Date(diag.timestamp).toLocaleTimeString()}
                                                                                </div>
                                                                        </div>
                                                                        <div className="ui-text text-xs text-white/60">
                                                                                Proposals: {diag.totals.proposals} · Critiques: {diag.totals.critiques} · Votes: {diag.totals.votes} · Consensus: {diag.totals.consensus}
                                                                        </div>
                                                                </div>
                                                                {(typeof diag.winningProposalId === "number" || typeof diag.consensusMessageId === "number") && (
                                                                        <div className="ui-text text-xs text-magiGreen/70 mt-2">
                                                                                {typeof diag.winningProposalId === "number" && (
                                                                                        <span>
                                                                                                Winning proposal #{diag.winningProposalId}
                                                                                                {typeof diag.winningScore === "number" ? ` (score ${diag.winningScore})` : ""}
                                                                                        </span>
                                                                                )}
                                                                                {typeof diag.consensusMessageId === "number" && (
                                                                                        <span>
                                                                                                {typeof diag.winningProposalId === "number" ? " · " : ""}
                                                                                                Consensus message #{diag.consensusMessageId}
                                                                                        </span>
                                                                                )}
                                                                        </div>
                                                                )}
                                                                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                                                                        {diag.agents.map((agent) => (
                                                                                <div key={`${diag.timestamp}-${agent.agentId}`} className="bg-black/20 border border-white/10 rounded p-2">
                                                                                        <div className="title-text text-sm font-semibold">{agent.name}</div>
                                                                                        <div className="ui-text text-xs text-white/50 uppercase tracking-wider">{agent.provider}</div>
                                                                                        <div className="ui-text text-xs text-white/70 mt-2 space-y-1">
                                                                                                <div>
                                                                                                        <span className="text-white/60">Proposals:</span>{" "}
                                                                                                        {agent.proposals.length > 0 ? (
                                                                                                                <span className="inline-flex flex-wrap gap-1 align-top">
                                                                                                                        {agent.proposals.map((p) => (
                                                                                                                                <span key={p.id} className="px-1 py-0.5 rounded bg-white/10 border border-white/10" title={p.preview}>
                                                                                                                                        #{p.id}
                                                                                                                                        {p.fallback ? "*" : ""}
                                                                                                                                </span>
                                                                                                                        ))}
                                                                                                                </span>
                                                                                                        ) : (
                                                                                                                "—"
                                                                                                        )}
                                                                                                </div>
                                                                                                <div>
                                                                                                        <span className="text-white/60">Critiques:</span>{" "}
                                                                                                        {agent.critiquesAuthored.length > 0 ? (
                                                                                                                <span className="inline-flex flex-wrap gap-1 align-top">
                                                                                                                        {agent.critiquesAuthored.map((c) => (
                                                                                                                                <span key={c.id} className="px-1 py-0.5 rounded bg-white/10 border border-white/10" title={c.preview}>
                                                                                                                                        #{c.id}
                                                                                                                                        {typeof c.targetMessageId === "number" ? `→#${c.targetMessageId}` : ""}
                                                                                                                                        {c.fallback ? "*" : ""}
                                                                                                                                </span>
                                                                                                                        ))}
                                                                                                                </span>
                                                                                                        ) : (
                                                                                                                "—"
                                                                                                        )}
                                                                                                </div>
                                                                                                <div>
                                                                                                        <span className="text-white/60">Received:</span>{" "}
                                                                                                        {agent.critiquesReceived.length > 0 ? (
                                                                                                                <span className="inline-flex flex-wrap gap-1 align-top">
                                                                                                                        {agent.critiquesReceived.map((c) => (
                                                                                                                                <span key={c.id} className="px-1 py-0.5 rounded bg-white/10 border border-white/10" title={c.preview}>
                                                                                                                                        #{c.id}
                                                                                                                                        {c.fallback ? "*" : ""}
                                                                                                                                </span>
                                                                                                                        ))}
                                                                                                                </span>
                                                                                                        ) : (
                                                                                                                "—"
                                                                                                        )}
                                                                                                </div>
                                                                                                <div>
                                                                                                        <span className="text-white/60">Votes:</span>{" "}
                                                                                                        {agent.votesCast.length > 0 ? (
                                                                                                                <span className="inline-flex flex-wrap gap-1 align-top">
                                                                                                                        {agent.votesCast.map((v) => {
                                                                                                                                const score =
                                                                                                                                        typeof v.score === "number"
                                                                                                                                                ? v.score
                                                                                                                                                : Number(v.score) || 0;
                                                                                                                                return (
                                                                                                                                        <span key={v.id} className="px-1 py-0.5 rounded bg-white/10 border border-white/10" title={v.rationale || undefined}>
                                                                                                                                                #{v.targetMessageId}:{score}
                                                                                                                                                {v.fallback ? "*" : ""}
                                                                                                                                        </span>
                                                                                                                                );
                                                                                                                        })}
                                                                                                                </span>
                                                                                                        ) : (
                                                                                                                "—"
                                                                                                        )}
                                                                                                </div>
                                                                                                <div className={agent.fallbackCount ? "text-amber-300" : "text-white/50"}>Fallback triggers: {agent.fallbackCount}</div>
                                                                                        </div>
                                                                                </div>
                                                                        ))}
                                                                </div>
                                                                {diag.events.length > 0 && (
                                                                        <details className="mt-3">
                                                                                <summary className="cursor-pointer ui-text text-xs text-white/60">Events ({diag.events.length})</summary>
                                                                                <ul className="mt-2 space-y-1 ui-text text-xs text-white/70 list-disc list-inside">
                                                                                        {diag.events.map((evt, evtIdx) => (
                                                                                                <li key={`${diag.timestamp}-event-${evtIdx}`}>{evt}</li>
                                                                                        ))}
                                                                                </ul>
                                                                        </details>
                                                                )}
                                                        </div>
                                                ))}
                                        </div>
                                </div>
                        )}

		</section>
	);
}


