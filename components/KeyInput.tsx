"use client";

import { useEffect, useState } from "react";
import clsx from "classnames";
import { safeLoad, safeSave, safeRemove } from "@/lib/localStore";

export default function KeyInput({
	storageKey,
	provider,
	verifiedKey,
	label,
	accent,
}: {
	storageKey: string;
	provider: "openai" | "anthropic" | "grok";
	verifiedKey: string;
	label: string;
	accent: "magiBlue" | "magiOrange" | "magiGreen";
}) {
	const [value, setValue] = useState("");
	const [status, setStatus] = useState<"idle" | "saving" | "transmitting" | "waiting" | "success" | "error">("idle");
	const [errorText, setErrorText] = useState<string | null>(null);
	const [linked, setLinked] = useState<boolean>(false);

	useEffect(() => {
		const existing = safeLoad(storageKey) ?? "";
		setValue(existing);
	}, [storageKey]);

	useEffect(() => {
		setLinked(Boolean(safeLoad(verifiedKey)));
	}, [verifiedKey]);

	async function handleSave() {
		const trimmed = value.trim();
		if (!trimmed) {
			setStatus("idle");
			setErrorText("No key provided");
			return;
		}
		// Step 1: persist locally
		setStatus("saving");
		setErrorText(null);
		safeSave(storageKey, trimmed);

		// Step 2: transmit "hello" (ping through server)
		setStatus("transmitting");
		try {
			const res = await fetch("/api/ping", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider, apiKey: trimmed }),
			});
			setStatus("waiting");
			const data = await res.json().catch(() => ({}));
			if (!res.ok || !data?.ok) {
				throw new Error(data?.error || "Verification failed");
			}
			// Step 3: mark verified
			safeSave(verifiedKey, "true");
			setStatus("success");
			setLinked(true);
		} catch (e: any) {
			safeRemove(verifiedKey);
			setStatus("error");
			setErrorText(e?.message || "Verification error");
			setLinked(false);
		}
	}

	function handleClear() {
		safeRemove(storageKey);
		safeRemove(verifiedKey);
		setValue("");
		setStatus("idle");
		setErrorText(null);
		setLinked(false);
	}

	return (
		<div className="ui-text">
			<label className="block text-sm mb-2 text-white/80">{label}</label>
			<div
				className={clsx(
					"relative rounded-md border bg-white/5",
					"focus-within:ring-2",
					{ "focus-within:ring-magiBlue/50 keyinput-focus": accent === "magiBlue" },
					{ "focus-within:ring-magiOrange/50 keyinput-focus": accent === "magiOrange" },
					{ "focus-within:ring-magiGreen/50 keyinput-focus": accent === "magiGreen" },
					{
						"border-magiBlue/40": accent === "magiBlue",
						"border-magiOrange/40": accent === "magiOrange",
						"border-magiGreen/40": accent === "magiGreen",
					}
				)}
			>
				<input
					type="password"
					placeholder="••••••••••••••••••••"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="w-full bg-transparent outline-none px-3 py-2 placeholder-white/30 text-white/90"
				/>
				{/* scanning overlay while typing */}
				{value && <div className="absolute inset-0 keyinput-scan" />}
			</div>
			<div className="flex items-center gap-3 mt-3">
				<button
					onClick={handleSave}
					className={clsx(
						"px-4 py-1.5 rounded-md border text-sm transition",
						"bg-white/10 hover:bg-white/15",
						{
							"border-magiBlue/50": accent === "magiBlue",
							"border-magiOrange/50": accent === "magiOrange",
							"border-magiGreen/50": accent === "magiGreen",
						}
					)}
				>
					{status === "saving" || status === "transmitting" || status === "waiting" ? "Verifying…" : "Save"}
				</button>
				<button
					onClick={handleClear}
					className="px-4 py-1.5 rounded-md border border-white/20 text-sm bg-white/5 hover:bg-white/10 transition"
				>
					Clear
				</button>
				{status === "success" && <span className="text-xs text-magiGreen">Link established</span>}
				{status === "error" && <span className="text-xs text-red-400">{errorText || "Verification failed"}</span>}
				{status === "idle" && (
					<span className={`text-xs ${linked ? "text-magiGreen" : "text-white/40"}`}>
						{linked ? "Linked" : "Awaiting key"}
					</span>
				)}
				{(status === "saving" || status === "transmitting" || status === "waiting") && (
					<span className="text-xs text-white/60">Establishing link…</span>
				)}
			</div>
			{/* Step list */}
			<div className="mt-3 text-xs text-white/60 space-y-1">
				<div className={clsx("flex items-center gap-2", { "step-active": status === "saving" })}>
					<span>1.</span><span>Initialize</span>
				</div>
				<div className={clsx("flex items-center gap-2", { "step-active": status === "transmitting" })}>
					<span>2.</span><span>Transmit handshake</span>
				</div>
				<div className={clsx("flex items-center gap-2", { "step-active": status === "waiting" })}>
					<span>3.</span><span>Await response</span>
				</div>
				<div className={clsx("flex items-center gap-2", { "step-active": status === "success" })}>
					<span>4.</span><span>Link confirmed</span>
				</div>
			</div>
			<div className="progress-bar mt-2" />
		</div>
	);
}


