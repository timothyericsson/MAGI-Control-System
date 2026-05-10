import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeLiveUrl } from "@/lib/liveUrl";

const ALLOWED_PORTS = new Set(["", "80", "443"]);
const MAX_REDIRECTS = 3;

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal") ||
		normalized.endsWith(".lan") ||
		normalized.endsWith(".home.arpa")
	);
}

function ipv4Parts(address: string): number[] | null {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return null;
	}
	return parts;
}

export function isBlockedIPv4(address: string): boolean {
	const parts = ipv4Parts(address);
	if (!parts) return true;
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a >= 224) return true;
	return false;
}

export function isBlockedIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) {
		return isBlockedIPv4(mapped[1]);
	}
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe80") ||
		normalized.startsWith("ff")
	);
}

function isBlockedAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return isBlockedIPv4(address);
	if (version === 6) return isBlockedIPv6(address);
	return true;
}

export async function validateOutboundUrl(raw: string): Promise<URL> {
	const normalized = normalizeLiveUrl(raw);
	if (!normalized) {
		throw new Error("Invalid or unsupported URL");
	}
	const parsed = new URL(normalized);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Invalid or unsupported URL");
	}
	if (!ALLOWED_PORTS.has(parsed.port)) {
		throw new Error("Only ports 80 and 443 are allowed");
	}

	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	if (isBlockedHostname(hostname)) {
		throw new Error("Local hostnames are not allowed");
	}

	const ipVersion = isIP(hostname);
	const addresses =
		ipVersion === 0
			? await lookup(hostname, { all: true, verbatim: false })
			: [{ address: hostname, family: ipVersion }];
	if (addresses.length === 0) {
		throw new Error("Unable to resolve hostname");
	}
	if (addresses.some((address) => isBlockedAddress(address.address))) {
		throw new Error("Private or reserved network addresses are blocked");
	}

	return parsed;
}

export async function fetchWithSafeRedirects(
	rawUrl: string,
	init: RequestInit,
	maxRedirects = MAX_REDIRECTS
): Promise<{ response: Response; url: string }> {
	let current = await validateOutboundUrl(rawUrl);
	let method = init.method || "GET";
	let body = init.body;

	for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
		const response = await fetch(current, {
			...init,
			method,
			body,
			redirect: "manual",
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			return { response, url: current.toString() };
		}

		const location = response.headers.get("location");
		if (!location) {
			return { response, url: current.toString() };
		}
		if (redirects === maxRedirects) {
			throw new Error("Too many redirects");
		}

		await response.body?.cancel().catch(() => {});
		current = await validateOutboundUrl(new URL(location, current).toString());
		if (response.status === 303 || ([301, 302].includes(response.status) && method.toUpperCase() === "POST")) {
			method = "GET";
			body = undefined;
		}
	}

	throw new Error("Too many redirects");
}
