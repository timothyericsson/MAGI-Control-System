import MagiTriad from "@/components/MagiTriad";
import RequireAuth from "@/components/RequireAuth";
import MagiConsensusControl from "@/components/MagiConsensusControl";

export default function Page() {
        return (
                <RequireAuth>
                        <main className="px-8 pt-28 md:pt-32 pb-10 max-w-[1400px] mx-auto">
                                <MagiTriad />

                                <MagiConsensusControl />

                                <div className="divider my-10" />
                        </main>
                </RequireAuth>
        );
}


