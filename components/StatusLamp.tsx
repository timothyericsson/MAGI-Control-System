"use client";

import { useEffect, useState } from "react";
import clsx from "classnames";
import { safeLoad } from "@/lib/localStore";

export default function StatusLamp({
	storageKey,
	accent,
}: {
	storageKey: string;
	accent: "magiBlue" | "magiOrange" | "magiGreen";
}) {
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		const value = safeLoad(storageKey);
		setEnabled(Boolean(value));
		const i = setInterval(() => {
			setEnabled(Boolean(safeLoad(storageKey)));
		}, 1000);
		return () => clearInterval(i);
	}, [storageKey]);

	return (
		<div
			className={clsx(
				"h-3.5 w-3.5 rounded-full border",
				enabled ? "opacity-100" : "opacity-40",
				{
					"bg-magiBlue/90 border-magiBlue/70 shadow-magi-glow-blue": accent === "magiBlue",
					"bg-magiOrange/90 border-magiOrange/70 shadow-magi-glow-orange": accent === "magiOrange",
					"bg-magiGreen/90 border-magiGreen/70 shadow-magi-glow-green": accent === "magiGreen",
				}
			)}
			title={enabled ? "Configured" : "Not configured"}
		/>
	);
}


