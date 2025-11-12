"use client";

import { useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function LoginPage() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!supabaseBrowser) return;
		setLoading(true);
		setMessage(null);
		setError(null);
		const { data, error } = await supabaseBrowser.auth.signInWithPassword({ email, password });
		setLoading(false);
		if (error) {
			setError(error.message);
			return;
		}
		if (data.session) {
			setMessage("Welcome back. Redirecting…");
			window.location.href = "/";
		} else {
			setMessage("Check your email to continue.");
		}
	}

	return (
		<main className="px-6 py-10 max-w-[1100px] mx-auto min-h-[80vh] flex items-center justify-center">
			<div className="relative w-full max-w-xl magi-panel border-white/15 p-6 md:p-8 auth-panel-enter">
				<div className="pointer-events-none absolute inset-0 opacity-[0.05] bg-center bg-cover" style={{ backgroundImage: "url(/magi_background.png)" }} />
				<header className="relative z-10 mb-6">
					<h1 className="title-text auth-title text-2xl md:text-3xl font-bold">ACCESS AUTHORIZATION</h1>
					<div className="auth-divider mt-3" />
				</header>
				<form onSubmit={onSubmit} className="relative z-10 space-y-4 auth-scan">
					<div>
						<label className="ui-text text-sm text-white/75 block mb-1">Email</label>
						<input
							type="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/50"
						/>
					</div>
					<div>
						<label className="ui-text text-sm text-white/75 block mb-1">Password</label>
						<input
							type="password"
							required
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/50"
						/>
					</div>
					<button
						type="submit"
						disabled={loading}
						className="ui-text mt-2 px-5 py-2 rounded-md bg-white/10 hover:bg-white/15 transition border border-white/15 disabled:opacity-60"
					>
						{loading ? "Authenticating…" : "Enter MAGI"}
					</button>
					{error && <p className="ui-text text-sm text-red-400">{error}</p>}
					{message && <p className="ui-text text-sm text-magiGreen">{message}</p>}
				</form>
				<footer className="relative z-10 ui-text text-sm text-white/60 mt-4">
					New operator? <Link className="text-magiBlue hover:underline" href="/register">Register</Link>
				</footer>
			</div>
		</main>
	);
}


