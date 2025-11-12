"use client";

import MagiPanel from "@/components/MagiPanel";
import { useEffect, useMemo, useState } from "react";
import { safeLoad } from "@/lib/localStore";
import clsx from "classnames";

type Accent = "magiBlue" | "magiOrange" | "magiGreen";

export default function MagiTriad() {
	const nodes = useMemo(
		() => [
			{
				id: "casper",
				title: "CASPER",
				provider: "openai" as const,
				accent: "magiBlue" as Accent,
				glow: "blue" as const,
				verifiedKey: "magi_provider_openai_verified",
				pos: { xPct: 50, yPct: 12 },
			},
			{
				id: "balthasar",
				title: "BALTHASAR",
				provider: "anthropic" as const,
				accent: "magiOrange" as Accent,
				glow: "orange" as const,
				verifiedKey: "magi_provider_anthropic_verified",
				pos: { xPct: 20, yPct: 75 },
			},
			{
				id: "melchior",
				title: "MELCHIOR",
				provider: "grok" as const,
				accent: "magiGreen" as Accent,
				glow: "green" as const,
				verifiedKey: "magi_provider_grok_verified",
				pos: { xPct: 80, yPct: 75 },
			},
		],
		[]
	);

	const [active, setActive] = useState<Record<string, boolean>>({});
	const [bootStage, setBootStage] = useState(0); // 0=hidden,1=label,2=title,3=steady

	useEffect(() => {
		function refresh() {
			const map: Record<string, boolean> = {};
			for (const n of nodes) {
				map[n.id] = Boolean(safeLoad(n.verifiedKey));
			}
			setActive(map);
		}
		refresh();
		const i = setInterval(refresh, 800);
		return () => clearInterval(i);
	}, [nodes]);

	const allOn = Object.values(active).filter(Boolean).length === 3;

	useEffect(() => {
		if (allOn) {
			setBootStage(1);
			const t1 = setTimeout(() => setBootStage(2), 600);
			const t2 = setTimeout(() => setBootStage(3), 1400);
			return () => {
				clearTimeout(t1);
				clearTimeout(t2);
			};
		} else {
			setBootStage(0);
		}
	}, [allOn]);

	return (
		<section className="relative w-full h-[600px] md:h-[680px] magi-triad">
			{/* Optional background image if present in /public */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 opacity-[0.08] bg-center bg-cover"
				style={{ backgroundImage: "url(/magi_background.png)" }}
			/>

			{/* Connectors (base lines under panels) */}
			<svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
				{[
					["casper", "balthasar"],
					["casper", "melchior"],
					["balthasar", "melchior"],
				].map(([a, b]) => {
					const A = nodes.find((n) => n.id === a)!;
					const B = nodes.find((n) => n.id === b)!;
					const bothActive = Boolean(active[a]) && Boolean(active[b]);
					return (
						<line
							key={`${a}-${b}`}
							x1={A.pos.xPct}
							y1={A.pos.yPct}
							x2={B.pos.xPct}
							y2={B.pos.yPct}
							className={clsx(
								"stroke-[0.6] drop-shadow",
								bothActive ? "stroke-white/70" : "stroke-white/20"
							)}
							style={{
								filter: bothActive
									? "drop-shadow(0 0 6px rgba(255,255,255,0.7))"
									: "none",
							}}
						/>
					);
				})}
			</svg>

			{/* Nodes */}
			{nodes.map((n) => (
				<div
					key={n.id}
					className="absolute -translate-x-1/2 -translate-y-1/2"
					style={{ left: `${n.pos.xPct}%`, top: `${n.pos.yPct}%`, width: "min(420px, 90vw)" }}
				>
					<MagiPanel
						agentName={n.title}
						provider={n.provider}
						glow={n.glow}
						accent={n.accent}
					/>
				</div>
			))}

			{/* Animated dash overlay above panels to avoid clipping */}
			{Object.values(active).filter(Boolean).length === 3 && (
				<svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                                        <defs>
                                                <linearGradient
                                                        id="triadGlow"
                                                        x1="0"
                                                        y1="0"
                                                        x2="100"
                                                        y2="100"
                                                        gradientUnits="userSpaceOnUse"
                                                >
							<stop offset="0%" stopColor="#00D1FF" />
							<stop offset="50%" stopColor="#FFA726" />
							<stop offset="100%" stopColor="#00FF7F" />
						</linearGradient>
					</defs>
					{[
						["casper", "balthasar"],
						["casper", "melchior"],
						["balthasar", "melchior"],
					].map(([a, b]) => {
						const A = nodes.find((n) => n.id === a)!;
						const B = nodes.find((n) => n.id === b)!;
						return (
							<line
								key={`dash-${a}-${b}`}
								x1={A.pos.xPct}
								y1={A.pos.yPct}
								x2={B.pos.xPct}
								y2={B.pos.yPct}
								stroke="url(#triadGlow)"
								className="stroke-[0.9] triad-dash"
								strokeLinecap="round"
							/>
						);
					})}
				</svg>
			)}

			{/* Boot-up center overlay */}
			{bootStage > 0 && (
				<div
					className="absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 text-center select-none"
					aria-live="polite"
					aria-atomic="true"
				>
					{bootStage >= 1 && (
						<div className="title-text text-white/70 tracking-[0.35em] text-xs md:text-sm mb-2 boot-flicker">
							MAGI SYSTEM
						</div>
					)}
					{bootStage >= 2 && (
						<div className="title-text boot-glow boot-flicker text-3xl md:text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-magiBlue via-magiOrange to-magiGreen">
							OPERATIONAL
						</div>
					)}
					{bootStage >= 3 && (
						<div className="mt-3 w-[280px] md:w-[360px] h-[2px] mx-auto bg-white/15 boot-scan rounded-full" />
					)}
				</div>
			)}
		</section>
	);
}


