/**
 * Overlays (SPEC §5.9, §5.10): Tooltip, InfoTip, Popover, Menu/MenuButton/OverflowMenu, Dialog and Sheet on native
 * <dialog>, useConfirm, and KitProvider (toasts + confirmations + portal target).
 *
 * Keyboard: menus use roving focus (arrows, Home/End, typeahead); Escape and Tab close them and return focus to
 * the trigger. Dialogs trap focus (showModal), close on Escape unless busy, and give focus back on close.
 */
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../../hooks";
import { I, type IconName } from "../icons";
import { Button, IconButton, type ButtonVariant } from "./button";
import { ToastProvider } from "./feedback";
import { cx, FOCUSABLE, lockScroll, placeFloating, PortalTargetContext, usePortalTarget, useReposition, type Placement } from "./util";

// ---- Tooltip -----------------------------------------------------------------------------------------

/** True while the kit moves focus itself (a dialog opening, focus going back to a trigger). */
let movingFocus = false;

/**
 * Focus an element without popping its tooltip. Programmatic focus on a keyboard-driven page matches
 * :focus-visible, so a dialog's first control or a menu's trigger would otherwise show its tooltip, and the next
 * Escape would only hide that tooltip instead of doing what the person meant.
 */
function quietFocus(el: HTMLElement | null | undefined) {
  if (el) quietly(() => el.focus({ preventScroll: true }));
}

/** Run something that moves focus as a side effect (closing a native dialog restores focus) without tooltips. */
function quietly(fn: () => void) {
  movingFocus = true;
  try {
    fn();
  } finally {
    movingFocus = false;
  }
}

export interface TooltipProps {
  content: string;
  children: ReactElement;
  placement?: "top" | "bottom";
  /** Adds aria-describedby on the trigger (default). Off when the content repeats the trigger's own label. */
  describe?: boolean;
  /** Shows it now (e.g. the reason a disabled button can't be used, after a click). */
  forceOpen?: boolean;
}

type AnyProps = Record<string, unknown> & { [k: string]: unknown };
const callProp = (props: AnyProps, name: string, e: unknown) => {
  const fn = props[name];
  if (typeof fn === "function") (fn as (e: unknown) => void)(e);
};

/**
 * A short description shown on hover (after 400ms) and immediately on keyboard focus. It stays open while
 * hovered, Escape dismisses it (WCAG 1.4.13). Never put essential information only here; use InfoTip.
 */
