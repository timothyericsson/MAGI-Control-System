export function safeLoad(key: string): string | null {
	try {
		if (typeof window === "undefined") return null;
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function safeSave(key: string, value: string): void {
	try {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

export function safeRemove(key: string): void {
	try {
		if (typeof window === "undefined") return;
		window.localStorage.removeItem(key);
	} catch {
		// ignore
	}
}


