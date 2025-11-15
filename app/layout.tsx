import type { Metadata } from "next";
import "./globals.css";
import { Orbitron, Rajdhani } from "next/font/google";
import TopBar from "@/components/TopBar";

const orbitron = Orbitron({
	subsets: ["latin"],
	variable: "--font-orbitron",
	weight: ["500", "700"],
	display: "swap",
});

const rajdhani = Rajdhani({
	subsets: ["latin"],
	variable: "--font-rajdhani",
	weight: ["500", "700"],
	display: "swap",
});

export const metadata: Metadata = {
	title: "MAGI Operator Console",
	description: "Evangelion-inspired tri-core operator console for AI code auditing",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
                        <body
                                className={`${orbitron.variable} ${rajdhani.variable} bg-evaBg text-white min-h-screen overflow-y-auto`}
                        >
				<div className="relative min-h-screen">
					{/* Subtle EVA grid background */}
					<div
						aria-hidden
						className="pointer-events-none absolute inset-0"
						style={{
							backgroundImage:
								"linear-gradient(to right, rgba(20,32,58,0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(20,32,58,0.35) 1px, transparent 1px)",
							backgroundSize: "40px 40px",
						}}
					/>
					{/* Optional background art overlay if provided by user in /public */}
					<div
						aria-hidden
						className="pointer-events-none absolute inset-0 opacity-[0.05] bg-center bg-cover"
						style={{ backgroundImage: "url(/magi_background.png)" }}
					/>
					<TopBar />
					<div className="relative">{children}</div>
				</div>
			</body>
		</html>
	);
}


