"use client";

import KeyInput from "./KeyInput";
import StatusLamp from "./StatusLamp";
import clsx from "classnames";
import { useMemo } from "react";

type Provider = "openai" | "anthropic" | "grok";
type Glow = "blue" | "orange" | "green";

export default function MagiPanel({
	agentName,
	provider,
	glow,
	accent,
}: {
	agentName: string;
	provider: Provider;
	glow: Glow;
	accent: "magiBlue" | "magiOrange" | "magiGreen";
}) {
	const storageKey = useMemo(() => `magi_provider_${provider}_api_key`, [provider]);
	const verifiedKey = useMemo(() => `magi_provider_${provider}_verified`, [provider]);
	const shadowClass = useMemo(() => {
		switch (glow) {
			case "blue":
				return "shadow-magi-glow-blue";
			case "orange":
				return "shadow-magi-glow-orange";
			case "green":
				return "shadow-magi-glow-green";
		}
	}, [glow]);

	return (
		<section className={clsx("magi-panel p-5 border-white/15 relative overflow-hidden", shadowClass)}>
			{/* corner brackets */}
			<div className="pointer-events-none absolute inset-0">
				<div className="absolute left-2 top-2 h-4 w-4 border-l border-t border-white/25" />
				<div className="absolute right-2 top-2 h-4 w-4 border-r border-t border-white/25" />
				<div className="absolute left-2 bottom-2 h-4 w-4 border-l border-b border-white/25" />
				<div className="absolute right-2 bottom-2 h-4 w-4 border-r border-b border-white/25" />
			</div>
			<header className="flex items-center justify-between mb-4">
				<div>
					<h3 className={clsx("title-text text-xl font-bold", `text-${accent}`)}>{agentName}</h3>
					<p className="ui-text text-white/70 text-xs uppercase tracking-widest mt-1">{provider}</p>
				</div>
				<StatusLamp storageKey={verifiedKey} accent={accent} />
			</header>

			<div className="divider mb-4" />

			<KeyInput storageKey={storageKey} provider={provider} verifiedKey={verifiedKey} label="API Key" accent={accent} />
		</section>
	);
}