export function Tooltip({ content, children, placement = "top", describe = true, forceOpen = false }: TooltipProps) {
  const id = useId();
  const target = usePortalTarget();
  const [hoverOpen, setHoverOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const overTip = useRef(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = (hoverOpen || forceOpen) && !dismissed && !!content;

  const clear = () => timer.current && clearTimeout(timer.current);
  const show = (el: HTMLElement, delay: number) => {
    anchor.current = el;
    clear();
    setDismissed(false);
    if (delay) timer.current = setTimeout(() => setHoverOpen(true), delay);
    else setHoverOpen(true);
  };
  const hide = (delay = 120) => {
    clear();
    timer.current = setTimeout(() => !overTip.current && setHoverOpen(false), delay);
  };
  useEffect(() => clear, []);

  const update = useCallback(() => {
    const a = anchor.current;
    const t = tip.current;
    if (!a || !t) return;
    const p = placeFloating(a.getBoundingClientRect(), { width: t.offsetWidth, height: t.offsetHeight }, placement);
    setPos({ top: p.top, left: p.left });
  }, [placement]);
  useReposition(open, update);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDismissed(true);
      // Escape always dismisses the tooltip (WCAG 1.4.13). Inside an open popover, menu or modal dialog the key
      // also goes on to that surface, so one press closes what the person is working in. Elsewhere it stops here,
      // so a page-wide Escape shortcut (such as clearing a selection) doesn't fire as well.
      const from = e.target as Element | null;
      if (from?.closest?.(".popover, dialog[open]")) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const child = Children.only(children);
  if (!isValidElement(child)) return child;
  const props = child.props as AnyProps;
  const trigger = cloneElement(child as ReactElement<AnyProps>, {
    "aria-describedby": describe && content ? cx(props["aria-describedby"] as string | undefined, id) : props["aria-describedby"],
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      callProp(props, "onMouseEnter", e);
      show(e.currentTarget, 400);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      callProp(props, "onMouseLeave", e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      callProp(props, "onFocus", e);
      if (movingFocus) return;
      let visible = true;
      try {
        visible = e.currentTarget.matches(":focus-visible");
      } catch {
        /* older browsers: show on any focus */
      }
      if (visible) show(e.currentTarget, 0);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      callProp(props, "onBlur", e);
      hide(0);
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      callProp(props, "onPointerDown", e);
      anchor.current = e.currentTarget;
    },
  });

  return (
    <>
      {trigger}
      {target &&
        content &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="tooltip"
            hidden={!open}
            style={pos ? { top: pos.top, left: pos.left } : undefined}
            onMouseEnter={() => {
              overTip.current = true;
              clear();
            }}
            onMouseLeave={() => {
              overTip.current = false;
              hide();
            }}
          >
            {content}
          </div>,
          target,
        )}
    </>
  );
}

// ---- Popover -------------------------------------------------------------------------------------------

export interface PopoverProps {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  onClose(): void;
  label: string;
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  matchWidth?: boolean;
  sheetOnMobile?: boolean;
  children: ReactNode;
  /** Extra class names (e.g. "menu"). */
  className?: string;
  id?: string;
  /** ARIA role of the panel: a non-modal dialog by default, "menu" for menus. */
  role?: "dialog" | "menu" | "listbox";
  /** Focus the first control on open (default) or leave focus on the trigger. */
  autoFocus?: boolean;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * A non-modal floating panel anchored to a trigger. Fixed-positioned, flips when there's no room, follows scroll
 * and resize. Closes on outside pointerdown, Escape (without closing an enclosing dialog) and navigation.
 */
export function Popover(props: PopoverProps) {
  if (!props.open) return null;
  return <PopoverPanel {...props} />;
}

function PopoverPanel({ anchorRef, onClose, label, placement = "bottom-start", matchWidth, sheetOnMobile, children, className, id, role = "dialog", autoFocus = true, onKeyDown }: PopoverProps) {
  const target = usePortalTarget();
  const ref = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery("(max-width: 640px)");
  const asSheet = !!sheetOnMobile && phone;
  const [pos, setPos] = useState<{ top: number; left: number; width?: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const update = useCallback(() => {
    const a = anchorRef.current;
    const p = ref.current;
    if (!a || !p || asSheet) return;
    const r = a.getBoundingClientRect();
    const width = matchWidth ? r.width : undefined;
    const placed = placeFloating(r, { width: width ?? p.offsetWidth, height: p.offsetHeight }, placement);
    setPos({ top: placed.top, left: placed.left, width });
  }, [anchorRef, placement, matchWidth, asSheet]);
  useReposition(true, update);

  // Focus in on open, back to the trigger on close (only when focus was inside).
  useLayoutEffect(() => {
    const panel = ref.current;
    if (autoFocus && panel) quietFocus(panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel);
    const anchor = anchorRef.current;
    return () => {
      if (panel && panel.contains(document.activeElement) && anchor && document.contains(anchor)) quietFocus(anchor);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      // Floating UI rendered by something inside (a tooltip, a nested popover) counts as inside.
      if ((t as Element).closest?.(".tooltip, .popover")) return;
      closeRef.current();
    };
    const nav = () => closeRef.current();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("hashchange", nav);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("hashchange", nav);
    };
  }, [anchorRef]);

  if (!target) return null;
  return createPortal(
    <>
      {asSheet && <div className="popover-scrim" aria-hidden="true" onPointerDown={() => closeRef.current()} />}
      <div
        ref={ref}
        id={id}
        role={role}
        aria-label={label}
        tabIndex={-1}
        className={cx("popover", className)}
        data-sheet={asSheet || undefined}
        /* Unplaced: transparent but still focusable (visibility:hidden would block the initial focus of a menu item). */
        style={asSheet ? undefined : pos ? { top: pos.top, left: pos.left, width: pos.width } : { opacity: 0, pointerEvents: "none", top: 0, left: 0 }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeRef.current();
          }
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!next) return;
          if (ref.current?.contains(next) || anchorRef.current?.contains(next)) return;
          if ((next as Element).closest?.(".popover, dialog")) return;
          closeRef.current();
        }}
      >
        {children}
      </div>
    </>,
    target,
  );
}

// ---- InfoTip ---------------------------------------------------------------------------------------------

export interface InfoTipProps {
  label: string;
  children: ReactNode;
}

