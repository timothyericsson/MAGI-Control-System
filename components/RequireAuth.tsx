"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
	const [checking, setChecking] = useState(true);
	const [allowed, setAllowed] = useState(false);
	const [mode, setMode] = useState<"login" | "register">("login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const lockedProps = useMemo(
		() => (!allowed ? { inert: true, "aria-hidden": true } : {}),
		[allowed]
	);

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
			}
		}
		check();
		if (!supabaseBrowser) return;
		const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
			setAllowed(Boolean(session));
			setChecking(false);
		});
		return () => {
			mounted = false;
			sub.subscription.unsubscribe();
		};
	}, []);

	function resetFeedback(nextMode?: "login" | "register") {
		setError(null);
		setMessage(null);
		if (nextMode) {
			setMode(nextMode);
			setPassword("");
			setConfirm("");
		}
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!supabaseBrowser) {
			setError("Auth is not configured.");
			return;
		}
		if (mode === "register" && password !== confirm) {
			setError("Passwords do not match.");
			return;
		}

		setSubmitting(true);
		setError(null);
		setMessage(null);
		try {
			if (mode === "login") {
				const { data, error: authError } = await supabaseBrowser.auth.signInWithPassword({ email, password });
				if (authError) throw authError;
				if (data.session) {
					setAllowed(true);
					setMessage("Access granted.");
				} else {
					setMessage("Check your email to continue.");
				}
			} else {
				const { data, error: authError } = await supabaseBrowser.auth.signUp({
					email,
					password,
					options: {
						emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
					},
				});
				if (authError) throw authError;
				if (data.session) {
					setAllowed(true);
					setMessage("Access granted.");
				} else {
					setMessage("Check your email to confirm your account.");
				}
			}
		} catch (err: any) {
			setError(err?.message || "Authentication failed.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<>
			<div
				{...lockedProps}
				className={
					allowed
						? "transition duration-300"
						: "pointer-events-none select-none opacity-55 blur-[1.5px] transition duration-300"
				}
			>
				{children}
			</div>

			{!allowed && (
				<div className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-8">
					<div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />
					<div className="relative w-full max-w-md magi-panel border-white/20 p-5 md:p-6 auth-panel-enter shadow-magi-glow-blue">
						<header className="mb-5">
							<div className="flex items-center justify-between gap-2">
								<h1 className="title-text auth-title text-xl md:text-2xl font-bold">
									{mode === "login" ? "RESEARCH ACCESS" : "RESEARCHER ENROLLMENT"}
								</h1>
							</div>
							<div className="auth-divider mt-3" />
						</header>

						<div className="grid grid-cols-2 gap-2 mb-5 ui-text">
							<button
								type="button"
								onClick={() => resetFeedback("login")}
								className={`rounded-md border px-3 py-2 text-sm transition ${
									mode === "login"
										? "border-magiBlue/70 bg-magiBlue/15 text-white"
										: "border-white/15 bg-white/5 text-white/65 hover:bg-white/10"
								}`}
							>
								Login
							</button>
							<button
								type="button"
								onClick={() => resetFeedback("register")}
								className={`rounded-md border px-3 py-2 text-sm transition ${
									mode === "register"
										? "border-magiOrange/70 bg-magiOrange/15 text-white"
										: "border-white/15 bg-white/5 text-white/65 hover:bg-white/10"
								}`}
							>
								Register
							</button>
						</div>

						<form onSubmit={onSubmit} className="space-y-4 ui-text">
							<div>
								<label className="text-sm text-white/75 block mb-1">Email</label>
								<input
									type="email"
									required
									autoComplete="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/50"
								/>
							</div>
							<div>
								<label className="text-sm text-white/75 block mb-1">Password</label>
								<input
									type="password"
									required
									autoComplete={mode === "login" ? "current-password" : "new-password"}
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiBlue/50"
								/>
							</div>
							{mode === "register" && (
								<div>
									<label className="text-sm text-white/75 block mb-1">Confirm Password</label>
									<input
										type="password"
										required
										autoComplete="new-password"
										value={confirm}
										onChange={(event) => setConfirm(event.target.value)}
										className="w-full rounded-md bg-white/5 border border-white/20 px-3 py-2 outline-none focus:ring-2 focus:ring-magiOrange/50"
									/>
								</div>
							)}
							<button
								type="submit"
								disabled={submitting || checking}
								className="w-full rounded-md border border-white/15 bg-white/10 px-4 py-2 text-sm transition hover:bg-white/15 disabled:opacity-60"
							>
								{submitting
									? mode === "login"
										? "Authenticating..."
										: "Registering..."
									: mode === "login"
										? "Enter MAGI"
										: "Create Research Account"}
							</button>
							{checking && <p className="text-sm text-white/60">Verifying access...</p>}
							{error && <p className="text-sm text-red-400">{error}</p>}
							{message && <p className="text-sm text-magiGreen">{message}</p>}
						</form>
					</div>
				</div>
			)}
		</>
	);
}
