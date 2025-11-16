"use client";

import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { safeLoad } from "@/lib/localStore";
import { normalizeLiveUrl } from "@/lib/liveUrl";
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

function votesEqual(a: MagiVote[], b: MagiVote[]): boolean {
        if (a.length !== b.length) return false;
        const byId = new Map<number, MagiVote>();
        for (const vote of a) {
                byId.set(vote.id, vote);
        }
        for (const vote of b) {
                const existing = byId.get(vote.id);
                if (!existing) return false;
                if (
                        existing.agent_id !== vote.agent_id ||
                        existing.target_message_id !== vote.target_message_id ||
                        existing.score !== vote.score ||
                        existing.rationale !== vote.rationale ||
                        existing.created_at !== vote.created_at
                ) {
                        return false;
                }
        }
        return true;
}

function readMessageMetaNumber(meta: unknown, key: string): number | null {
        if (!meta || typeof meta !== "object") return null;
        const raw = (meta as Record<string, unknown>)[key];
        if (typeof raw === "number" && Number.isFinite(raw)) {
                return raw;
        }
        if (typeof raw === "string") {
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed)) return parsed;
        }
        return null;
}

type Step = "idle" | "creating" | "proposing" | "voting" | "finalizing" | "done" | "error";

type ArtifactState = {
        id: string;
        original_filename: string;
        status: "uploaded" | "processing" | "ready" | "failed";
        ready_at?: string | null;
        updated_at?: string;
        manifest?: Record<string, unknown> | null;
};