/** A "?" button that opens a short explanation. Replaces title="" explanations. */
export function InfoTip({ label, children }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="infotip"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <I name="help" size={16} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} label={label} id={id} className="infotip-panel" autoFocus={false}>
        <p className="infotip-title">{label}</p>
        <div className="infotip-body">{children}</div>
      </Popover>
    </>
  );
}

// ---- Menus -------------------------------------------------------------------------------------------------

export type MenuItemSpec =
  | {
      id: string;
      label: string;
      icon?: IconName;
      hint?: string;
      shortcut?: string;
      href?: string;
      external?: boolean;
      onSelect?: () => void;
      tone?: "danger";
      disabledReason?: string;
      checked?: boolean;
      type?: undefined;
    }
  | { type: "separator" }
  | { type: "group"; label: string }
  /** One choice among a few, shown as a segmented row of menuitemradio items (the user menu's theme). Selecting keeps the menu open. */
  | { type: "choice"; label: string; options: { id: string; label: string; icon?: IconName; checked: boolean }[]; onSelect: (id: string) => void };

type ActionSpec = Extract<MenuItemSpec, { id: string }>;
const isAction = (i: MenuItemSpec): i is ActionSpec => i.type === undefined;

const ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])';

/** The items of a menu with roving focus. Used inside a Popover (desktop) or a bottom Sheet (phones). */
function MenuList({ items, onDone, initial }: { items: MenuItemSpec[]; onDone: (restoreFocus: boolean) => void; initial: "first" | "last" }) {
  const ref = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const enabled = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
  useLayoutEffect(() => {
    const list = enabled();
    const target = initial === "last" ? list[list.length - 1] : list[0];
    // Marked so an enclosing Sheet (phones) gives it focus once the dialog is open.
    target?.setAttribute("data-autofocus", "");
    target?.focus({ preventScroll: true });
    // Belt and braces: if the panel wasn't focusable yet (still being placed, or a sheet opening), retry once painted.
    if (!target || document.activeElement === target) return;
    const raf = requestAnimationFrame(() => {
      if (target.isConnected && !ref.current?.contains(document.activeElement)) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (to: "next" | "prev" | "first" | "last") => {
    const list = enabled();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const i = to === "first" ? 0 : to === "last" ? list.length - 1 : to === "next" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[i]?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") move("next");
    else if (e.key === "ArrowUp") move("prev");
    else if (e.key === "Home") move("first");
    else if (e.key === "End") move("last");
    else if (e.key === "Escape") {
      e.stopPropagation();
      onDone(true);
    } else if (e.key === "Tab") {
      onDone(true);
      return; // let Tab move on from the trigger
    } else if (e.key === " " && (e.target as HTMLElement).tagName === "A") (e.target as HTMLElement).click();
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current.text = (now - typed.current.at > 600 ? "" : typed.current.text) + e.key.toLowerCase();
      typed.current.at = now;
      const list = enabled();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const ordered = [...list.slice(at + 1), ...list.slice(0, at + 1)];
      ordered.find((el) => (el.dataset.label ?? "").toLowerCase().startsWith(typed.current.text))?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <div ref={ref} className="menu-list" onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        if (item.type === "separator") return <div key={`sep-${i}`} role="separator" className="menu-separator" />;
        if (item.type === "group") return <div key={`group-${i}`} role="presentation" className="menu-group-label">{item.label}</div>;
        if (item.type === "choice") {
          return (
            <div key={`choice-${i}`} role="group" aria-label={item.label} className="menu-choice">
              {item.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={o.checked}
                  className="menu-choice-option"
                  data-label={o.label}
                  onClick={() => item.onSelect(o.id)}
                >
                  {o.icon && <I name={o.icon} size={14} />}
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
          );
        }
        return <MenuItemView key={item.id} item={item} onDone={onDone} />;
      })}
    </div>
  );
}

function MenuItemView({ item, onDone }: { item: ActionSpec; onDone: (restoreFocus: boolean) => void }) {
  const disabled = !!item.disabledReason;
  const role = item.checked === undefined ? "menuitem" : "menuitemcheckbox";
  const hintId = useId();
  const body = (
    <>
      {item.checked !== undefined ? (
        <span className="menu-item-check" aria-hidden="true">
          {item.checked && <I name="check" size={16} />}
        </span>
      ) : (
        item.icon && <I name={item.icon} size={16} />
      )}
      <span className="menu-item-text">
        <span className="menu-item-label">{item.label}</span>
        {(item.hint || item.disabledReason) && (
          <span className="menu-item-hint" id={hintId}>
            {item.disabledReason ?? item.hint}
          </span>
        )}
      </span>
      {item.shortcut && (
        <span className="menu-item-shortcut" aria-hidden="true">
          {item.shortcut}
        </span>
      )}
      {item.external && (
        <>
          <I name="external" size={14} />
          <span className="sr-only">(opens in a new tab)</span>
        </>
      )}
    </>
  );
  const common = {
    role,
    tabIndex: -1,
    className: cx("menu-item", item.tone === "danger" && "menu-item-danger"),
    "data-label": item.label,
    "aria-disabled": disabled || undefined,
    "aria-checked": item.checked === undefined ? undefined : item.checked,
    "aria-describedby": item.hint || item.disabledReason ? hintId : undefined,
    "aria-keyshortcuts": item.shortcut,
  } as const;
  if (item.href && !disabled) {
    return (
      <a
        {...common}
        href={item.href}
        target={item.external ? "_blank" : undefined}
        rel={item.external ? "noopener noreferrer" : undefined}
        onClick={() => {
          onDone(false);
          item.onSelect?.();
        }}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      {...common}
      type="button"
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onDone(true);
        item.onSelect?.();
      }}
    >
      {body}
    </button>
  );
}

export interface MenuProps {
  items: MenuItemSpec[];
  open: boolean;
  onClose(): void;
  anchorRef: RefObject<HTMLElement>;
  label: string;
  id?: string;
  align?: "start" | "end";
  initial?: "first" | "last";
  /** Non-interactive content above the items (the user menu's avatar, email and role line). */
  header?: ReactNode;
  /** Extra class on the panel. */
  className?: string;
}

/** A menu anchored to a trigger; a bottom sheet at ≤ 640px. */
export function Menu({ items, open, onClose, anchorRef, label, id, align = "start", initial = "first", header, className }: MenuProps) {
  const phone = useMediaQuery("(max-width: 640px)");
  const done = (restore: boolean) => {
    if (restore) quietFocus(anchorRef.current);
    onClose();
  };
  if (!open) return null;
  if (phone) {
    return (
      <Sheet open side="bottom" title={label} onClose={onClose}>
        {header && <div className="menu-header">{header}</div>}
        <div role="menu" aria-label={label} id={id} className={cx("menu menu-in-sheet", className)}>
          <MenuList items={items} onDone={done} initial={initial} />
        </div>
      </Sheet>
    );
  }
  if (header) {
    // The header can't sit inside role="menu" (only items may), so the panel is a plain popover around both.
    return (
      <Popover anchorRef={anchorRef} open onClose={onClose} label={label} className={cx("menu menu-with-header", className)} placement={align === "end" ? "bottom-end" : "bottom-start"} autoFocus={false}>
        <div className="menu-header">{header}</div>
        <div role="menu" aria-label={label} id={id}>
          <MenuList items={items} onDone={done} initial={initial} />
        </div>
      </Popover>
    );
  }
  return (
    <Popover anchorRef={anchorRef} open onClose={onClose} label={label} id={id} role="menu" className={cx("menu", className)} placement={align === "end" ? "bottom-end" : "bottom-start"} autoFocus={false}>
      <MenuList items={items} onDone={done} initial={initial} />
    </Popover>
  );
}

export interface MenuButtonProps {
  label: string;
  icon?: IconName;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  items: MenuItemSpec[];
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
}

/** A button that opens a menu (aria-haspopup, aria-expanded, aria-controls; ArrowDown/Up open it too). */
export function MenuButton({ label, icon, iconOnly, variant = "secondary", size = "md", items, align = "start", className, disabled }: MenuButtonProps) {
  const [open, setOpen] = useState<false | "first" | "last">(false);
  const ref = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const common = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": !!open,
    "aria-controls": open ? menuId : undefined,
    disabled,
    onClick: () => setOpen((o) => (o ? false : "first")),
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(e.key === "ArrowDown" ? "first" : "last");
      }
    },
  };
  const trigger = iconOnly ? (
    <Tooltip content={label} describe={false}>
      <button ref={ref} type="button" className={cx("btn-icon", variant === "secondary" && "btn-icon-secondary", className)} data-size={size} data-variant={variant} aria-label={label} {...common}>
        <I name={icon ?? "more"} size={size === "sm" ? 16 : 18} />
      </button>
    </Tooltip>
  ) : (
    <button ref={ref} type="button" className={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)} {...common}>
      {icon && <I name={icon} size={16} />}
      <span>{label}</span>
      <I name="chevron-down" size={16} />
    </button>
  );
  return (
    <>
      {trigger}
      <Menu items={items} open={!!open} initial={open || "first"} onClose={() => setOpen(false)} anchorRef={ref} label={label} id={menuId} align={align} />
    </>
  );
}

