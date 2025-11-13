"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "classnames";
import AuditControl from "@/components/AuditControl";
import MagiTriad from "@/components/MagiTriad";
import MagiConsensusControl from "@/components/MagiConsensusControl";
import RequireAuth from "@/components/RequireAuth";

const BOOT_LINES = [
        { label: "CASPER LINK", ready: "synchronized" },
        { label: "BALTHASAR LINK", ready: "stabilized" },
        { label: "MELCHIOR LINK", ready: "aligned" },
        { label: "CORE MATRIX", ready: "entangled" },
];

export default function Page() {
        const [consoleBooting, setConsoleBooting] = useState(false);
        const [consoleReady, setConsoleReady] = useState(false);
        const [bootPhase, setBootPhase] = useState(0);
        const consoleAnchorRef = useRef<HTMLDivElement | null>(null);

        const handleEnter = useCallback(() => {
                if (consoleReady) {
                        consoleAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                        return;
                }
                if (consoleBooting) return;
                setConsoleBooting(true);
        }, [consoleBooting, consoleReady]);

        useEffect(() => {
                if (!consoleBooting) return;
                setBootPhase(0);
                const timers: ReturnType<typeof setTimeout>[] = [];
                const stepDelays = [220, 620, 1020, 1420];
                stepDelays.forEach((delay, index) => {
                        timers.push(
                                setTimeout(() => {
                                        setBootPhase(index + 1);
                                }, delay)
                        );
                });
                timers.push(
                        setTimeout(() => {
                                setBootPhase(5);
                                setConsoleReady(true);
                        }, 1980)
                );
                timers.push(
                        setTimeout(() => {
                                setConsoleBooting(false);
                        }, 2480)
                );
                return () => {
                        timers.forEach((t) => clearTimeout(t));
                };
        }, [consoleBooting]);

        useEffect(() => {
                if (!consoleReady || !consoleAnchorRef.current) return;
                const id = requestAnimationFrame(() => {
                        consoleAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                });
                return () => cancelAnimationFrame(id);
        }, [consoleReady]);

        const consoleStatus = useMemo(() => {
                if (consoleReady) return { label: "ONLINE", tone: "text-magiGreen" };
                if (consoleBooting) return { label: "INITIALIZING", tone: "text-magiOrange" };
                return { label: "STANDBY", tone: "text-white/60" };
        }, [consoleBooting, consoleReady]);

        const bootProgress = Math.min(bootPhase, 4) / 4;
        const showOverlay = consoleBooting || (!consoleReady && bootPhase > 0);

        return (
                <RequireAuth>
                        <main className="px-8 pt-28 md:pt-32 pb-12 max-w-[1400px] mx-auto">
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

                                <MagiTriad
                                        onEnter={handleEnter}
                                        entering={consoleBooting}
                                        enterLabel={consoleReady ? "Access Console" : undefined}
                                />

                                <section className="mt-8">
                                        <div className="magi-panel border-white/15 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                                                <div>
                                                        <h2 className="title-text text-lg font-bold text-white/90">MAGI Operations Console</h2>
                                                        <p className="ui-text text-sm text-white/70 mt-1">
                                                                When all three MAGI cores are authenticated, engage the <span className="text-magiGreen">Enter MAGI</span> control to initiate the boot sequence.
                                                                The consensus chamber will materialize below once initialization completes.
                                                        </p>
                                                </div>
                                                <div className="ui-text text-xs md:text-sm uppercase tracking-[0.4em] text-right">
                                                        <span className="text-white/40">STATUS&nbsp;</span>
                                                        <span className={clsx("font-semibold", consoleStatus.tone)}>{consoleStatus.label}</span>
                                                </div>
                                        </div>
                                </section>

                                <div ref={consoleAnchorRef} className="mt-12 space-y-6">
                                        <section
                                                className={clsx(
                                                        "magi-panel border-white/15 p-6 md:p-8 transition-all duration-700",
                                                        consoleReady ? "opacity-100 translate-y-0" : "opacity-95 translate-y-0"
                                                )}
                                        >
                                                <h3 className="title-text text-2xl md:text-3xl font-bold text-white/90 uppercase tracking-[0.35em]">
                                                        MAGI Consensus Chamber
                                                </h3>
                                                <p className="ui-text text-sm md:text-base text-white/70 mt-4 max-w-3xl">
                                                        Authenticate each MAGI core, pose your objective, and observe proposals, critiques, voting, and synthesized consensus all within this single operational viewport.
                                                </p>
                                                {!consoleReady && (
                                                        <p className="ui-text text-xs md:text-sm text-white/50 mt-6">
                                                                Awaiting console initialization&mdash;the chamber will appear as soon as access is granted.
                                                        </p>
                                                )}
                                        </section>

                                        <section
                                                className={clsx(
                                                        "transition-all duration-700",
                                                        consoleReady ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"
                                                )}
                                        >
                                                {consoleReady && <MagiConsensusControl />}
                                        </section>
                                </div>

                                <div className="divider my-12" />

                                <AuditControl />
                        </main>

                        {showOverlay && (
                                <div
                                        className="boot-overlay fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center"
                                        role="status"
                                        aria-live="assertive"
                                >
                                        <div className="title-text text-white/60 tracking-[0.45em] text-xs md:text-sm">MAGI ACCESS CHANNEL</div>
                                        <div
                                                className={clsx(
                                                        "title-text text-3xl md:text-5xl font-extrabold mt-4 boot-overlay-title",
                                                        bootPhase >= 5 ? "text-magiGreen" : "text-white/90"
                                                )}
                                        >
                                                {bootPhase >= 5 ? "ACCESS GRANTED" : "LINKING CORES"}
                                        </div>
                                        <div className="boot-overlay-lines mt-6 w-[min(420px,85vw)] space-y-2 text-left">
                                                {BOOT_LINES.map((line, index) => {
                                                        const active = bootPhase >= index + 1;
                                                        return (
                                                                <div
                                                                        key={line.label}
                                                                        className={clsx("boot-overlay-line", active && "active")}
                                                                >
                                                                        <span>{line.label}</span>
                                                                        <span>{active ? line.ready : "……"}</span>
                                                                </div>
                                                        );
                                                })}
                                        </div>
                                        <div className="boot-overlay-progress mt-8">
                                                <div
                                                        className="boot-overlay-progress-bar"
                                                        style={{ width: `${Math.max(bootProgress, 0.05) * 100}%` }}
                                                />
                                        </div>
                                        <p className="ui-text text-xs md:text-sm text-white/60 mt-6 max-w-[420px]">
                                                Synchronizing MAGI sub-shells and elevating the operations viewport. Hold position as the Evangelion-inspired boot sequence completes.
                                        </p>
                                </div>
                        )}
                </RequireAuth>
        );
}