type ArtifactApiResponse = {
        id: string;
        original_filename: string;
        status: ArtifactState["status"];
        ready_at: string | null;
        manifest?: Record<string, unknown> | null;
        created_at: string;
        updated_at: string;
};

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

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
        const [artifact, setArtifact] = useState<ArtifactState | null>(null);
        const [artifactError, setArtifactError] = useState<string | null>(null);
        const [artifactStatusMessage, setArtifactStatusMessage] = useState<string | null>(null);
        const [uploadingArtifact, setUploadingArtifact] = useState(false);
        const [liveUrl, setLiveUrl] = useState("");
        const [liveUrlError, setLiveUrlError] = useState<string | null>(null);
        const fileInputRef = useRef<HTMLInputElement | null>(null);
        // Local display buffers to avoid UI depending on DB read latency
        const [displayProposals, setDisplayProposals] = useState<MagiMessage[]>([]);
        // Critiques removed from workflow
        const [displayConsensus, setDisplayConsensus] = useState<MagiMessage | null>(null);
        const [displayVotes, setDisplayVotes] = useState<MagiVote[]>([]);
		// Tucked-away history drawer state
		const [showHistory, setShowHistory] = useState(false);
		const [sessions, setSessions] = useState<MagiSession[]>([]);
		const [loadingSessions, setLoadingSessions] = useState(false);
        const [showClearConfirm, setShowClearConfirm] = useState(false);
        const [clearingHistory, setClearingHistory] = useState(false);
        const [clearHistoryError, setClearHistoryError] = useState<string | null>(null);

        // History detail modal
        const [showHistoryDetail, setShowHistoryDetail] = useState(false);
        const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
        const [historyDetail, setHistoryDetail] = useState<{
                id: string;
                createdAt: string;
                question: string;
                finalMessage: MagiMessage | null;
                derived: boolean;
                liveUrl: string | null;
        } | null>(null);

        // Modal toggles for stage details
        const [showProposalsModal, setShowProposalsModal] = useState(false);
        const [showVotesModal, setShowVotesModal] = useState(false);

        const getUserId = useCallback(async () => {
                if (!supabaseBrowser) {
                        throw new Error("Auth not initialized");
                }
                const { data: auth } = await supabaseBrowser.auth.getSession();
                const userId = auth.session?.user?.id;
                if (!userId) {
                        throw new Error("You must be signed in.");
                }
                return userId;
        }, []);

        const updateDisplayVotes = useCallback((incoming: MagiVote[] | null | undefined) => {
                const normalized = normalizeVoteScores(incoming);
                setDisplayVotes((prev) => {
                        if (normalized.length === 0 && prev.length > 0) {
                                return prev;
                        }
                        if (votesEqual(prev, normalized)) {
                                return prev;
                        }
                        return normalized;
                });
        }, [fetchFullRaw]);

        const refreshArtifactStatus = useCallback(
                async (artifactId: string, userId: string): Promise<ArtifactApiResponse> => {
                        const res = await fetch(`/api/uploads/${artifactId}?userId=${encodeURIComponent(userId)}`, { cache: "no-store" });
                        const json = await res.json();
                        if (!json?.ok) {
                                throw new Error(json?.error || "Failed to load upload status");
                        }
                        const payload = json.artifact as ArtifactApiResponse;
                        setArtifact({
                                id: payload.id,
                                original_filename: payload.original_filename,
                                status: payload.status,
                                ready_at: payload.ready_at,
                                updated_at: payload.updated_at,
                                manifest: (payload.manifest as Record<string, unknown> | null) ?? null,
                        });
                        return payload;
                },
                []
        );

        const waitForArtifactReady = useCallback(
                async (artifactId: string, userId: string) => {
                        const timeoutMs = 60_000;
                        const start = Date.now();
                        while (Date.now() - start < timeoutMs) {
                                const payload = await refreshArtifactStatus(artifactId, userId);
                                if (payload.status === "ready") {
                                        setArtifactStatusMessage("Bundle ready for security audit.");
                                        return payload;
                                }
                                if (payload.status === "failed") {
                                        throw new Error("Processing failed. Please re-upload your bundle.");
                                }
                                await new Promise((resolve) => setTimeout(resolve, 1500));
                        }
                        throw new Error("Processing timed out. Please retry.");
                },
                [refreshArtifactStatus]
        );

        const handleArtifactUpload = useCallback(
                async (file: File) => {
                        setArtifactError(null);
                        const lower = file.name.toLowerCase();
                        if (!lower.endsWith(".zip")) {
                                setArtifactError("Only .zip files are supported.");
                                return;
                        }
                        if (file.size > MAX_UPLOAD_BYTES) {
                                setArtifactError(`File exceeds the ${MAX_UPLOAD_MB}MB limit.`);
                                return;
                        }

                        setUploadingArtifact(true);
                        setArtifactStatusMessage("Requesting upload slot…");
                        try {
                                const userId = await getUserId();
                                const res = await fetch("/api/uploads", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                                filename: file.name,
                                                size: file.size,
                                                userId,
                                        }),
                                });
                                const json = await res.json();
                                if (!json?.ok) {
                                        throw new Error(json?.error || "Failed to initialize upload");
                                }
                                const artifactId: string = json.artifactId;
                                if (!json.uploadUrl) {
                                        throw new Error("Missing upload URL from server");
                                }
                                setArtifact({
                                        id: artifactId,
                                        original_filename: file.name,
                                        status: json.status ?? "uploaded",
                                        manifest: null,
                                });
                                setArtifactStatusMessage("Uploading archive…");
                                const uploadRes = await fetch(json.uploadUrl, {
                                        method: "PUT",
                                        headers: { "Content-Type": "application/zip" },
                                        body: file,
                                });
                                if (!uploadRes.ok) {
                                        throw new Error("Upload failed. Please retry.");
                                }
                                setArtifactStatusMessage("Processing uploaded bundle…");
                                const processRes = await fetch(`/api/uploads/${artifactId}/process`, {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ userId }),
                                });
                                const processJson = await processRes.json();
                                if (!processJson?.ok && processRes.status >= 400) {
                                        throw new Error(processJson?.error || "Unable to process uploaded bundle");
                                }
                                await waitForArtifactReady(artifactId, userId);
                                if (!question.trim()) {
                                        setQuestion(
                                                `Perform a security audit of ${file.name}. Highlight vulnerabilities, misconfigurations, and remediation steps.`
                                        );
                                }
                        } catch (err: any) {
                                setArtifactError(err?.message || "Upload failed. Please try again.");
                                setArtifactStatusMessage(null);
                                setArtifact(null);
                        } finally {
                                setUploadingArtifact(false);
                        }
                },
                [getUserId, question, waitForArtifactReady]
        );

        const onFileInputChange = useCallback(
                (event: ChangeEvent<HTMLInputElement>) => {
                        const file = event.target.files?.[0];
                        if (file) {
                                void handleArtifactUpload(file);
                        }
                        event.target.value = "";
                },
                [handleArtifactUpload]
        );

        const clearArtifact = useCallback(() => {
                setArtifact(null);
                setArtifactError(null);
                setArtifactStatusMessage(null);
        }, []);

        const normalizedLiveUrl = useMemo(() => {
                if (!liveUrl.trim()) return null;
                return normalizeLiveUrl(liveUrl) ?? null;
        }, [liveUrl]);

        useEffect(() => {
                if (!liveUrl.trim()) {
                        setLiveUrlError(null);
                        return;
                }
                if (!normalizedLiveUrl) {
                        setLiveUrlError("Enter a valid http(s) URL");
                } else {
                        setLiveUrlError(null);
                }
        }, [liveUrl, normalizedLiveUrl]);

        useEffect(() => {
                if (!question.trim() && normalizedLiveUrl) {
                        setQuestion(
                                `Perform a security audit of the live site at ${normalizedLiveUrl}. Highlight HTTP exposures, misconfigurations, and remediation steps.`
                        );
                }
        }, [normalizedLiveUrl, question]);

        const clearLiveUrl = useCallback(() => {
                setLiveUrl("");
                setLiveUrlError(null);
        }, []);


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

	// Load user's sessions for the History drawer
	const loadSessions = useCallback(async () => {
		if (!supabaseBrowser) return;
		const { data: auth } = await supabaseBrowser.auth.getSession();
		const userId = auth.session?.user?.id;
		if (!userId) return;
		setLoadingSessions(true);
		try {
			const res = await fetch(`/api/magi/sessions?userId=${encodeURIComponent(userId)}`, { cache: "no-store" });
			const json = await res.json();
			if (json?.ok && Array.isArray(json.sessions)) {
				setSessions(json.sessions as MagiSession[]);
			}
		} finally {
			setLoadingSessions(false);
		}
	}, []);

	useEffect(() => {
		if (showHistory) {
			loadSessions();
		}
	}, [showHistory, loadSessions]);

        useEffect(() => {
                if (typeof window === "undefined") return;
                const handler = (event: Event) => {
                        const custom = event as CustomEvent<{ open?: boolean }>;
                        setShowClearConfirm(false);
                        setClearHistoryError(null);
                        if (typeof custom.detail?.open === "boolean") {
                                setShowHistory(custom.detail.open);
                        } else {
                                setShowHistory((prev) => !prev);
                        }
                };
                window.addEventListener("magi-toggle-history", handler as EventListener);
                return () => {
                        window.removeEventListener("magi-toggle-history", handler as EventListener);
                };
        }, []);

        const clearHistory = useCallback(async () => {
                if (!supabaseBrowser) return;
                setClearingHistory(true);
                setClearHistoryError(null);
                try {
                        const userId = await getUserId();
                        const res = await fetch(`/api/magi/sessions?userId=${encodeURIComponent(userId)}`, {
                                method: "DELETE",
                        });
                        const json = await res.json();
                        if (!json?.ok) {
                                throw new Error(json?.error || "Failed to clear history");
                        }
                        setSessions([]);
                        setShowClearConfirm(false);
                        await loadSessions();
                } catch (err: any) {
                        setClearHistoryError(err?.message || "Failed to clear history");
                } finally {
                        setClearingHistory(false);
                }
        }, [getUserId, loadSessions]);


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
                updateDisplayVotes(data.votes as MagiVote[] | undefined);
		// Update display buffers from fetched data if not already present
		const fetchedProposals: MagiMessage[] = (data.messages || []).filter((m: MagiMessage) => m.role === "agent_proposal");
		const fetchedFinal: MagiMessage | undefined = (data.messages || []).find((m: MagiMessage) => m.role === "consensus");
		if (fetchedProposals.length > 0) setDisplayProposals(fetchedProposals);
                if (fetchedFinal) setDisplayConsensus(fetchedFinal);
	}, []);

	async function fetchFullRaw(sessionId: string) {
		const res = await fetch(`/api/magi/session/${sessionId}?t=${Date.now()}`, { cache: "no-store" });
		const data = await res.json();
		return data;
	}

	const onSelectSession = useCallback(async (s: MagiSession) => {
		await fetchFull(s.id);
		setShowHistory(false);
	}, [fetchFull]);

        const openHistoryDetail = useCallback(async (s: MagiSession) => {
                setHistoryDetailLoading(true);
                setShowHistoryDetail(true);
                const fallbackSummary = typeof s.consensusSummary === "string" ? s.consensusSummary.trim() : "";
                const fallbackFinalId =
                        typeof s.finalMessageId === "number" && Number.isFinite(s.finalMessageId) ? s.finalMessageId : null;

                function buildMessageFromSummary(summary: string, idFallback: number | null): MagiMessage {
                        return {
                                id: idFallback ?? -1,
                                session_id: s.id,
                                agent_id: null,
                                role: "consensus",
                                content: summary,
                                model: null,
                                tokens: null,
                                meta: {},
                                created_at: new Date().toISOString(),
                        };
                }

                try {
                        async function resolveFinal(sessionId: string): Promise<{ question: string; finalMessage: MagiMessage | null; derived: boolean; liveUrl: string | null }> {
                                const data = await fetchFullRaw(sessionId);
                                if (!data?.ok) {
                                        return { question: s.question, finalMessage: null, derived: false, liveUrl: s.live_url ?? null };
                                }
                                const msgs: MagiMessage[] = Array.isArray(data.messages) ? (data.messages as MagiMessage[]) : [];
                                const votes: MagiVote[] = Array.isArray(data.votes) ? (data.votes as MagiVote[]) : [];
                                const question: string = data.session?.question ?? s.question;
                                const liveUrl: string | null = typeof data.session?.live_url === "string"
                                        ? (data.session.live_url as string)
                                        : s.live_url ?? null;
                                const consensusRow = data.consensus || null;
                                let finalId: number | null = null;
                                if (consensusRow) {
                                        const rawA = (consensusRow as any).final_message_id;
                                        const rawB = (consensusRow as any).finalMessageId;
                                        const rawC = (consensusRow as any).finalMessageID;
                                        const candidate = typeof rawA !== "undefined" ? rawA : typeof rawB !== "undefined" ? rawB : rawC;
                                        if (typeof candidate === "number" && Number.isFinite(candidate)) {
                                                finalId = candidate;
                                        } else if (typeof candidate === "string") {
                                                const parsed = Number.parseInt(candidate, 10);
                                                if (Number.isFinite(parsed)) finalId = parsed;
                                        }
                                }
                                let finalMsg: MagiMessage | null = null;
                                if (finalId) {
                                        finalMsg = msgs.find((m) => m.id === finalId) || null;
                                }
                                if (!finalMsg) {
                                        // Fallback to the latest consensus message if multiple
                                        const consensusMsgs = msgs.filter((m) => m.role === "consensus");
                                        finalMsg =
                                                consensusMsgs.length > 0
                                                        ? consensusMsgs[consensusMsgs.length - 1] // latest by created order
                                                        : null;
                                }
                                if (!finalMsg && consensusRow && typeof (consensusRow as any).summary === "string" && (consensusRow as any).summary.trim()) {
                                        finalMsg = buildMessageFromSummary(((consensusRow as any).summary as string).trim(), finalId);
                                        return { question, finalMessage: finalMsg, derived: false, liveUrl };
                                }
                                if (!finalMsg) {
                                        const proposals = msgs.filter((m) => m.role === "agent_proposal");
                                        if (proposals.length > 0) {
                                                const totals = new Map<number, number>();
                                                for (const v of votes) {
                                                        totals.set(v.target_message_id, (totals.get(v.target_message_id) || 0) + v.score);
                                                }
                                                let best: MagiMessage | null = null;
                                                let bestScore = -Infinity;
                                                for (const p of proposals) {
                                                        const score = totals.get(p.id) ?? 0;
                                                        if (!best || score > bestScore) {
                                                                best = p;
                                                                bestScore = score;
                                                        }
                                                }
                                                if (best) {
                                                        finalMsg = best;
                                                        return { question, finalMessage: finalMsg, derived: true, liveUrl };
                                                }
                                        }
                                }
                                return { question, finalMessage: finalMsg, derived: false, liveUrl };
                        }

                        // First attempt
                        let { question, finalMessage, derived, liveUrl } = await resolveFinal(s.id);

                        // Retry loop to handle any replication lag or delayed writes
                        if (!finalMessage) {
                                for (let i = 0; i < 10; i++) {
                                        await new Promise((r) => setTimeout(r, 300));
                                        const next = await resolveFinal(s.id);
                                        question = next.question;
                                        finalMessage = next.finalMessage;
                                        derived = next.derived;
                                        liveUrl = next.liveUrl;
                                        if (finalMessage) break;
                                }
                        }

                        if (!finalMessage && fallbackSummary) {
                                finalMessage = buildMessageFromSummary(fallbackSummary, fallbackFinalId);
                                derived = false;
                        }

                        setHistoryDetail({
                                id: s.id,
                                createdAt: s.created_at,
                                question,
                                finalMessage,
                                derived,
                                liveUrl: liveUrl ?? s.live_url ?? null,
                        });
                } catch (err) {
                        console.error("Failed to load history detail", err);
                        const fallbackMessage = fallbackSummary ? buildMessageFromSummary(fallbackSummary, fallbackFinalId) : null;
                        setHistoryDetail({
                                id: s.id,
                                createdAt: s.created_at,
                                question: s.question,
                                finalMessage: fallbackMessage,
                                derived: false,
                                liveUrl: s.live_url ?? null,
                        });
                } finally {
                        setHistoryDetailLoading(false);
                }
        }, []);

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
                                if (Array.isArray(data.votes)) {
                                        updateDisplayVotes(data.votes as MagiVote[]);
                                }
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

        const runStep = useCallback(async (sessionId: string, s: "propose" | "vote" | "consensus") => {
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
                        // Critiques removed
                        if (data.finalMessage) {
                                next = next.concat([data.finalMessage as MagiMessage]);
                                setDisplayConsensus(data.finalMessage as MagiMessage);
                        }
                        return next;
                });
                if (Array.isArray(data.votes)) updateDisplayVotes(data.votes as MagiVote[]);
                if (data.diagnostics) {
                        const diagArray = Array.isArray(data.diagnostics)
                                ? (data.diagnostics as MagiStepDiagnostics[])
                                : [data.diagnostics as MagiStepDiagnostics];
                        const last = diagArray[diagArray.length - 1];
                        setDebug(formatDiagnosticSummary(last));
                } else {
                        setDebug(
                                `step=${s} proposals=${Array.isArray(data.proposals) ? data.proposals.length : 0} votes=${Array.isArray(data.votes) ? data.votes.length : 0} final=${data.finalMessage ? 1 : 0}`
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
                setDisplayConsensus(null);
                setDisplayVotes([]);
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
                if (artifact && artifact.status !== "ready") {
                        setError("Wait for the uploaded bundle to finish processing.");
                        return;
                }
                if (liveUrlError) {
                        setError(liveUrlError);
                        return;
                }
                const sanitizedLiveUrl = normalizedLiveUrl ?? null;
                const q = question.trim();
                if (!q) {
                        setError("Please enter a question.");
                        return;
                }
                try {
                        setStep("creating");
                        setCurrentStage("creating");
                        const userId = await getUserId();
                        const keys = getKeys();
                        const attachedArtifactId = artifact?.status === "ready" ? artifact.id : undefined;
                        const createRes = await fetch("/api/magi/session", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                        question: q,
                                        userId,
                                        keys,
                                        artifactId: attachedArtifactId,
                                        liveUrl: sanitizedLiveUrl ?? undefined,
                                }),
                        });
                        const created = await createRes.json();
                        if (!created.ok) {
                                throw new Error(created.error || "Failed to create session");
                        }
                        const sessionId: string = created.sessionId;
                        const nowIso = new Date().toISOString();
                        setSessions((prev) => {
                                const optimistic: MagiSession = {
                                        id: sessionId,
                                        user_id: userId,
                                        question: q,
                                        status: "running",
                                        error: null,
                                        created_at: nowIso,
                                        updated_at: nowIso,
                                        finalMessageId: null,
                                        consensusSummary: null,
                                        artifact_id: attachedArtifactId ?? null,
                                        live_url: sanitizedLiveUrl,
                                };
                                const deduped = prev.filter((s) => s.id !== sessionId);
                                return [optimistic, ...deduped];
                        });
                        if (showHistory) {
                                loadSessions();
                        }
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
                        setSessions((prev) =>
                                prev.map((s) =>
                                        s.id === sessionId
                                                ? {
                                                          ...s,
                                                          status: "consensus",
                                                          updated_at: new Date().toISOString(),
                                                          finalMessageId: finalData?.finalMessage?.id ?? s.finalMessageId ?? null,
                                                          consensusSummary: finalData?.finalMessage?.content ?? s.consensusSummary ?? null,
                                                          artifact_id: s.artifact_id ?? attachedArtifactId ?? null,
                                                  }
                                                : s
                                )
                        );
                        loadSessions();
                } catch (e: any) {
                        setError(e?.message || "Unexpected error");
                        setStep("error");
                }
        }, [
                artifact,
                fetchFull,
                getKeys,
                getUserId,
                loadSessions,
                liveUrlError,
                normalizedLiveUrl,
                question,
                runStep,
                showHistory,
                verifiedAll,
        ]);

        const proposals = displayProposals.length > 0 ? displayProposals : messages.filter((m) => m.role === "agent_proposal");
        const consensusMessage = displayConsensus ?? messages.find((m) => m.role === "consensus") ?? null;
        const consensusMeta =
                consensusMessage && typeof consensusMessage.meta === "object" && consensusMessage.meta
                        ? (consensusMessage.meta as Record<string, unknown>)
                        : null;
        const consensusSourceProposalId = useMemo(() => {
                if (!consensusMeta) return null;
                const fromMessageId =
                        (consensusMeta["fromMessageId"] as number | undefined | null) ??
                        (consensusMeta["from_message_id"] as number | undefined | null) ??
                        (consensusMeta["source_message_id"] as number | undefined | null);
                return typeof fromMessageId === "number" ? fromMessageId : null;
        }, [consensusMeta]);
        const consensusScore = useMemo(() => {
                if (!consensusMeta) return null;
                const rawScore =
                        (consensusMeta["totalScore"] as number | undefined | null) ??
                        (consensusMeta["total_score"] as number | undefined | null) ??
                        (consensusMeta["score"] as number | undefined | null);
                return typeof rawScore === "number" ? rawScore : null;
        }, [consensusMeta]);
        const votesSource = useMemo(() => {
                return displayVotes;
        }, [displayVotes]);

        const votes = useMemo(() => normalizeVoteScores(votesSource), [votesSource]);

        const artifactManifest = useMemo(() => {
                return artifact?.manifest ? (artifact.manifest as Record<string, any>) : null;
        }, [artifact]);

        const artifactProcessedCount = useMemo(() => {
                if (!artifactManifest) return null;
                if (typeof artifactManifest.processedFiles === "number") return artifactManifest.processedFiles;
                if (typeof artifactManifest.totalFiles === "number") return artifactManifest.totalFiles;
                return null;
        }, [artifactManifest]);

        const artifactLanguageSummary = useMemo(() => {
                if (!artifactManifest || artifact?.status !== "ready") return null;
                const languages = artifactManifest.languages as Record<string, number> | undefined;
                if (!languages) return null;
                const top = Object.entries(languages)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 4)
                        .map(([lang, count]) => `${lang}(${count})`);
                return top.length ? top.join(", ") : null;
        }, [artifact?.status, artifactManifest]);