export interface OverflowMenuProps {
  items: MenuItemSpec[];
  label?: string;
  size?: "sm" | "md";
}

/** "⋯ More actions". Destructive items go last, after a separator. */
export function OverflowMenu({ items, label = "More actions", size = "md" }: OverflowMenuProps) {
  if (!items.some(isAction)) return null;
  return <MenuButton label={label} icon="more" iconOnly variant="ghost" size={size} items={items} align="end" />;
}

// ---- Dialog and Sheet ---------------------------------------------------------------------------------------

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg";
  footer?: ReactNode;
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  children: ReactNode;
}

export interface SheetProps extends Omit<DialogProps, "size"> {
  side: "bottom" | "left" | "right";
}

/** A modal dialog (native <dialog> + showModal: top layer, inert page, focus trap). A bottom sheet at ≤ 640px. */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <ModalPanel {...props} kind="dialog" />;
}

/** A modal panel from the bottom, left or right edge (phone drawer, Create, Filters, desktop side panels). */
export function Sheet(props: SheetProps) {
  if (!props.open) return null;
  return <ModalPanel {...props} kind="sheet" />;
}

const FIELD = 'input:not([type="hidden"]):not([type="file"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

function ModalPanel({
  onClose,
  title,
  description,
  size = "md",
  footer,
  dismissible = true,
  initialFocusRef,
  children,
  kind,
  side,
}: DialogProps & { kind: "dialog" | "sheet"; side?: SheetProps["side"] }) {
  const [el, setEl] = useState<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;
  const downOnBackdrop = useRef(false);

  useLayoutEffect(() => {
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    try {
      // showModal() focuses a control itself before we pick one; neither should pop a tooltip.
      if (!el.open) quietly(() => el.showModal());
    } catch {
      el.setAttribute("open", "");
    }
    const unlock = lockScroll();
    const body = el.querySelector<HTMLElement>(".dialog-body");
    // The first *visible* match: a folded-away control (display:none) can't take focus.
    const pick = (root: Element | null | undefined, sel: string) => Array.from(root?.querySelectorAll<HTMLElement>(sel) ?? []).find((n) => n.getClientRects().length > 0) ?? null;
    const first = initialFocusRef?.current ?? pick(el, "[data-autofocus]") ?? pick(body, FIELD) ?? pick(body, FOCUSABLE) ?? pick(el, ".dialog-footer " + FOCUSABLE);
    quietFocus(first ?? el.querySelector<HTMLElement>(".dialog-close") ?? el);
    return () => {
      unlock();
      // Closing a modal <dialog> makes the browser restore focus to the opener itself, so keep that quiet too.
      if (el.open) quietly(() => el.close());
      if (prev && document.contains(prev)) quietFocus(prev);
    };
  }, [el]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <dialog
      ref={setEl}
      className={kind === "sheet" ? "sheet" : "dialog"}
      data-size={kind === "dialog" ? size : undefined}
      data-side={kind === "sheet" ? side : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissRef.current) closeRef.current();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current && dismissRef.current) closeRef.current();
        downOnBackdrop.current = false;
      }}
    >
      <PortalTargetContext.Provider value={el}>
        <div className="dialog-panel">
          {kind === "sheet" && side === "bottom" && <div className="sheet-grip" aria-hidden="true" />}
          <header className="dialog-header">
            <div className="dialog-heading">
              <h2 id={titleId} className="dialog-title">
                {title}
              </h2>
              {description && (
                <div id={descId} className="dialog-description">
                  {description}
                </div>
              )}
            </div>
            <IconButton
              icon="x"
              label="Close"
              size="sm"
              className="dialog-close"
              disabledReason={dismissible ? undefined : "Wait until this finishes"}
              onClick={() => closeRef.current()}
            />
          </header>
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </div>
      </PortalTargetContext.Provider>
    </dialog>,
    document.body,
  );
}

