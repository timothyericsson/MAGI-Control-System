import { normalizeLiveUrl } from "@/lib/liveUrl";
import { isIP } from "node:net";

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

function isPrivateIPv4(host: string): boolean {
        const parts = host.split(".").map((p) => Number.parseInt(p, 10));
        if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
        if (parts[0] === 10) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 127) return true;
        return false;
}

function isPrivateIPv6(host: string): boolean {
        const normalized = host.toLowerCase();
        return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
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
        const normalized = normalizeLiveUrl(options.url);
        if (!normalized) {
                throw new Error("Invalid or unsupported URL");
        }
        const parsed = new URL(normalized);
        if (parsed.port && !["80", "443"].includes(parsed.port)) {
                throw new Error("Only ports 80 and 443 are allowed");
        }
        const hostname = parsed.hostname;
        if (hostname === "localhost" || hostname.endsWith(".local")) {
                throw new Error("Local hostnames are not allowed");
        }
        const ipVersion = isIP(hostname);
        if (ipVersion === 4 && isPrivateIPv4(hostname)) {
                throw new Error("Private network IPv4 addresses are blocked");
        }
        if (ipVersion === 6 && isPrivateIPv6(hostname)) {
                throw new Error("Private network IPv6 addresses are blocked");
        }

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
                const res = await fetch(parsed, {
                        method,
                        headers,
                        body,
                        redirect: "follow",
                        signal: controller.signal,
                });
                const { buffer, truncated } = await readLimited(res.body, MAX_RESPONSE_BYTES);
                const text = buffer.toString("utf-8");
                const headersObject: Record<string, string> = {};
                for (const [key, value] of res.headers.entries()) {
                        headersObject[key] = value;
                }
                return {
                        url: res.url || normalized,
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
