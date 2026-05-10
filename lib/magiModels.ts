import type { MagiAgent } from "@/lib/magiTypes";

type Provider = MagiAgent["provider"];

/**
 * Normalize provider model identifiers so we always call the exact value
 * configured for the agent. The database is the sole source of truth, so we
 * simply trim whitespace and require a non-empty model string.
 */
export function canonicalModelFor(provider: Provider, requested?: string | null): string {
        const trimmed = typeof requested === "string" ? requested.trim() : "";

        if (!trimmed) {
                throw new Error(`Model not specified for provider ${provider}`);
        }

        return trimmed;
}

