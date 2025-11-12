"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
	const [checking, setChecking] = useState(true);
	const [allowed, setAllowed] = useState(false);

	useEffect(() => {
		let mounted = true;
		async function check() {
			if (!supabaseBrowser) {
				setAllowed(false);
				setChecking(false);
				return;
			}
			const { data } = await supabaseBrowser.auth.getSession();
			if (!mounted) return;
			if (data.session) {
				setAllowed(true);
				setChecking(false);
			} else {
				setAllowed(false);
				setChecking(false);
				window.location.href = "/login";
			}
		}
		check();
		return () => {
			mounted = false;
		};
	}, []);

	if (checking) {
		return (
			<div className="min-h-[60vh] flex items-center justify-center">
				<div className="title-text text-white/80 tracking-[0.35em]">VERIFYING ACCESS…</div>
			</div>
		);
	}

	if (!allowed) return null;
	return <>{children}</>;
}


