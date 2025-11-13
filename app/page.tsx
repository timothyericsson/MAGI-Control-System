import Link from "next/link";
import AuditControl from "@/components/AuditControl";
import MagiTriad from "@/components/MagiTriad";
import RequireAuth from "@/components/RequireAuth";

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

                                <section className="mt-8">
                                        <div className="magi-panel border-white/15 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                                                <div>
                                                        <h2 className="title-text text-lg font-bold text-white/90">MAGI Operations Console</h2>
                                                        <p className="ui-text text-sm text-white/70 mt-1">
                                                                When all three MAGI cores are authenticated, the central triangle portal will unlock.
                                                                Use the <span className="text-magiGreen">Enter MAGI</span> control to launch the live consensus chamber in a dedicated window.
                                                        </p>
                                                </div>
                                                <Link
                                                        href="/console"
                                                        target="_blank"
                                                        rel="noreferrer noopener"
                                                        className="ui-text text-sm px-4 py-2 rounded-md border border-white/20 bg-white/10 hover:bg-white/15 text-center"
                                                >
                                                        Open Console
                                                </Link>
                                        </div>
                                </section>

                                <div className="divider my-10" />

                                <AuditControl />
			</main>
		</RequireAuth>
	);
}


