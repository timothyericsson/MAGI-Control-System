import { normalizeLiveUrl } from "@/lib/liveUrl";

const MAX_FETCH_BYTES = 256 * 1024; // 256KB snapshot
const MAX_CONTEXT_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 8000;

function stripHtml(html: string): string {
        const withoutScripts = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ");
        const withoutStyles = withoutScripts.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ");
        const withoutComments = withoutStyles.replace(/<!--([\s\S]*?)-->/g, " ");
        const withoutTags = withoutComments.replace(/<[^>]+>/g, " ");
        return withoutTags;
}

function collapseWhitespace(text: string): string {
        return text.replace(/\s+/g, " ").trim();
}

export async function buildLiveUrlContext(liveUrl: string, maxChars = MAX_CONTEXT_CHARS): Promise<string | null> {
        const normalized = normalizeLiveUrl(liveUrl);
        if (!normalized) return null;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
                const res = await fetch(normalized, {
                        method: "GET",
                        redirect: "follow",
                        signal: controller.signal,
                        headers: {
                                "User-Agent": "MAGI/1.0 (+security audit)",
                                Accept: "text/html, text/plain;q=0.9, */*;q=0.1",
                        },
                });
                clearTimeout(timeout);
                if (!res.ok) {
                        return `Live URL ${normalized} responded with HTTP ${res.status}`;
                }
                const contentType = res.headers.get("content-type") || "";
                const arrayBuffer = await res.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer).subarray(0, MAX_FETCH_BYTES);
                let text = buffer.toString("utf-8");
                if (/html/i.test(contentType) || /<[^>]+>/i.test(text)) {
                        text = stripHtml(text);
                }
                text = collapseWhitespace(text);
                if (!text) {
                        return `Live URL ${normalized} did not return readable text.`;
                }
                if (text.length > maxChars) {
                        text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
                }
                const statusText = res.statusText ? ` ${res.statusText}` : "";
                const headerLines = [
                        `Live site snapshot`,
                        `URL: ${normalized}`,
                        `Status: ${res.status}${statusText}`.trim(),
                ];
                if (contentType) headerLines.push(`Content-Type: ${contentType}`);
                return `${headerLines.join("\n")}\n\n${text}`;
        } catch (err: any) {
                const message = typeof err?.message === "string" ? err.message : "unknown error";
                return `Live URL ${normalized} could not be fetched: ${message}`;
        } finally {
                clearTimeout(timeout);
        }
}