// ---- Confirmations --------------------------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  typeToConfirm?: { values: string[]; label?: string };
  reason?: { label: string; required?: boolean; minLength?: number; maxLength?: number; presets?: string[]; placeholder?: string; hint?: string };
}
export interface ConfirmResult {
  typed?: string;
  reason?: string;
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<ConfirmResult | null>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** `const confirm = useConfirm(); const r = await confirm({...})` → null when cancelled. Needs KitProvider. */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm() needs a KitProvider");
  return fn;
}

interface PendingConfirm {
  key: number;
  opts: ConfirmOptions;
  resolve: (r: ConfirmResult | null) => void;
}

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const nextKey = useRef(1);
  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise((resolve) => {
        setQueue((q) => [...q, { key: nextKey.current++, opts, resolve }]);
      }),
    [],
  );
  const current = queue[0];
  const settle = (r: ConfirmResult | null) => {
    if (!current) return;
    current.resolve(r);
    setQueue((q) => q.slice(1));
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && <ConfirmDialog key={current.key} opts={current.opts} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function ConfirmDialog({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (r: ConfirmResult | null) => void }) {
  const { title, body, confirmLabel, cancelLabel = "Cancel", tone = "default", typeToConfirm, reason } = opts;
  const [typed, setTyped] = useState("");
  const [why, setWhy] = useState("");
  const [tried, setTried] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const typedId = useId();
  const reasonId = useId();

  const typedOk = !typeToConfirm || typeToConfirm.values.some((v) => norm(v) === norm(typed));
  const min = reason ? Math.max(reason.minLength ?? 0, reason.required ? 1 : 0) : 0;
  const reasonOk = !reason || why.trim().length >= min;
  const ok = typedOk && reasonOk;
  const needs = !typedOk
    ? `Type “${typeToConfirm!.values[0]}” to confirm.`
    : !reasonOk
      ? min > 1
        ? `Give a reason (at least ${min} characters).`
        : "Give a reason to continue."
      : null;

  const submit = () => {
    if (!ok) {
      setTried(true);
      return;
    }
    onSettle({ typed: typeToConfirm ? typed.trim() : undefined, reason: reason ? why.trim() : undefined });
  };
  const initial = typeToConfirm || reason ? undefined : tone === "danger" ? cancelRef : confirmRef;

  return (
    <Dialog
      open
      size="sm"
      title={title}
      onClose={() => onSettle(null)}
      initialFocusRef={initial}
      footer={
        <>
          {needs && (
            <p className={cx("confirm-needs", tried && "confirm-needs-error")} aria-live="polite">
              {needs}
            </p>
          )}
          <Button ref={cancelRef} variant="secondary" onClick={() => onSettle(null)}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} variant={tone === "danger" ? "danger-solid" : "primary"} aria-disabled={!ok || undefined} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div
        className="confirm-body"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            submit();
          }
        }}
      >
        {body && <div className="confirm-text">{body}</div>}
        {typeToConfirm && (
          <div className="field">
            <label className="field-label" htmlFor={typedId}>
              {typeToConfirm.label ?? `Type ${typeToConfirm.values[0]} to confirm`}
            </label>
            <input
              id={typedId}
              className="input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={tried && !typedOk ? true : undefined}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}
        {reason && (
          <div className="field">
            <label className="field-label" htmlFor={reasonId}>
              {reason.label}
              {!reason.required && !reason.minLength && <span className="field-optional"> (optional)</span>}
            </label>
            {reason.presets && reason.presets.length > 0 && (
              <div className="confirm-presets" role="group" aria-label="Common reasons">
                {reason.presets.map((p) => (
                  <button key={p} type="button" className="chip" aria-pressed={why === p} onClick={() => setWhy(p)}>
                    {p}
                  </button>
                ))}
              </div>
            )}
            <textarea
              id={reasonId}
              className="textarea"
              rows={3}
              value={why}
              maxLength={reason.maxLength}
              placeholder={reason.placeholder}
              aria-invalid={tried && !reasonOk ? true : undefined}
              aria-describedby={reason.hint ? `${reasonId}-hint` : undefined}
              onChange={(e) => setWhy(e.target.value)}
            />
            {reason.hint && (
              <p id={`${reasonId}-hint`} className="field-hint">
                {reason.hint}
              </p>
            )}
          </div>
        )}
        <p className="sr-only">Press Command or Control and Enter to confirm.</p>
      </div>
    </Dialog>
  );
}

// ---- Provider ----------------------------------------------------------------------------------------------

/** Toasts, confirmations and the portal target. App wraps everything (gates too) in it. */
export function KitProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => null, []);
  return (
    <PortalTargetContext.Provider value={value}>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </PortalTargetContext.Provider>
  );
}

export type { Placement };
