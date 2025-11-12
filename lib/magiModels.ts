import type { MagiAgent } from "@/lib/magiTypes";

type Provider = MagiAgent["provider"];

export const DEFAULT_MODELS: Record<Provider, string> = {
        openai: "gpt-4o-mini",
        anthropic: "claude-3-5-sonnet-20240620",
        grok: "grok-2-latest",
};

/**
 * Normalize provider model identifiers so we always call a supported model.
 * Handles legacy aliases that may be stored in the database and ensures we
 * fall back to a sensible default when none is provided.
 */
export function canonicalModelFor(provider: Provider, requested?: string | null): string {
        const trimmed = (requested ?? "").trim();

        if (provider === "anthropic") {
                if (!trimmed || trimmed === "claude-3-5-sonnet") {
                        return DEFAULT_MODELS.anthropic;
                }
                // Allow any explicit Claude identifier through unchanged.
                return trimmed;
        }

        if (provider === "grok") {
                if (!trimmed) {
                        return DEFAULT_MODELS.grok;
                }
                if (trimmed === "grok-2-mini" || trimmed === "grok-mini" || trimmed === "grok-2") {
                        return DEFAULT_MODELS.grok;
                }
                return trimmed;
        }

        // OpenAI
        return trimmed || DEFAULT_MODELS.openai;
}

