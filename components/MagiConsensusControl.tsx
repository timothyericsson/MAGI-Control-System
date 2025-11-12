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
        const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

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
                                                        .map((v) => `#${v.targetMessageId}:${v.score}${v.fallback ? "*" : ""}`)
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
		setVotes(data.votes || []);
		// Update display buffers from fetched data if not already present
		const fetchedProposals: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_proposal");
		const fetchedCritiques: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_critique");
		const fetchedFinal: MagiMessage | undefined = (data.messages || []).find((m: MagiMessage) => m.role === "consensus");
		if (fetchedProposals.length > 0) setDisplayProposals(fetchedProposals);
		if (fetchedCritiques.length > 0) setDisplayCritiques(fetchedCritiques);
		if (fetchedFinal) setDisplayFinal(fetchedFinal);
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
				setDisplayFinal(data.finalMessage as MagiMessage);
			}
			return next;
                });
                if (Array.isArray(data.votes)) setVotes(data.votes as MagiVote[]);
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
			await runStep(sessionId, "vote");

			setStep("finalizing");
			const consensusData = await runStep(sessionId, "consensus");
			const returnedFinal = consensusData?.finalMessage ? 1 : 0;
			if (returnedFinal === 0) {
				const okConsensus = await waitFor(
					sessionId,
					(d) => Array.isArray(d?.messages) && d.messages.some((m: any) => m.role === "consensus"),
					"Consensus"
				);
				if (!okConsensus) return;
			}

			setStep("done");
		} catch (e: any) {
			setError(e?.message || "Unexpected error");
			setStep("error");
		}
        }, [question, verifiedAll, fetchFull, runStep, getKeys]);

	const proposals = displayProposals.length > 0 ? displayProposals : messages.filter((m) => m.role === "agent_proposal");
	const critiques = displayCritiques.length > 0 ? displayCritiques : messages.filter((m) => m.role === "agent_critique");
	const final = displayFinal ?? messages.find((m) => m.role === "consensus") ?? null;
	const byAgent = useMemo(() => {
		const map: Record<string, { proposals: MagiMessage[]; critiques: MagiMessage[] }> = {};
		for (const a of agents) map[a.id] = { proposals: [], critiques: [] };
		for (const m of messages) {
			if (!m.agent_id) continue;
			if (!map[m.agent_id]) map[m.agent_id] = { proposals: [], critiques: [] };
			if (m.role === "agent_proposal") map[m.agent_id].proposals.push(m);
			if (m.role === "agent_critique") map[m.agent_id].critiques.push(m);
		}
		return map;
	}, [agents, messages]);
	const agentById = useMemo(() => {
		const m: Record<string, MagiAgent> = {};
		for (const a of agents) m[a.id] = a;
		return m;
	}, [agents]);
	const votesByProposal = useMemo(() => {
		const m: Record<number, MagiVote[]> = {};
		for (const v of votes) {
			if (!m[v.target_message_id]) m[v.target_message_id] = [];
			m[v.target_message_id].push(v);
		}
		return m;
	}, [votes]);
	const consensusMessageId = useMemo(() => displayFinal?.id ?? messages.find((m) => m.role === "consensus")?.id ?? null, [displayFinal, messages]);
	const proposalByAgent: Record<string, MagiMessage | undefined> = useMemo(() => {
		const map: Record<string, MagiMessage | undefined> = {};
		for (const p of proposals) {
			if (p.agent_id) map[p.agent_id] = p;
		}
		return map;
	}, [proposals]);
	const proposalById: Record<number, MagiMessage> = useMemo(() => {
		const map: Record<number, MagiMessage> = {};
		for (const p of proposals) map[p.id] = p;
		return map;
	}, [proposals]);

	return (
		<section className="mt-8">
			<header className="mb-3">
				<h2 className="title-text text-lg font-bold text-white/90">MAGI Consensus</h2>
				<p className="ui-text text-white/60 text-sm">Ask once. Three cores deliberate, then answer.</p>
			</header>
			<div className="magi-panel border-white/15 p-4">
				{/* Stage chips */}
				<div className="flex gap-2 mb-3">
					<span className="ui-text text-xs px-2 py-0.5 rounded bg-white/10 border border-white/15">
						Proposals: {(displayProposals.length || proposals.length)}
					</span>
					<span className="ui-text text-xs px-2 py-0.5 rounded bg-white/10 border border-white/15">
						Critiques: {(displayCritiques.length || critiques.length)}
					</span>
					<span className="ui-text text-xs px-2 py-0.5 rounded bg-white/10 border border-white/15">
						Votes: {votes.length}
					</span>
					<span className="ui-text text-xs px-2 py-0.5 rounded bg-white/10 border border-white/15">
						Consensus: {consensusMessageId ? `#${consensusMessageId}` : "—"}
					</span>
				</div>
				<label className="ui-text text-sm text-white/70 block mb-2">Question</label>
				<textarea
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					rows={3}
					className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/40"
					placeholder="e.g., Outline a safe rollout plan for feature X"
				/>
				<div className="mt-3 flex items-center gap-3">
					<button
						onClick={onRun}
						disabled={step !== "idle" && step !== "done" && step !== "error"}
						className="px-4 py-1.5 rounded-md border border-white/20 bg-white/10 hover:bg-white/15 ui-text text-sm disabled:opacity-60"
					>
						{step === "creating" ? "Creating…" :
							step === "proposing" ? "Proposing…" :
							step === "critiquing" ? "Critiquing…" :
							step === "voting" ? "Voting…" :
							step === "finalizing" ? "Finalizing…" :
							step === "done" ? "Run Again" : "Run MAGI"}
					</button>
					{!verifiedAll && <span className="ui-text text-xs text-red-400">Link all three providers first</span>}
					{error && <span className="ui-text text-xs text-red-400">{error}</span>}
				</div>
			</div>

			{/* Live per-agent activity */}
			{agents.length > 0 && (
				<div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
					{agents.map((a) => {
						const status =
							step === "proposing" && byAgent[a.id]?.proposals.length === 0 ? "Thinking…" :
							byAgent[a.id]?.proposals.length > 0 && step === "critiquing" && byAgent[a.id]?.critiques.length === 0 ? "Reviewing others…" :
							byAgent[a.id]?.proposals.length > 0 && byAgent[a.id]?.critiques.length > 0 ? "Ready" :
							byAgent[a.id]?.proposals.length > 0 ? "Proposed" :
							"Idle";
						const hasProposal = Boolean(proposalByAgent[a.id]);
						return (
							<div key={a.id} className="magi-panel border-white/15 p-3">
								<div className="flex items-center justify-between">
									<div className="title-text text-sm font-bold">{a.name}</div>
									<div className="ui-text text-xs text-white/60">{status}</div>
								</div>
								<div className="ui-text text-xs text-white/50 mt-1 uppercase tracking-wider">{a.provider}</div>
								<div className="mt-2">
									<button
										disabled={!hasProposal}
										onClick={() => setSelectedAgentId(a.id)}
										className="ui-text text-xs px-2 py-0.5 rounded border border-white/15 bg-white/10 disabled:opacity-50"
									>
										{hasProposal ? "View outputs" : "No outputs"}
									</button>
								</div>
							</div>
						);
					})}
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
                                                                                                                        {agent.votesCast.map((v) => (
                                                                                                                                <span key={v.id} className="px-1 py-0.5 rounded bg-white/10 border border-white/10" title={v.rationale || undefined}>
                                                                                                                                        #{v.targetMessageId}:{v.score}
                                                                                                                                        {v.fallback ? "*" : ""}
                                                                                                                                </span>
                                                                                                                        ))}
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

                        {session && (
                                <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div className="magi-panel border-white/15 p-4">
                                                <h3 className="title-text text-sm font-bold mb-2">Proposals</h3>
						<div className="space-y-3">
							{proposals.length === 0 && <div className="ui-text text-sm text-white/50">Awaiting proposals…</div>}
							{proposals.map((m) => (
								<div key={m.id} className="ui-text text-sm text-white/80 bg-white/5 border border-white/10 rounded p-2">
									<div className="flex items-center justify-between mb-1">
										<div className="text-white/70">
											{m.agent_id && agentById[m.agent_id] ? agentById[m.agent_id].name : "Unknown"}
										</div>
										<button
											onClick={() => m.agent_id && setSelectedAgentId(m.agent_id)}
											className="text-xs px-2 py-0.5 rounded border border-white/15 bg-white/10"
										>
											View
										</button>
									</div>
									{m.content}
								</div>
							))}
						</div>
					</div>
					<div className="magi-panel border-white/15 p-4">
						<h3 className="title-text text-sm font-bold mb-2">Critiques</h3>
						<div className="space-y-3">
							{critiques.length === 0 && <div className="ui-text text-sm text-white/50">Awaiting critiques…</div>}
							{critiques.map((m) => (
								<div key={m.id} className="ui-text text-sm text-white/80 bg-white/5 border border-white/10 rounded p-2">
									<div className="flex items-center justify-between mb-1">
										<div className="text-white/70">
											{m.agent_id && agentById[m.agent_id] ? agentById[m.agent_id].name : "Unknown"}
											{" → "}
											{(() => {
												const targetId = (m.meta as any)?.targetMessageId;
												const target = targetId ? proposalById[targetId] : undefined;
												const targetAgentName = target?.agent_id && agentById[target.agent_id] ? agentById[target.agent_id].name : `#${targetId || "?"}`;
												return <span className="text-white/60">{targetAgentName}</span>;
											})()}
										</div>
										{m.agent_id && <button onClick={() => setSelectedAgentId(m.agent_id)} className="text-xs px-2 py-0.5 rounded border border-white/15 bg-white/10">View</button>}
									</div>
									{m.content}
								</div>
							))}
						</div>
					</div>
					<div className="magi-panel border-white/15 p-4">
						<h3 className="title-text text-sm font-bold mb-2">Voting</h3>
						<div className="space-y-3">
							{proposals.length === 0 && <div className="ui-text text-sm text-white/50">Awaiting votes…</div>}
							{proposals.map((p) => {
								const pv = votesByProposal[p.id] || [];
								const total = pv.reduce((s, v) => s + (v.score || 0), 0);
								return (
									<div key={p.id} className={`ui-text text-sm text-white/80 bg-white/5 border ${consensusMessageId === p.id ? "border-magiGreen/50" : "border-white/10"} rounded p-2`}>
										<div className="flex items-center justify-between">
											<div>Proposal #{p.id}</div>
											<div className="text-white/60">Total: {total}</div>
										</div>
										<div className="mt-1 space-y-1">
											{agents.map((a) => {
												const v = pv.find((x) => x.agent_id === a.id);
												return (
													<div key={`${p.id}-${a.id}`} className="flex items-start justify-between gap-2">
														<span className="text-white/70">{a.name}</span>
														<span className="text-white/80">{v ? v.score : "—"}</span>
													</div>
												);
											})}
										</div>
									</div>
								);
							})}
						</div>
					</div>
					<div className="magi-panel border-white/15 p-4">
						<h3 className="title-text text-sm font-bold mb-2">Consensus</h3>
						<div className="space-y-3">
							{final ? (
								<div className="ui-text text-sm text-white/90 bg-white/5 border border-white/15 rounded p-2">
									{final.content}
								</div>
							) : (
								<div className="ui-text text-sm text-white/50">Awaiting consensus…</div>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Details modal */}
			{selectedAgentId && (
				<div className="fixed inset-0 z-50">
					<div className="absolute inset-0 bg-black/50" onClick={() => setSelectedAgentId(null)} />
					<div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(800px,92vw)] magi-panel border-white/15 p-4">
						{(() => {
							const a = agents.find((x) => x.id === selectedAgentId);
							const prop = proposalByAgent[selectedAgentId];
							const authored = critiques.filter((c) => c.agent_id === selectedAgentId);
							const received = prop ? critiques.filter((c) => (c.meta as any)?.targetMessageId === prop.id) : [];
							const pv = prop ? (votesByProposal[prop.id] || []) : [];
							return (
								<div>
									<div className="flex items-center justify-between mb-2">
										<div>
											<div className="title-text text-lg font-bold">{a?.name || "Agent"}</div>
											<div className="ui-text text-xs text-white/60 uppercase tracking-wider">{a?.provider || ""}</div>
										</div>
										<button onClick={() => setSelectedAgentId(null)} className="ui-text text-xs px-3 py-1 rounded border border-white/15 bg-white/10">
											Close
										</button>
									</div>
									<div className="divider my-2" />
									<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
										<div className="bg-white/5 border border-white/10 rounded p-3">
											<div className="title-text text-sm font-bold mb-1">Proposal</div>
											<div className="ui-text text-sm text-white/80 whitespace-pre-wrap">
												{prop ? prop.content : "—"}
											</div>
										</div>
										<div className="bg-white/5 border border-white/10 rounded p-3">
											<div className="title-text text-sm font-bold mb-1">Votes on Proposal</div>
											<div className="ui-text text-sm text-white/80 space-y-1">
												{pv.length === 0 && <div className="text-white/60">—</div>}
												{pv.map((v) => (
													<div key={v.id} className="flex items-center justify-between">
														<span>{agentById[v.agent_id]?.name || v.agent_id}</span>
														<span className="text-white/80">{v.score}</span>
													</div>
												))}
											</div>
										</div>
										<div className="bg-white/5 border border-white/10 rounded p-3">
											<div className="title-text text-sm font-bold mb-1">Critiques Authored</div>
											<div className="ui-text text-sm text-white/80 space-y-2">
												{authored.length === 0 && <div className="text-white/60">—</div>}
												{authored.map((c) => {
													const targetId = (c.meta as any)?.targetMessageId;
													const target = targetId ? proposalById[targetId] : undefined;
													const targetName = target?.agent_id && agentById[target.agent_id] ? agentById[target.agent_id].name : `#${targetId || "?"}`;
													return (
														<div key={c.id}>
															<div className="text-white/60 mb-1">→ {targetName}</div>
															<div>{c.content}</div>
														</div>
													);
												})}
											</div>
										</div>
										<div className="bg-white/5 border border-white/10 rounded p-3">
											<div className="title-text text-sm font-bold mb-1">Critiques Received</div>
											<div className="ui-text text-sm text-white/80 space-y-2">
												{received.length === 0 && <div className="text-white/60">—</div>}
												{received.map((c) => (
													<div key={c.id}>
														<div className="text-white/60 mb-1">{agentById[c.agent_id || ""]?.name || "—"}</div>
														<div>{c.content}</div>
													</div>
												))}
											</div>
										</div>
									</div>
								</div>
							);
						})()}
					</div>
				</div>
			)}
		</section>
	);
}


