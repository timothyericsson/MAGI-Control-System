import AuditControl from "@/components/AuditControl";
import MagiTriad from "@/components/MagiTriad";
import RequireAuth from "@/components/RequireAuth";
import MagiConsensusControl from "@/components/MagiConsensusControl";

export default function Page() {
	return (
		<RequireAuth>
			<main className="px-8 pt-28 md:pt-32 pb-10 max-w-[1400px] mx-auto">
				{/* Floating header badge (top-right) */}
				<div className="fixed right-6 top-16 z-40">
					<div className="magi-panel border border-white/15 px-4 py-3">
						<h1 className="title-text text-lg md:text-xl font-bold text-white/90 text-right">
							MAGI Operator Console
						</h1>
						<p className="ui-text text-[11px] md:text-sm text-white/60 text-right mt-1">
							CASPER • BALTHASAR • MELCHIOR — Evangelion-inspired tri-core interface
						</p>
					</div>
				</div>

				<MagiTriad />

				<MagiConsensusControl />

				<div className="divider my-10" />

				<AuditControl />
			</main>
		</RequireAuth>
	);
}


