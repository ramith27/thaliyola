/**
 * Buttons (SPEC §5.1): Button, IconButton, ToggleButton, SplitButton.
 * Rules: at most one primary per view; danger-solid only to confirm a danger dialog or a Danger zone's main action;
 * icon-only actions are IconButtons (label + tooltip); prefer disabledReason to a silent disabled; async → loading.
 */
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { I, type IconName } from "../icons";
import { useToast } from "./feedback";
import { MenuButton, Tooltip, type MenuItemSpec } from "./overlay";
import { cx, isMac } from "./util";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconEnd?: IconName;
  loading?: boolean;
  loadingText?: string;
  disabledReason?: string;
  href?: string;
  external?: boolean;
  block?: boolean;
  shortcut?: string;
  type?: "button" | "submit" | "reset";
}

/** "mod+s" → "⌘S" (Mac) or "Ctrl+S"; and the aria-keyshortcuts form ("Meta+S" / "Control+S"). */
export function shortcutText(combo: string): { visible: string; aria: string } {
  const mac = isMac();
  const parts = combo.split("+").map((p) => p.trim());
  const visible = parts
    .map((p) => (p.toLowerCase() === "mod" ? (mac ? "⌘" : "Ctrl+") : p.toLowerCase() === "shift" ? (mac ? "⇧" : "Shift+") : p.length === 1 ? p.toUpperCase() : p))
    .join("");
  const aria = parts.map((p) => (p.toLowerCase() === "mod" ? (mac ? "Meta" : "Control") : p.toLowerCase() === "shift" ? "Shift" : p.length === 1 ? p.toUpperCase() : p)).join("+");
  return { visible, aria };
}

const textOf = (n: ReactNode): string => (typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : "");

/** A button (or a link styled as one with `href`). `.btn` alone looks secondary. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconEnd, loading, loadingText, disabledReason, href, external, block, shortcut, type = "button", className, children, onClick, "aria-disabled": ariaDisabled, ...rest },
  ref,
) {
  const [showReason, setShowReason] = useState(false);
  useEffect(() => {
    if (!showReason) return;
    const t = setTimeout(() => setShowReason(false), 3000);
    return () => clearTimeout(t);
  }, [showReason]);

  const cls = cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", size === "lg" && "btn-lg", block && "btn-block", className);
  const keys = shortcut ? shortcutText(shortcut) : null;
  const tip = disabledReason ?? (keys ? `${textOf(children) || ""} (${keys.visible})`.trim() : undefined);
  const iconSize = size === "lg" ? 18 : 16;
  const content = (
    <>
      <span className="btn-content">
        {icon && <I name={icon} size={iconSize} />}
        {children !== undefined && children !== null && children !== false && <span className="btn-label">{children}</span>}
        {iconEnd && <I name={iconEnd} size={iconSize} />}
        {external && (
          <>
            <I name="external" size={14} />
            <span className="sr-only">(opens in a new tab)</span>
          </>
        )}
      </span>
      {loading && <span className="spinner btn-spinner" aria-hidden="true" />}
    </>
  );

  const blocked = !!disabledReason;
  const handle = (e: MouseEvent<HTMLElement>) => {
    if (blocked) {
      e.preventDefault();
      setShowReason(true);
      return;
    }
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e as MouseEvent<HTMLButtonElement>);
  };

  const el = href ? (
    <a
      className={cls}
      href={blocked ? undefined : href}
      role={blocked ? "link" : undefined}
      aria-disabled={blocked || undefined}
      tabIndex={blocked ? 0 : undefined}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      aria-keyshortcuts={keys?.aria}
      aria-label={rest["aria-label"]}
      id={rest.id}
      onClick={handle}
    >
      {content}
    </a>
  ) : (
    <button
      ref={ref}
      type={type}
      {...rest}
      className={cls}
      aria-busy={loading || undefined}
      aria-disabled={blocked || ariaDisabled || undefined}
      aria-keyshortcuts={keys?.aria}
      onClick={handle}
    >
      {content}
    </button>
  );

  return (
    <>
      {tip ? (
        <Tooltip content={tip} forceOpen={showReason}>
          {el}
        </Tooltip>
      ) : (
        el
      )}
      {loadingText !== undefined && (
        <span className="sr-only" aria-live="polite">
          {loading ? loadingText : ""}
        </span>
      )}
    </>
  );
});

export interface IconButtonProps {
  icon: IconName;
  label: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
  pressed?: boolean;
  /** A small count on the icon. Include the number in `label` too ("Notifications, 3 unread"). */
  badge?: number;
  href?: string;
  onClick?: (e: MouseEvent) => void;
  disabledReason?: string;
  className?: string;
  id?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "aria-haspopup"?: "menu" | "dialog" | "listbox" | true;
}

