export function safeLoad(key: string): string | null {
	try {
		if (typeof window === "undefined") return null;
		if (key.startsWith("magi_provider_")) {
			window.localStorage.removeItem(key);
		}
		return window.sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

export function safeSave(key: string, value: string): void {
	try {
		if (typeof window === "undefined") return;
		window.localStorage.removeItem(key);
		window.sessionStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

export function safeRemove(key: string): void {
	try {
		if (typeof window === "undefined") return;
		window.sessionStorage.removeItem(key);
		window.localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

