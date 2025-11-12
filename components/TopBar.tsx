"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function TopBar() {
	const [isAuthed, setIsAuthed] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let mounted = true;
		async function init() {
			if (!supabaseBrowser) return;
			const { data } = await supabaseBrowser.auth.getSession();
			if (!mounted) return;
			setIsAuthed(Boolean(data.session));
			setLoading(false);
		}
		init();
		if (!supabaseBrowser) return;
		const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
			setIsAuthed(Boolean(session));
		});
		return () => {
			mounted = false;
			sub.subscription.unsubscribe();
		};
	}, []);

	async function handleLogout() {
		if (!supabaseBrowser) return;
		await supabaseBrowser.auth.signOut();
		window.location.href = "/login";
	}

	return (
		<div className="fixed right-4 top-4 z-50">
			{!loading && isAuthed && (
				<button
					onClick={handleLogout}
					className="ui-text px-4 py-1.5 rounded-md border border-white/20 bg-white/10 hover:bg-white/15 transition"
					title="Sign out"
				>
					Log out
				</button>
			)}
		</div>
	);
}


