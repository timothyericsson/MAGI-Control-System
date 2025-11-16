export function normalizeLiveUrl(raw: string | null | undefined): string | null {
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        let candidate = trimmed;
        if (!/^https?:\/\//i.test(candidate)) {
                candidate = `https://${candidate}`;
        }
        try {
                const parsed = new URL(candidate);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                        return null;
                }
                parsed.hash = "";
                return parsed.toString();
        } catch {
                return null;
        }
}
