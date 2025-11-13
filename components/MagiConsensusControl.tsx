"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import clsx from "classnames";

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
        const [currentStage, setCurrentStage] = useState<Step>("idle");
        const [error, setError] = useState<string | null>(null);
        const [session, setSession] = useState<MagiSession | null>(null);
        const [messages, setMessages] = useState<MagiMessage[]>([]);
        const [, setConsensus] = useState<MagiConsensus | null>(null);
        const [agents, setAgents] = useState<MagiAgent[]>([]);
        const [debug, setDebug] = useState<string | null>(null);
        // Local display buffers to avoid UI depending on DB read latency
        const [displayProposals, setDisplayProposals] = useState<MagiMessage[]>([]);
        const [displayCritiques, setDisplayCritiques] = useState<MagiMessage[]>([]);
        const [displayConsensus, setDisplayConsensus] = useState<MagiMessage | null>(null);
        const [displayVotes, setDisplayVotes] = useState<MagiVote[]>([]);
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
                setDisplayVotes(normalizeVoteScores(data.votes as MagiVote[] | undefined));
		// Update display buffers from fetched data if not already present
		const fetchedProposals: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_proposal");
		const fetchedCritiques: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_critique");
		const fetchedFinal: MagiMessage | undefined = (data.messages || []).find((m: MagiMessage) => m.role === "consensus");
		if (fetchedProposals.length > 0) setDisplayProposals(fetchedProposals);
                if (fetchedCritiques.length > 0) setDisplayCritiques(fetchedCritiques);
                if (fetchedFinal) setDisplayConsensus(fetchedFinal);
	}, []);

	async function fetchFullRaw(sessionId: string) {
		const res = await fetch(`/api/magi/session/${sessionId}?t=${Date.now()}`, { cache: "no-store" });
		const data = await res.json();
		return data;
	}

	async function waitFor(sessionId: string, predicate: (payload: any) => boolean, label: string, timeoutMs = 15000, intervalMs = 300) {
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
	}

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
                                setDisplayConsensus(data.finalMessage as MagiMessage);
                        }
                        return next;
                });
                if (Array.isArray(data.votes)) setDisplayVotes(normalizeVoteScores(data.votes as MagiVote[]));
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
                setDisplayConsensus(null);
                setDisplayVotes([]);
                setDiagnostics([]);
                setDebug(null);
                setCurrentStage("idle");
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
                        setCurrentStage("creating");
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
                        setCurrentStage("proposing");
                        const proposeData = await runStep(sessionId, "propose");
                        // If the step already returned proposals, don't wait further
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
                        setCurrentStage("critiquing");
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
                        setCurrentStage("voting");
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
                        setCurrentStage("finalizing");
                        const finalData = await runStep(sessionId, "consensus");
                        const hasConsensus = Boolean(finalData?.finalMessage);
                        if (!hasConsensus) {
                                const okConsensus = await waitFor(
                                        sessionId,
                                        (d) =>
                                                Array.isArray(d?.messages) &&
                                                d.messages.some((m: any) => m.role === "consensus"),
                                        "Consensus"
                                );
                                if (!okConsensus) return;
                        }

                        setStep("done");
                        setCurrentStage("done");
                        setDebug("Consensus ready");
                } catch (e: any) {
                        setError(e?.message || "Unexpected error");
                        setStep("error");
                }
        }, [question, verifiedAll, fetchFull, runStep, getKeys]);

        const proposals = displayProposals.length > 0 ? displayProposals : messages.filter((m) => m.role === "agent_proposal");
        const critiques = displayCritiques.length > 0 ? displayCritiques : messages.filter((m) => m.role === "agent_critique");
        const consensusMessage = displayConsensus ?? messages.find((m) => m.role === "consensus") ?? null;
        const votesSource = useMemo(() => {
                if (displayVotes.length > 0) return displayVotes;
                const latestVoteDiag = [...diagnostics].reverse().find((diag) => diag.step === "vote");
                if (!latestVoteDiag) return [];
                const syntheticCreatedAt = latestVoteDiag.timestamp;
                const sessionId = session?.id ?? "";
                return latestVoteDiag.agents.flatMap((agent) =>
                        agent.votesCast.map((vote) => ({
                                id: vote.id,
                                session_id: sessionId,
                                agent_id: agent.agentId,
                                target_message_id: vote.targetMessageId,
                                score:
                                        typeof vote.score === "number"
                                                ? vote.score
                                                : typeof vote.score === "string"
                                                        ? Number(vote.score) || 0
                                                        : 0,
                                rationale: vote.rationale,
                                created_at: syntheticCreatedAt,
                        }))
                ) as MagiVote[];
        }, [displayVotes, diagnostics, session?.id]);

        const votes = useMemo(() => normalizeVoteScores(votesSource), [votesSource]);

        const agentById = useMemo(() => {
                const map: Record<string, MagiAgent> = {};
                for (const agent of agents) {
                        map[agent.id] = agent;
                }
                return map;
        }, [agents]);

        const messageById = useMemo(() => {
                const map: Record<number, MagiMessage> = {};
                for (const msg of messages) {
                        map[msg.id] = msg;
                }
                return map;
        }, [messages]);

        const stepOrder: Step[] = ["idle", "creating", "proposing", "critiquing", "voting", "finalizing", "done", "error"];

        const computeStageStatus = useCallback(
                (stageKey: "proposing" | "critiquing" | "voting" | "finalizing") => {
                        if (step === "error") {
                                const stageIndex = stepOrder.indexOf(stageKey);
                                const progressIndex = stepOrder.indexOf(currentStage);
                                return progressIndex >= stageIndex ? "error" : "pending";
                        }
                        const stageIndex = stepOrder.indexOf(stageKey);
                        const currentIndex = stepOrder.indexOf(currentStage);
                        if (currentStage === "done" || currentIndex > stageIndex) return "complete";
                        if (currentIndex === stageIndex) return "active";
                        return "pending";
                },
                [currentStage, step]
        );

        const stageLabels: { key: "proposing" | "critiquing" | "voting" | "finalizing"; label: string; description: string }[] = [
                { key: "proposing", label: "Proposals", description: "Each MAGI core drafts an initial response." },
                { key: "critiquing", label: "Critique", description: "Cores review peers and surface weaknesses." },
                { key: "voting", label: "Voting", description: "Arguments are scored to select the strongest path." },
                { key: "finalizing", label: "Consensus", description: "The council synthesizes a unified answer." },
        ];

        const getStageBadgeClass = (status: ReturnType<typeof computeStageStatus>) =>
                clsx(
                        "ui-text text-[11px] px-2 py-0.5 rounded-full border",
                        status === "complete" && "border-magiGreen/60 text-magiGreen/80 bg-magiGreen/10",
                        status === "active" && "border-magiBlue/60 text-magiBlue/80 bg-magiBlue/10",
                        status === "pending" && "border-white/15 text-white/50 bg-white/5",
                        status === "error" && "border-red-500/60 text-red-300 bg-red-500/10"
                );

        const sortedProposals = useMemo(() => {
                return proposals.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }, [proposals]);

        const sortedCritiques = useMemo(() => {
                return critiques.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }, [critiques]);

        const sortedVotes = useMemo(() => {
                return votes.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }, [votes]);

	return (
		<section className="mt-8">
			<header className="mb-3">
				<h2 className="title-text text-lg font-bold text-white/90">MAGI Consensus</h2>
				<p className="ui-text text-white/60 text-sm">Ask once. Three cores deliberate, then answer.</p>
			</header>
                        <div className="magi-panel border-white/15 p-4">
                                <label className="ui-text text-sm text-white/70 block mb-2">Question</label>
                                <textarea
                                        value={question}
                                        onChange={(e) => setQuestion(e.target.value)}
                                        rows={3}
                                        className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/40"
                                        placeholder="e.g., Outline a safe rollout plan for feature X"
                                />
                                <div className="mt-3 flex flex-wrap items-center gap-3">
                                        <button
                                                onClick={onRun}
                                                disabled={step !== "idle" && step !== "done" && step !== "error"}
                                                className="px-4 py-1.5 rounded-md border border-white/20 bg-white/10 hover:bg-white/15 ui-text text-sm disabled:opacity-60"
                                        >
                                                {step === "creating"
                                                        ? "Creating…"
                                                        : step === "proposing"
                                                                ? "Gathering proposals…"
                                                                : step === "critiquing"
                                                                        ? "Running critiques…"
                                                                        : step === "voting"
                                                                                ? "Collecting votes…"
                                                                                : step === "finalizing"
                                                                                        ? "Resolving consensus…"
                                                                                        : step === "done"
                                                                                                ? "Run Again"
                                                                                                : "Run MAGI"}
                                        </button>
                                        <span className="ui-text text-xs text-white/50">
                                                {displayProposals.length || proposals.length} proposals tracked
                                        </span>
                                        {!verifiedAll && <span className="ui-text text-xs text-red-400">Link all three providers first</span>}
                                        {error && <span className="ui-text text-xs text-red-400">{error}</span>}
                                </div>
                        </div>

                        {/* Stage progress */}
                        <div className="mt-4 magi-panel border-white/15 p-4">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                        {stageLabels.map((stage) => {
                                                const status = computeStageStatus(stage.key);
                                                return (
                                                        <div key={stage.key} className="bg-white/5 border border-white/10 rounded p-3">
                                                                <div className="flex items-center justify-between">
                                                                        <div className="title-text text-sm font-semibold text-white/80">{stage.label}</div>
                                                                        <span className={getStageBadgeClass(status)}>
                                                                                {status === "complete"
                                                                                        ? "Complete"
                                                                                        : status === "active"
                                                                                                ? "In Progress"
                                                                                                : status === "error"
                                                                                                        ? "Error"
                                                                                                        : "Pending"}
                                                                        </span>
                                                                </div>
                                                                <p className="ui-text text-xs text-white/60 mt-2">{stage.description}</p>
                                                        </div>
                                                );
                                        })}
                                </div>
                        </div>

                        {/* Stage detail panels */}
                        <div className="mt-4 space-y-4">
                                <div className="magi-panel border-white/15 p-4">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                <div>
                                                        <h3 className="title-text text-base font-semibold text-white/90">Proposal Drafts</h3>
                                                        <p className="ui-text text-sm text-white/60">Individual outputs from each MAGI core.</p>
                                                </div>
                                                <span className="ui-text text-xs text-white/50">{sortedProposals.length} captured</span>
                                        </div>
                                        {agents.length > 0 ? (
                                                <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                                                        {agents.map((a) => {
                                                                const agentProposals = sortedProposals.filter((p) => p.agent_id === a.id);
                                                                return (
                                                                        <div key={a.id} className="bg-white/5 border border-white/10 rounded p-3">
                                                                                <div className="flex items-center justify-between">
                                                                                        <div className="title-text text-sm font-semibold text-white/80">{a.name}</div>
                                                                                        <span className="ui-text text-[11px] uppercase tracking-widest text-white/40">{a.provider}</span>
                                                                                </div>
                                                                                <div className="mt-3 space-y-3">
                                                                                        {agentProposals.length > 0 ? (
                                                                                                agentProposals.map((proposal) => (
                                                                                                        <div key={proposal.id} className="bg-black/30 border border-white/10 rounded p-3">
                                                                                                                <div className="ui-text text-[11px] text-white/50">#{proposal.id}</div>
                                                                                                                <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">{proposal.content}</div>
                                                                                                        </div>
                                                                                                ))
                                                                                        ) : (
                                                                                                <div className="ui-text text-sm text-white/50">No proposal recorded.</div>
                                                                                        )}
                                                                                </div>
                                                                        </div>
                                                                );
                                                        })}
                                                </div>
                                        ) : (
                                                <div className="ui-text text-sm text-white/50 mt-4">Awaiting agent telemetry.</div>
                                        )}
                                </div>

                                <div className="magi-panel border-white/15 p-4">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                <div>
                                                        <h3 className="title-text text-base font-semibold text-white/90">Cross-Critiques</h3>
                                                        <p className="ui-text text-sm text-white/60">Challenges and risk calls surfaced between agents.</p>
                                                </div>
                                                <span className="ui-text text-xs text-white/50">{sortedCritiques.length} logged</span>
                                        </div>
                                        <div className="mt-4 space-y-3">
                                                {sortedCritiques.length > 0 ? (
                                                        sortedCritiques.map((critique) => {
                                                                const agent = critique.agent_id ? agentById[critique.agent_id] : undefined;
                                                                const targetId =
                                                                        (critique.meta?.target_message_id as number | undefined) ||
                                                                        (critique.meta?.targetMessageId as number | undefined) ||
                                                                        null;
                                                                const targetProposal = targetId ? messageById[targetId] : undefined;
                                                                return (
                                                                        <div key={critique.id} className="bg-white/5 border border-white/10 rounded p-3">
                                                                                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-1">
                                                                                        <div className="title-text text-sm font-semibold text-white/80">
                                                                                                {agent ? agent.name : "Unknown agent"}
                                                                                        </div>
                                                                                        <div className="ui-text text-xs text-white/50">#{critique.id}</div>
                                                                                </div>
                                                                                {targetProposal && (
                                                                                        <div className="ui-text text-[11px] text-white/50 mt-1">
                                                                                                Targets proposal #{targetProposal.id} by {targetProposal.agent_id && agentById[targetProposal.agent_id]?.name}
                                                                                        </div>
                                                                                )}
                                                                                <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">{critique.content}</div>
                                                                        </div>
                                                                );
                                                        })
                                                ) : (
                                                        <div className="ui-text text-sm text-white/50">No critiques have been recorded yet.</div>
                                                )}
                                        </div>
                                </div>

                                <div className="magi-panel border-white/15 p-4">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                <div>
                                                        <h3 className="title-text text-base font-semibold text-white/90">Voting Ledger</h3>
                                                        <p className="ui-text text-sm text-white/60">Numerical scores assigned to each surviving plan.</p>
                                                </div>
                                                <span className="ui-text text-xs text-white/50">{sortedVotes.length} votes tallied</span>
                                        </div>
                                        <div className="mt-4 overflow-x-auto">
                                                {sortedVotes.length > 0 ? (
                                                        <table className="min-w-full text-left">
                                                                <thead>
                                                                        <tr className="ui-text text-[11px] uppercase tracking-widest text-white/40">
                                                                                <th className="py-2 pr-4 font-normal">Agent</th>
                                                                                <th className="py-2 pr-4 font-normal">Target</th>
                                                                                <th className="py-2 pr-4 font-normal">Score</th>
                                                                                <th className="py-2 pr-4 font-normal">Rationale</th>
                                                                        </tr>
                                                                </thead>
                                                                <tbody className="ui-text text-sm text-white/80">
                                                                        {sortedVotes.map((vote) => {
                                                                                const agent = agentById[vote.agent_id];
                                                                                const target = messageById[vote.target_message_id];
                                                                                return (
                                                                                        <tr key={vote.id} className="border-t border-white/10">
                                                                                                <td className="py-2 pr-4">{agent ? agent.name : vote.agent_id}</td>
                                                                                                <td className="py-2 pr-4">
                                                                                                        {target
                                                                                                                ? `Proposal #${target.id} (${target.agent_id && agentById[target.agent_id]?.name})`
                                                                                                                : `#${vote.target_message_id}`}
                                                                                                </td>
                                                                                                <td className="py-2 pr-4 font-semibold text-white">{vote.score}</td>
                                                                                                <td className="py-2 pr-4 text-white/70 whitespace-pre-wrap">{vote.rationale || "—"}</td>
                                                                                        </tr>
                                                                                );
                                                                        })}
                                                                </tbody>
                                                        </table>
                                                ) : (
                                                        <div className="ui-text text-sm text-white/50">No votes have been submitted.</div>
                                                )}
                                        </div>
                                </div>

                                <div className="magi-panel border-white/15 p-4">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                <div>
                                                        <h3 className="title-text text-base font-semibold text-white/90">Final Consensus</h3>
                                                        <p className="ui-text text-sm text-white/60">Unified guidance delivered by the tri-core council.</p>
                                                </div>
                                                {consensusMessage && (
                                                        <span className="ui-text text-xs text-white/50">Issued at {new Date(consensusMessage.created_at).toLocaleTimeString()}</span>
                                                )}
                                        </div>
                                        <div className="mt-4 bg-white/5 border border-white/10 rounded p-4">
                                                {consensusMessage ? (
                                                        <div className="ui-text text-base text-white/85 whitespace-pre-wrap leading-relaxed">{consensusMessage.content}</div>
                                                ) : (
                                                        <div className="ui-text text-sm text-white/50">Consensus message not yet available.</div>
                                                )}
                                        </div>
                                </div>
                        </div>

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


