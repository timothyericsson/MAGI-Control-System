"use client";

export default function AuditControl() {
	return (
		<section className="ui-text text-white/80">
			<h2 className="title-text text-xl font-semibold mb-3">Audit Control</h2>
			<div className="flex flex-col md:flex-row items-start md:items-center gap-4">
				<button
					className="ui-text px-5 py-2 rounded-md bg-white/10 hover:bg-white/15 transition border border-white/15"
					onClick={() =>
						alert("Audit orchestration will be implemented after login and backend setup.")
					}
				>
					Start Code Audit (placeholder)
				</button>
				<p className="text-white/60 text-sm">
					This triggers coordinated analysis across all configured providers.
				</p>
			</div>
		</section>
	);
}


