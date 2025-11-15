export type MagiSessionStatus = "pending" | "running" | "consensus" | "complete" | "error";

export type MagiMessageKind = "user" | "agent_proposal" | "agent_critique" | "system" | "consensus";

export interface MagiAgent {
	id: string;
	slug: "casper" | "balthasar" | "melchior";
	name: string;
	provider: "openai" | "anthropic" | "grok";
	model: string | null;
	color: string | null;
	created_at: string;
}

export interface MagiSession {
	id: string;
	user_id: string;
	question: string;
	artifact_id?: string | null;
	status: MagiSessionStatus;
	error: string | null;
	created_at: string;
	updated_at: string;
	finalMessageId?: number | null;
	consensusSummary?: string | null;
}

export interface MagiMessage {
	id: number;
	session_id: string;
	agent_id: string | null;
	role: MagiMessageKind;
	content: string;
	model: string | null;
	tokens: number | null;
	meta: Record<string, unknown>;
	created_at: string;
}

export interface MagiVote {
	id: number;
	session_id: string;
	agent_id: string;
	target_message_id: number;
	score: number;
	rationale: string | null;
	created_at: string;
}

export interface MagiConsensus {
	session_id: string;
	final_message_id: number | null;
	summary: string | null;
	created_at: string;
}

export interface CreateSessionRequestBody {
        question: string;
        userId?: string;
        artifactId?: string;
        keys?: {
                openai?: string;
                anthropic?: string;
                grok?: string;
                xai?: string;
        };
}

export type MagiWorkflowStep = "propose" | "vote" | "consensus";

export interface StepRequestBody {
        step: MagiWorkflowStep;
        userId?: string;
        keys?: {
                openai?: string;
                anthropic?: string;
                grok?: string;
                xai?: string;
        };
}

export interface MagiDiagnosticsProposalSummary {
	id: number;
	fallback: boolean;
	preview: string;
}

export interface MagiDiagnosticsCritiqueSummary {
	id: number;
	targetMessageId: number | null;
	fallback: boolean;
	preview: string;
}

export interface MagiDiagnosticsVoteSummary {
	id: number;
	targetMessageId: number;
	score: number;
	rationale: string | null;
	fallback: boolean;
}

export interface MagiStepDiagnosticsAgent {
	agentId: string;
	name: string;
	provider: MagiAgent["provider"];
	proposals: MagiDiagnosticsProposalSummary[];
	critiquesAuthored: MagiDiagnosticsCritiqueSummary[];
	critiquesReceived: MagiDiagnosticsCritiqueSummary[];
	votesCast: MagiDiagnosticsVoteSummary[];
	fallbackCount: number;
}

export interface MagiStepDiagnostics {
	step: MagiWorkflowStep;
	timestamp: string;
	totals: {
		proposals: number;
		critiques: number;
		votes: number;
		consensus: number;
	};
	agents: MagiStepDiagnosticsAgent[];
	events: string[];
	winningProposalId?: number | null;
	winningScore?: number | null;
	consensusMessageId?: number | null;
}