const artifactFileSummary = useMemo(() => {
if (!artifactManifest || artifact?.status !== "ready") return null;
const topFiles = Array.isArray(artifactManifest.topFiles)
? (artifactManifest.topFiles as Array<Record<string, any>>)
: [];
                if (!topFiles.length) return null;
return topFiles
.slice(0, 3)
.map((entry) => {
const path = typeof entry.path === "string" ? entry.path : "";
const lang = typeof entry.language === "string" ? entry.language : null;
return lang ? `${path} (${lang})` : path;
})
.filter(Boolean)
.join(", ");
}, [artifact?.status, artifactManifest]);

const artifactTokenSummary = useMemo(() => {
if (!artifactManifest || artifact?.status !== "ready") return null;
const summary = artifactManifest.tokenSummary as
| { stored?: number; approxContext?: number; chunks?: number }
| undefined;
if (!summary) return null;
const parts: string[] = [];
if (typeof summary.stored === "number") {
parts.push(`Stored: ~${summary.stored.toLocaleString()} tokens`);
}
if (typeof summary.approxContext === "number" && summary.approxContext > 0) {
parts.push(`Prompt use: ~${summary.approxContext.toLocaleString()} tokens`);
}
if (parts.length === 0) return null;
return parts.join(" • ");
}, [artifact?.status, artifactManifest]);

        const liveUrlStatusMessage = useMemo(() => {
                if (liveUrlError || !normalizedLiveUrl) return null;
                return `Live requests will target ${normalizedLiveUrl}`;
        }, [liveUrlError, normalizedLiveUrl]);

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

        const stepOrder: Step[] = ["idle", "creating", "proposing", "voting", "finalizing", "done", "error"];

        const computeStageStatus = useCallback(
                (stageKey: "proposing" | "voting" | "finalizing") => {
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

        const stageLabels: { key: "proposing" | "voting" | "finalizing"; label: string; description: string }[] = [
                { key: "proposing", label: "Proposals", description: "Each MAGI core drafts an initial response." },
                { key: "voting", label: "Voting", description: "Arguments are scored to select the strongest path." },
                { key: "finalizing", label: "Consensus", description: "The council synthesizes a unified answer." },
        ];

        const getStageBadgeClass = (status: ReturnType<typeof computeStageStatus>) =>
                clsx(
                        "ui-text text-[11px] px-2 py-0.5 rounded-full border",
                        status === "complete" && "border-magiGreen/60 text-magiGreen/80 bg-magiGreen/10",
                        status === "active" && "border-magiBlue/60 text-magiBlue/80 bg-magiBlue/10",
                        status === "pending" && "border-white/15 text-white/50 bg-white/10",
                        status === "error" && "border-red-500/60 text-red-300 bg-red-500/10"
                );

        const sortedProposals = useMemo(() => {
                return proposals.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }, [proposals]);

        const sortedVotes = useMemo(() => {
                return votes.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }, [votes]);

	return (
		<section className="mt-8">
			<header className="mb-3">
				<h2 className="title-text text-lg font-bold text-white/90">MAGI Consensus</h2>
				<p className="ui-text text-white/60 text-sm">Ask once. Three cores deliberate, then answer.</p>
			</header>
                        <div className="magi-panel border-white/15 p-4 relative">
				<input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={onFileInputChange} />
                                <div className="border border-white/10 bg-white/5 rounded-md p-3 mb-4">
                                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                                <div>
                                                        <label className="ui-text text-sm text-white/70 block">Code bundle (.zip)</label>
                                                        <p className="ui-text text-xs text-white/50">
                                                                Optional: attach a zipped repo so MAGI cores can audit real code. Max {MAX_UPLOAD_MB}MB.
                                                        </p>
                                                </div>
                                                <div className="flex flex-col w-full gap-2 md:w-auto md:flex-row">
                                                        <button
                                                                type="button"
                                                                onClick={() => fileInputRef.current?.click()}
                                                                disabled={uploadingArtifact}
                                                                className="px-3 py-1.5 rounded-md border border-white/20 bg-white/10 hover:bg-white/20 ui-text text-xs disabled:opacity-60"
                                                        >
                                                                {artifact ? "Replace bundle" : "Select .zip"}
                                                        </button>
                                                        {artifact && (
                                                                <button
                                                                        type="button"
                                                                        onClick={clearArtifact}
                                                                        className="px-3 py-1.5 rounded-md border border-white/10 bg-white/5 hover:bg-white/15 ui-text text-xs"
                                                                >
                                                                        Remove
                                                                </button>
                                                        )}
                                                </div>
                                        </div>
                                        {artifact ? (
                                                <div className="mt-3">
                                                        <div className="flex flex-wrap items-center gap-2 ui-text text-xs text-white/70">
                                                                <span className="font-semibold text-white/90">{artifact.original_filename}</span>
                                                                <span
                                                                        className={clsx(
                                                                                "uppercase tracking-widest border px-2 py-0.5 rounded-full text-[10px]",
                                                                                artifact.status === "ready" &&
                                                                                        "border-magiGreen/60 text-magiGreen/80 bg-magiGreen/10",
                                                                                artifact.status === "processing" &&
                                                                                        "border-magiBlue/60 text-magiBlue/80 bg-magiBlue/10",
                                                                                artifact.status === "uploaded" &&
                                                                                        "border-white/20 text-white/60 bg-white/5",
                                                                                artifact.status === "failed" && "border-red-500/60 text-red-300 bg-red-500/10"
                                                                        )}
                                                                >
                                                                        {artifact.status}
                                                                </span>
                                                        </div>
                                                        {artifactProcessedCount !== null && (
                                                                <div className="ui-text text-[11px] text-white/60 mt-1">
                                                                        Files processed: {artifactProcessedCount}
                                                                </div>
                                                        )}
                                                        {artifactLanguageSummary && (
                                                                <div className="ui-text text-[11px] text-white/60 mt-1">
                                                                        Languages: {artifactLanguageSummary}
                                                                </div>
                                                        )}
{artifactFileSummary && (
<div className="ui-text text-[11px] text-white/60 mt-1">
Key files: {artifactFileSummary}
</div>
)}
{artifactTokenSummary && (
<div className="ui-text text-[11px] text-white/60 mt-1">
Token budget: {artifactTokenSummary}
</div>
)}
                                                </div>
                                        ) : (
                                                <p className="ui-text text-xs text-white/50 mt-2">
                                                        No bundle attached. MAGI will answer from the prompt alone.
                                                </p>
                                        )}
                                        {artifactStatusMessage && (
                                                <div className="ui-text text-xs text-white/60 mt-2">{artifactStatusMessage}</div>
                                        )}
                                        {artifactError && <div className="ui-text text-xs text-red-400 mt-2">{artifactError}</div>}
                                </div>
                                <div className="border border-white/10 bg-white/5 rounded-md p-3 mb-4">
                                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                                <div>
                                                        <label className="ui-text text-sm text-white/70 block">Live site URL</label>
                                                        <p className="ui-text text-xs text-white/50">
                                                                Optional: allow MAGI to run HTTP probes (curl-style requests) against your deployed site.
                                                        </p>
                                                </div>
                                                {liveUrl && (
                                                        <button
                                                                type="button"
                                                                onClick={clearLiveUrl}
                                                                className="px-3 py-1.5 rounded-md border border-white/10 bg-white/5 hover:bg-white/15 ui-text text-xs"
                                                        >
                                                                Remove
                                                        </button>
                                                )}
                                        </div>
                                        <input
                                                type="url"
                                                value={liveUrl}
                                                onChange={(e) => setLiveUrl(e.target.value)}
                                                placeholder="https://example.com"
                                                className="mt-2 w-full rounded-md bg-white/10 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/40"
                                        />
                                        {liveUrlStatusMessage && (
                                                <div className="ui-text text-xs text-white/60 mt-2">{liveUrlStatusMessage}</div>
                                        )}
                                        {liveUrlError && <div className="ui-text text-xs text-red-400 mt-2">{liveUrlError}</div>}
                                        {!liveUrl && (
                                                <p className="ui-text text-xs text-white/50 mt-2">
                                                        No live target provided. MAGI will rely on your prompt and any uploaded bundle.
                                                </p>
                                        )}
                                </div>
                                <label className="ui-text text-sm text-white/70 block mb-2">Question</label>
                                <textarea
                                        value={question}
                                        onChange={(e) => setQuestion(e.target.value)}
                                        rows={3}
                                        className="w-full rounded-md bg-white/10 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/40"
                                        placeholder="e.g., Audit the uploaded payments service for security flaws"
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
                                                        <div key={stage.key} className="bg-white/10 border border-white/10 rounded p-3">
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

                                                                {/* Proposals quick summary + modal trigger */}
                                                                {stage.key === "proposing" && (
                                                                        <div className="mt-3">
                                                                                <div className="flex items-center justify-between">
                                                                                        <span className="ui-text text-[11px] text-white/50">{sortedProposals.length} captured</span>
                                                                                        <button
                                                                                                type="button"
                                                                                                onClick={() => setShowProposalsModal(true)}
                                                                                                className="ui-text text-[11px] px-2 py-0.5 rounded border border-white/15 bg-white/10 hover:bg-white/15"
                                                                                        >
                                                                                                View
                                                                                        </button>
                                                                                </div>
                                                                        </div>
                                                                )}

                                                                {/* Voting quick summary + modal trigger */}
                                                                {stage.key === "voting" && (
                                                                        <div className="mt-3">
                                                                                <div className="flex items-center justify-between">
                                                                                        <span className="ui-text text-[11px] text-white/50">{sortedVotes.length} votes tallied</span>
                                                                                        <button
                                                                                                type="button"
                                                                                                onClick={() => setShowVotesModal(true)}
                                                                                                className="ui-text text-[11px] px-2 py-0.5 rounded border border-white/15 bg-white/10 hover:bg-white/15"
                                                                                        >
                                                                                                View
                                                                                        </button>
                                                                                </div>
                                                                        </div>
                                                                )}
                                                        </div>
                                                );
                                        })}
                                </div>
                        </div>

                        {/* History detail modal */}
                        {showHistoryDetail && (
                                <div className="fixed inset-0 z-50">
                                        <div className="absolute inset-0 bg-black/70" onClick={() => setShowHistoryDetail(false)} />
                                        <div className="relative z-10 mx-auto my-8 w-[95vw] max-w-3xl bg-black border border-white/15 rounded-lg shadow-xl">
                                                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                                                        <div className="title-text text-base font-semibold text-white/90">Past Chat</div>
                                                        <button
                                                                onClick={() => setShowHistoryDetail(false)}
                                                                className="ui-text text-xs px-2 py-0.5 rounded border border-white/20 hover:bg-white/10"
                                                        >
                                                                Close
                                                        </button>
                                                </div>
                                                <div className="p-4 max-h-[80vh] overflow-auto no-scrollbar">
                                                        {historyDetailLoading ? (
                                                                <div className="ui-text text-sm text-white/60">Loading…</div>
                                                        ) : historyDetail ? (
                                                                <div className="space-y-4">
                                                                        <div className="ui-text text-[11px] text-white/50">
                                                                                {new Date(historyDetail.createdAt).toLocaleString()}
                                                                        </div>
                                                                        <div className="bg-black border border-white/10 rounded p-3">
                                                                                <div className="title-text text-sm font-semibold text-white/80">Initial Prompt</div>
                                                                                <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">
                                                                                        {historyDetail.question || "—"}
                                                                                </div>
                                                                        </div>
                                                                        {historyDetail.liveUrl && (
                                                                                <div className="bg-black border border-white/10 rounded p-3">
                                                                                        <div className="title-text text-sm font-semibold text-white/80">Live URL</div>
                                                                                        <a
                                                                                                href={historyDetail.liveUrl}
                                                                                                target="_blank"
                                                                                                rel="noreferrer noopener"
                                                                                                className="ui-text text-sm text-magiBlue hover:underline break-all mt-2 inline-block"
                                                                                        >
                                                                                                {historyDetail.liveUrl}
                                                                                        </a>
                                                                                </div>
                                                                        )}
                                                                        <div className="bg-black border border-white/10 rounded p-3">
                                                                                <div className="title-text text-sm font-semibold text-white/80">Final Consensus</div>
                                                                                {historyDetail.finalMessage ? (
                                                                                        <>
                                                                                                <div className="ui-text text-[11px] text-white/50">
                                                                                                        #{historyDetail.finalMessage.id}
                                                                                                        {historyDetail.derived && " · derived from top-scoring proposal"}
                                                                                                </div>
                                                                                                <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">
                                                                                                        {historyDetail.finalMessage.content}
                                                                                                </div>
                                                                                        </>
                                                                                ) : (
                                                                                        <div className="ui-text text-sm text-white/60 mt-2">No consensus message recorded.</div>
                                                                                )}
                                                                        </div>
                                                                </div>
                                                        ) : (
                                                                <div className="ui-text text-sm text-white/60">No data available.</div>
                                                        )}
                                                </div>
                                        </div>
                                </div>
                        )}

                        {/* Modals for stage details */}
                        {showProposalsModal && (
                                <div className="fixed inset-0 z-50">
                                        <div className="absolute inset-0 bg-black/70" onClick={() => setShowProposalsModal(false)} />
                                        <div className="relative z-10 mx-auto my-8 w-[95vw] max-w-5xl bg-black border border-white/15 rounded-lg shadow-xl">
                                                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                                                        <div className="title-text text-base font-semibold text-white/90">Proposal Drafts</div>
                                                        <button
                                                                onClick={() => setShowProposalsModal(false)}
                                                                className="ui-text text-xs px-2 py-0.5 rounded border border-white/20 hover:bg-white/10"
                                                        >
                                                                Close
                                                        </button>
                                                </div>
                                                <div className="p-4 max-h-[80vh] overflow-auto no-scrollbar">
                                                        {agents.length > 0 ? (
                                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                                        {agents.map((a) => {
                                                                                const agentProposals = sortedProposals.filter((p) => p.agent_id === a.id);
                                                                                return (
                                                                                        <div key={a.id} className="bg-black border border-white/10 rounded p-3">
                                                                                                <div className="flex items-center justify-between">
                                                                                                        <div className="title-text text-sm font-semibold text-white/80">{a.name}</div>
                                                                                                        <span className="ui-text text-[11px] uppercase tracking-widest text-white/40">{a.provider}</span>
                                                                                                </div>
                                                                                                <div className="mt-3 space-y-3">
                                                                                                        {agentProposals.length > 0 ? (
                                                                                                                agentProposals.map((proposal) => {
                                                                        const httpRequestCount = readMessageMetaNumber(proposal.meta, "httpRequestCount") ?? 0;
                                                                        const httpLabel = httpRequestCount === 1 ? "1 HTTP probe" : `${httpRequestCount} HTTP probes`;
                                                                        return (
                                                                                <div key={proposal.id} className="bg-black border border-white/10 rounded p-3">
                                                                                        <div className="ui-text text-[11px] text-white/50 flex items-center justify-between gap-2">
                                                                                                <span>#{proposal.id}</span>
                                                                                                <span>{httpLabel}</span>
                                                                                        </div>

                                                                                        <div className="ui-text text-sm text-white/80 whitespace-pre-wrap mt-2">
                                                                                                {proposal.content}
                                                                                        </div>
                                                                                </div>
                                                                        );
                                                                })
                                                                                                        ) : (
                                                                                                                <div className="ui-text text-sm text-white/50">No proposal recorded.</div>
                                                                                                        )}
                                                                                                </div>
                                                                                        </div>
                                                                                );
                                                                        })}
                                                                </div>
                                                        ) : (
                                                                <div className="ui-text text-sm text-white/50 mt-2">Awaiting agent telemetry.</div>
                                                        )}
                                                </div>
                                        </div>
                                </div>
                        )}

                        {showVotesModal && (
                                <div className="fixed inset-0 z-50">
                                        <div className="absolute inset-0 bg-black/70" onClick={() => setShowVotesModal(false)} />
                                        <div className="relative z-10 mx-auto my-8 w-[95vw] max-w-5xl bg-black border border-white/15 rounded-lg shadow-xl">
                                                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                                                        <div className="title-text text-base font-semibold text-white/90">Voting Ledger</div>
                                                        <button
                                                                onClick={() => setShowVotesModal(false)}
                                                                className="ui-text text-xs px-2 py-0.5 rounded border border-white/20 hover:bg-white/10"
                                                        >
                                                                Close
                                                        </button>
                                                </div>
                                                <div className="p-4 overflow-x-auto max-h-[80vh] overflow-y-auto no-scrollbar">
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
                                                                                                <tr key={vote.id} className="border-t border-white/10 align-top">
                                                                                                        <td className="py-2 pr-4">{agent ? agent.name : vote.agent_id}</td>
                                                                                                                                <td className="py-2 pr-4">
                                                                                                                                        {target ? (
                                                                                                                                                <div className="group relative inline-block">
                                                                                                                                                        <span className="cursor-help hover:underline">
                                                                                                                                                                Proposal #{target.id}
                                                                                                                                                                {target.agent_id && agentById[target.agent_id]?.name
                                                                                                                                                                        ? ` (${agentById[target.agent_id]?.name})`
                                                                                                                                                                        : ""}
                                                                                                                                                        </span>
                                                                                                                                                        {/* Hover preview popover */}
                                                                                                                                                        <div className="absolute left-0 top-full mt-1 w-[28rem] max-w-[80vw] bg-black border border-white/20 rounded p-2 shadow-xl z-50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                                                                                                                                                <div className="ui-text text-[11px] text-white/50 mb-1">Proposal #{target.id}</div>
                                                                                                                                                                <div className="ui-text text-sm text-white/80 whitespace-pre-wrap max-h-48 overflow-auto no-scrollbar">
                                                                                                                                                                        {target.content}
                                                                                                                                                                </div>
                                                                                                                                                        </div>
                                                                                                                                                </div>
                                                                                                                                        ) : (
                                                                                                                                                `#${vote.target_message_id}`
                                                                                                                                        )}
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
                                </div>
                        )}

                        {/* Stage detail panels (Consensus remains as a panel) */}
                        <div className="mt-4 space-y-4">

				{/* Tucked-away History drawer inside the chat panel */}
				{showHistory && (
					<div className="absolute top-0 right-0 h-full w-72 bg-black/50 border-l border-white/15 p-3 overflow-y-auto no-scrollbar backdrop-blur-sm">
						<div className="flex items-center justify-between mb-2 gap-2">
							<div className="title-text text-sm font-semibold text-white/80">Past Chats</div>
							<div className="flex items-center gap-2">
								{sessions.length > 0 && (
									<button
										onClick={() => {
											setShowClearConfirm(true);
											setClearHistoryError(null);
										}}
										className="ui-text text-xs px-2 py-0.5 rounded border border-white/20 hover:bg-white/10"
										title="Clear all history"
									>
										Clear
									</button>
								)}
								<button
									onClick={() => {
										setShowClearConfirm(false);
										setClearHistoryError(null);
										setShowHistory(false);
									}}
									className="ui-text text-xs px-2 py-0.5 rounded border border-white/20 hover:bg-white/10"
									title="Close"
								>
									Close
								</button>
							</div>
						</div>
						{showClearConfirm && (
							<div className="mb-3 rounded border border-red-400/40 bg-red-500/10 p-3">
								<div className="ui-text text-sm text-white/80">
									This will permanently delete all recorded MAGI chats for this account. Continue?
								</div>
								{clearHistoryError && (
									<div className="ui-text text-xs text-red-300 mt-2">{clearHistoryError}</div>
								)}
								<div className="mt-3 flex items-center gap-2">
									<button
										onClick={clearHistory}
										disabled={clearingHistory}
										className="ui-text text-xs px-3 py-1 rounded border border-red-400 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-60"
									>
										{clearingHistory ? "Clearing…" : "Yes, delete"}
									</button>
									<button
										onClick={() => {
											setShowClearConfirm(false);
											setClearHistoryError(null);
										}}
										disabled={clearingHistory}
										className="ui-text text-xs px-3 py-1 rounded border border-white/20 hover:bg-white/10 disabled:opacity-60"
									>
										Cancel
									</button>
								</div>
							</div>
						)}
						{loadingSessions ? (
							<div className="ui-text text-sm text-white/60">Loading…</div>
						) : sessions.length === 0 ? (
							<div className="ui-text text-sm text-white/60">No past chats yet.</div>
						) : (
							<ul className="space-y-2">
								{sessions.map((s) => {
									const created = new Date(s.created_at);
									const when = created.toLocaleString();
									return (
										<li key={s.id}>
											<button
												onClick={() => openHistoryDetail(s)}
												className="w-full text-left bg-white/10 hover:bg-white/15 border border-white/10 rounded p-2"
											>
												<div className="ui-text text-[11px] text-white/50 mb-1">{when}</div>
                                                                                                <div className="ui-text text-sm text-white/80 truncate">{s.question}</div>
                                                                                                <div className="ui-text text-[11px] mt-1 text-white/50">Status: {s.status}</div>
                                                                                                {s.live_url && (
                                                                                                        <div className="ui-text text-[11px] mt-1 text-magiBlue/80 truncate">
                                                                                                                Live URL: {s.live_url}
                                                                                                        </div>
                                                                                                )}
                                                                                        </button>
                                                                                </li>
                                                                        );
                                                                })}
                                                        </ul>
						)}
					</div>
				)}

                                {/* Critiques panel removed */}

                                {/* Voting Ledger moved inline into the Voting stage card */}

                                <div className="relative">
                                        <details className="magi-panel border-white/15 p-4 group" data-step="consensus">
                                        <summary className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 cursor-pointer list-none">
                                                <div>
                                                        <h3 className="title-text text-base font-semibold text-white/90">Final Consensus</h3>
                                                        <p className="ui-text text-sm text-white/60">
                                                                The selected plan surfaced by the MAGI cores.
                                                        </p>
                                                </div>
                                                <span className="ui-text text-xs text-white/50">
                                                        {consensusMessage ? `Ready · #${consensusMessage.id}` : "Awaiting resolution"}
                                                </span>
                                        </summary>
                                        {consensusMessage ? (
                                                <div className="mt-4 bg-black/50 border border-white/10 rounded p-4">
                                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                                <div className="ui-text text-sm text-white/70">
                                                                        Derived from
                                                                        {" "}
                                                                        {consensusSourceProposalId ? (
                                                                                <span className="text-white">
                                                                                        proposal #{consensusSourceProposalId}
                                                                                </span>
                                                                        ) : (
                                                                                <span className="text-white">the top-scoring proposal</span>
                                                                        )}
                                                                </div>
                                                                {typeof consensusScore === "number" && (
                                                                        <div className="ui-text text-xs text-white/60">
                                                                                Total score: <span className="text-white/80">{consensusScore}</span>
                                                                        </div>
                                                                )}
                                                        </div>
                                                        <div className="ui-text text-sm text-white/90 whitespace-pre-wrap mt-3">
                                                                {consensusMessage.content}
                                                        </div>
                                                </div>
                                        ) : (
                                                <div className="ui-text text-sm text-white/50 mt-4">
                                                        Consensus will appear here once the council finishes deliberating.
                                                </div>
                                        )}
                                        </details>
                                </div>
                        </div>

		</section>
	);
}


