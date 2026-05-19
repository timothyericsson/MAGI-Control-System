"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { getClientAuthContext } from "@/lib/clientAuth";
import { startStripeCheckout } from "@/lib/clientBilling";
import type { MagiProfile } from "@/lib/magiTypes";

export default function TopBar() {
	const [isAuthed, setIsAuthed] = useState(false);
	const [loading, setLoading] = useState(true);
	const [profile, setProfile] = useState<MagiProfile | null>(null);
	const [billingLoading, setBillingLoading] = useState(false);
	const [billingError, setBillingError] = useState<string | null>(null);

	useEffect(() => {
		let mounted = true;
		async function init() {
			if (!supabaseBrowser) return;
			const { data } = await supabaseBrowser.auth.getSession();
			if (!mounted) return;
			setIsAuthed(Boolean(data.session));
			setLoading(false);
		}
		init();
		if (!supabaseBrowser) return;
		const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
			setIsAuthed(Boolean(session));
			if (!session) {
				setProfile(null);
			}
		});
		return () => {
			mounted = false;
			sub.subscription.unsubscribe();
		};
	}, []);

	useEffect(() => {
		let mounted = true;
		async function loadProfile() {
			if (!isAuthed) {
				setProfile(null);
				return;
			}
			try {
				const auth = await getClientAuthContext();
				const res = await fetch("/api/profile", {
					cache: "no-store",
					headers: auth.headers,
				});
				const json = await res.json();
				if (mounted && res.ok && json?.ok) {
					setProfile(json.profile as MagiProfile);
				}
			} catch {
				if (mounted) setProfile(null);
			}
		}
		loadProfile();
		return () => {
			mounted = false;
		};
	}, [isAuthed]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const handler = (event: Event) => {
			const profileUpdate = (event as CustomEvent<{ profile?: MagiProfile }>).detail?.profile;
			if (profileUpdate) {
				setProfile(profileUpdate);
				setBillingError(null);
			}
		};
		window.addEventListener("magi-profile-updated", handler as EventListener);
		return () => {
			window.removeEventListener("magi-profile-updated", handler as EventListener);
		};
	}, []);

	async function handleLogout() {
		if (!supabaseBrowser) return;
		await supabaseBrowser.auth.signOut();
		setProfile(null);
		window.location.href = "/";
	}

	async function handleSetupBilling() {
		setBillingLoading(true);
		setBillingError(null);
		try {
			await startStripeCheckout();
		} catch (err: any) {
			setBillingError(err?.message || "Unable to start checkout.");
			setBillingLoading(false);
		}
	}

	function toggleHistoryDrawer() {
		if (typeof window === "undefined") return;
		window.dispatchEvent(new CustomEvent("magi-toggle-history"));
	}

	const showBillingButton = profile?.usage_mode === "paid" && profile.payment_status !== "paid";

        return (
                <div className="fixed left-4 bottom-4 z-50">
                        {!loading && isAuthed && (
                                <div className="flex items-center gap-2">
                                        {showBillingButton && (
                                                <button
                                                        onClick={handleSetupBilling}
                                                        disabled={billingLoading}
                                                        className="ui-text px-3 py-1 text-sm rounded-md border border-magiOrange/70 bg-magiOrange/20 text-white shadow-magi-glow-orange hover:bg-magiOrange/30 transition disabled:opacity-60"
                                                        title="Set up hosted MAGI access"
                                                >
                                                        {billingLoading ? "Opening..." : "Setup your account for $5"}
                                                </button>
                                        )}
                                        <button
                                                onClick={toggleHistoryDrawer}
                                                className="ui-text px-3 py-1 text-sm rounded-md border border-white/20 bg-white/10 hover:bg-white/15 transition"
                                                title="View chat history"
                                        >
                                                History
                                        </button>
                                        <button
                                                onClick={handleLogout}
                                                className="ui-text px-3 py-1 text-sm rounded-md border border-white/20 bg-white/10 hover:bg-white/15 transition"
                                                title="Sign out"
                                        >
                                                Log out
                                        </button>
                                        {billingError && <span className="ui-text text-xs text-red-400">{billingError}</span>}
                                </div>
                        )}
		</div>
	);
}
