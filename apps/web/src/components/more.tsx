import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { I } from "./icons";

/**
 * Secondary actions. On wide screens the children sit inline with the other buttons; on phones they fold into a
 * "More" sheet so the main actions fit on one line. Escape, an outside tap and navigation close it; focus goes back
 * to the toggle. New headers use PageHeader's `menu` or OverflowMenu instead.
 */
export function MoreActions({ children, label = "More" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.("dialog, .popover, .tooltip") && setOpen(false);
    const onNav = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onNav);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onNav);
    };
  }, [open]);
  return (
    <span ref={ref} className={`more-actions ${open ? "open" : ""}`}>
      <button ref={toggle} type="button" className="btn more-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <I name="more" size={16} /> {label}
      </button>
      <span className="more-items" id={id} role="group" aria-label={label}>
        {children}
      </span>
    </span>
  );
}
