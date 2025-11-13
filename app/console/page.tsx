import RequireAuth from "@/components/RequireAuth";
import MagiConsensusControl from "@/components/MagiConsensusControl";

export default function ConsolePage() {
        return (
                <RequireAuth>
                        <main className="px-6 md:px-10 pt-24 pb-16 max-w-[1200px] mx-auto">
                                <section className="magi-panel border-white/15 p-6 md:p-8 mb-8">
                                        <h1 className="title-text text-2xl md:text-3xl font-bold text-white/90 uppercase tracking-[0.35em]">
                                                MAGI Consensus Chamber
                                        </h1>
                                        <p className="ui-text text-sm md:text-base text-white/70 mt-3 max-w-3xl">
                                                Authenticate each MAGI core, pose your objective, and observe the full deliberation pipeline—proposals, critiques,
                                                voting, and the synthesized consensus—within this dedicated operations viewport.
                                        </p>
                                </section>
                                <MagiConsensusControl />
                        </main>
                </RequireAuth>
        );
}
