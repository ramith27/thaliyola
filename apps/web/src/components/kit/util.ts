/**
 * Kit internals (not exported from the barrel): class joining, floating placement, overflow detection and the
 * portal target that keeps popovers inside an open modal <dialog> (the top layer).
 */
import { createContext, useContext, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Joins class names, skipping falsy ones. */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** The element floating UI renders into: the nearest open <dialog> (so it stays in the top layer), else body. */
export const PortalTargetContext = createContext<HTMLElement | null>(null);

export function usePortalTarget(): HTMLElement | null {
  const fromContext = useContext(PortalTargetContext);
  if (fromContext) return fromContext;
  return typeof document === "undefined" ? null : document.body;
}

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "top" | "bottom";

const GAP = 6;
const EDGE = 8;

/**
 * Where to put a fixed-position floating element next to its anchor. Flips to the other side when there's no
 * room, and keeps it inside the viewport horizontally.
 */
export function placeFloating(anchor: DOMRect, floating: { width: number; height: number }, placement: Placement): { top: number; left: number; side: "top" | "bottom" } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let side: "top" | "bottom" = placement.startsWith("top") ? "top" : "bottom";
  const below = vh - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  if (side === "bottom" && floating.height > below && above > below) side = "top";
  else if (side === "top" && floating.height > above && below > above) side = "bottom";
  const top = side === "bottom" ? anchor.bottom + GAP : anchor.top - GAP - floating.height;
  let left: number;
  if (placement.endsWith("end")) left = anchor.right - floating.width;
  else if (placement === "top" || placement === "bottom") left = anchor.left + anchor.width / 2 - floating.width / 2;
  else left = anchor.left;
  left = Math.max(EDGE, Math.min(left, vw - floating.width - EDGE));
  const maxTop = Math.max(EDGE, vh - floating.height - EDGE);
  return { top: Math.min(Math.max(EDGE, top), maxTop), left, side };
}

/** Re-runs `update` on scroll (any scroller) and resize while `active`. */
export function useReposition(active: boolean, update: () => void) {
  useLayoutEffect(() => {
    if (!active) return;
    update();
    const on = () => update();
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [active, update]);
}

/** Whether an element scrolls sideways (for edge fades and keyboard-scrollable regions). */
export function useOverflowX(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setOver(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return over;
}

/** Focusable descendants, in order (for initial focus and roving). */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}

/** Whether the person is on a Mac (for ⌘ vs Ctrl). */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** Body scroll lock with a counter, so nested dialogs don't unlock early. */
let locks = 0;
export function lockScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (locks++ === 0) document.documentElement.style.overflow = "hidden";
  return () => {
    if (--locks === 0) document.documentElement.style.overflow = "";
  };
}

/** Stable-ish colour slot 1..8 from a string (avatars). */
export function hashSlot(s: string, slots = 8): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % slots) + 1;
}
