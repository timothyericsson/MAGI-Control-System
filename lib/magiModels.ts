import type { MagiAgent } from "@/lib/magiTypes";

type Provider = MagiAgent["provider"];

export const DEFAULT_MODELS: Record<Provider, string> = {
openai: "gpt-5.1",
anthropic: "claude-sonnet-4-5",
grok: "grok-4-fast-reasoning",
};

/**
 * Normalize provider model identifiers so we always call a supported model.
 * Handles legacy aliases that may be stored in the database and ensures we
 * fall back to a sensible default when none is provided.
 */
export function canonicalModelFor(provider: Provider, requested?: string | null): string {
        const trimmed = (requested ?? "").trim();

        if (trimmed) {
                return trimmed;
        }

        return DEFAULT_MODELS[provider];
}