/** An icon-only action: always labelled, always with a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = "md", variant = "ghost", pressed, badge, href, onClick, disabledReason, className, ...aria },
  ref,
) {
  const [showReason, setShowReason] = useState(false);
  useEffect(() => {
    if (!showReason) return;
    const t = setTimeout(() => setShowReason(false), 3000);
    return () => clearTimeout(t);
  }, [showReason]);
  const cls = cx("btn-icon", variant === "secondary" && "btn-icon-secondary", className);
  const inner = (
    <>
      <I name={icon} size={size === "sm" ? 16 : 18} />
      {!!badge && (
        <span className="btn-icon-badge" aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </>
  );
  const blocked = !!disabledReason;
  const handle = (e: MouseEvent) => {
    if (blocked) {
      e.preventDefault();
      setShowReason(true);
      return;
    }
    onClick?.(e);
  };
  const el = href && !blocked ? (
    <a className={cls} data-size={size} href={href} aria-label={label} onClick={handle} id={aria.id}>
      {inner}
    </a>
  ) : (
    <button ref={ref} type="button" className={cls} data-size={size} aria-label={label} aria-pressed={pressed} aria-disabled={blocked || undefined} onClick={handle} {...aria}>
      {inner}
    </button>
  );
  return (
    <Tooltip content={disabledReason ? `${label}: ${disabledReason}` : label} describe={blocked} forceOpen={showReason}>
      {el}
    </Tooltip>
  );
});

export interface ToggleButtonProps {
  pressed: boolean;
  onPressedChange: (next: boolean) => Promise<void> | void;
  icon: IconName;
  label: string;
  pressedLabel?: string;
  iconOnly?: boolean | "phone";
  tooltip?: string;
  pressedTooltip?: string;
  /** The initial state is still loading: a same-size placeholder keeps the toolbar from shifting. */
  loading?: boolean;
  size?: "sm" | "md";
}

/**
 * Watch, Favourite and other on/off actions. Updates at once and reverts with an error toast if the server says no.
 */
export function ToggleButton({ pressed, onPressedChange, icon, label, pressedLabel, iconOnly, tooltip, pressedTooltip, loading, size = "md" }: ToggleButtonProps) {
  const toast = useToast();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const busy = useRef(false);
  useEffect(() => setOptimistic(null), [pressed]);
  const on = optimistic ?? pressed;
  const text = on ? (pressedLabel ?? label) : label;
  const cls = cx("btn btn-toggle", size === "sm" && "btn-sm", iconOnly === true && "btn-toggle-icon");

  if (loading) {
    return (
      <span className={cx(cls, "btn-placeholder")} aria-hidden="true">
        <I name={icon} size={16} />
        {iconOnly !== true && <span className="btn-label">{label}</span>}
      </span>
    );
  }
  const button = (
    <button
      type="button"
      className={cls}
      aria-pressed={on}
      aria-label={iconOnly === true ? label : undefined}
      onClick={async () => {
        if (busy.current) return;
        busy.current = true;
        const next = !on;
        setOptimistic(next);
        try {
          await onPressedChange(next);
        } catch (e) {
          setOptimistic(!next);
          toast.error(e, { description: `Couldn't ${next ? "turn on" : "turn off"} ${label.toLowerCase()}.` });
        } finally {
          busy.current = false;
        }
      }}
    >
      <I name={icon} size={16} />
      {iconOnly !== true && <span className={cx("btn-label", iconOnly === "phone" && "btn-label-phone-hidden")}>{text}</span>}
    </button>
  );
  const tip = on ? (pressedTooltip ?? tooltip) : tooltip;
  return tip || iconOnly === true ? <Tooltip content={tip ?? label}>{button}</Tooltip> : button;
}

export interface SplitButtonProps {
  label: string;
  icon?: IconName;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
  menu: MenuItemSpec[];
  menuLabel: string;
  /** Busy with the main action: the main button shows its spinner and the menu waits. */
  loading?: boolean;
  loadingText?: string;
  /** Why neither the action nor its menu can be used here (shown when the main button is pressed). */
  disabledReason?: string;
}

/** A main action plus a menu of related ones ("New article ▾"). */
export function SplitButton({ label, icon, href, onClick, variant = "primary", menu, menuLabel, loading, loadingText, disabledReason }: SplitButtonProps) {
  return (
    <span className="split-btn" role="group" aria-label={label}>
      <Button variant={variant} icon={icon} href={href} onClick={onClick} className="split-btn-main" loading={loading} loadingText={loadingText} disabledReason={disabledReason}>
        {label}
      </Button>
      <MenuButton label={menuLabel} icon="chevron-down" iconOnly variant={variant} items={menu} align="end" className="split-btn-menu" disabled={loading || !!disabledReason} />
    </span>
  );
}
