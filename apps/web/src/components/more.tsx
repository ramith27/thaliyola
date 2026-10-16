import { useEffect, useRef, useState, type ReactNode } from "react";
import { I } from "./icons";

/**
 * Secondary actions. On wide screens the children sit inline with the other
 * buttons; on phones they fold into a "More" menu so the main actions fit on
 * one line.
 */
export function MoreActions({ children, label = "More" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("hashchange", () => setOpen(false), { once: true });
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <span ref={ref} className={`more-actions ${open ? "open" : ""}`}>
      <button type="button" className="btn more-toggle" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <I name="menu" size={16} /> {label}
      </button>
      <span className="more-items" role="menu">
        {children}
      </span>
    </span>
  );
}
