import { fetchWithSafeRedirects } from "@/lib/safeOutbound";

const MAX_REQUEST_BODY_BYTES = 64 * 1024; // 64KB agent-supplied body
const MAX_RESPONSE_BYTES = 256 * 1024; // limit downloads similar to snapshot
const REQUEST_TIMEOUT_MS = 8000;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface LiveHttpRequestOptions {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
}

export interface LiveHttpResponsePayload {
        url: string;
        status: number;
        statusText: string;
        headers: Record<string, string>;
        bodyPreview: string;
        truncated: boolean;
        bytes: number;
}

function sanitizeHeaders(input: Record<string, string> | undefined | null): Record<string, string> {
        if (!input) return {};
        const forbidden = new Set(["host", "content-length"]);
        const sanitized: Record<string, string> = {};
        for (const [key, value] of Object.entries(input)) {
                        if (!key) continue;
                        if (forbidden.has(key.toLowerCase())) continue;
                        if (typeof value !== "string") continue;
                        sanitized[key] = value;
        }
        return sanitized;
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<{ buffer: Buffer; truncated: boolean }> {
        if (!stream) return { buffer: Buffer.alloc(0), truncated: false };
        const reader = stream.getReader();
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                        received += value.byteLength;
                        if (received > limit) {
                                const allowed = limit - (received - value.byteLength);
                                if (allowed > 0) {
                                        chunks.push(Buffer.from(value.subarray(0, allowed)));
                                }
                                truncated = true;
                                break;
                        }
                        chunks.push(Buffer.from(value));
                }
        }
        await reader.cancel().catch(() => {});
        return { buffer: Buffer.concat(chunks), truncated };
}

export async function performLiveHttpRequest(options: LiveHttpRequestOptions): Promise<LiveHttpResponsePayload> {
        const method = (options.method || "GET").toUpperCase();
        if (!ALLOWED_METHODS.has(method)) {
                throw new Error("HTTP method not allowed");
        }

        let body: string | undefined;
        if (typeof options.body === "string" && options.body.length > 0) {
                const bodyBytes = Buffer.byteLength(options.body, "utf-8");
                if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
                        throw new Error("Request body too large");
                }
                body = options.body;
        }

        const headers = sanitizeHeaders(options.headers);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
                const { response: res, url } = await fetchWithSafeRedirects(options.url, {
                        method,
                        headers,
                        body,
                        signal: controller.signal,
                });
                const { buffer, truncated } = await readLimited(res.body, MAX_RESPONSE_BYTES);
                const text = buffer.toString("utf-8");
                const headersObject: Record<string, string> = {};
                for (const [key, value] of res.headers.entries()) {
                        headersObject[key] = value;
                }
                return {
                        url,
                        status: res.status,
                        statusText: res.statusText || "",
                        headers: headersObject,
                        bodyPreview: text,
                        truncated,
                        bytes: buffer.byteLength,
                };
        } finally {
                clearTimeout(timeout);
        }
}
