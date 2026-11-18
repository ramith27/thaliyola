/**
 * Gates (SPEC §5.15): GateCard for sign-in, waiting, invitation and boot errors; Splash while Thaliyola starts.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { I, type IconName } from "../icons";
import { Spinner } from "./feedback";

export interface GateCardProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: IconName;
  /** Inside the signed-in shell (which already has the <main> landmark): a plain block, no full-screen backdrop. */
  inline?: boolean;
}

/** The logo above a 400px card: a title, one sentence, the content and a footer link. */
export function GateCard({ title, description, children, footer, icon, inline }: GateCardProps) {
  const id = useId();
  const Root = inline ? "div" : "main";
  return (
    <Root className={inline ? "gate kit-gate gate-inline" : "gate kit-gate"}>
      <p className="gate-logo">
        <img src="/favicon.svg" alt="" width={32} height={32} />
        <span>Thaliyola</span>
      </p>
      <section className="gate-card" aria-labelledby={id}>
        {icon && (
          <span className="gate-card-icon" aria-hidden="true">
            <I name={icon} size={20} />
          </span>
        )}
        <h1 id={id} className="gate-card-title">
          {title}
        </h1>
        {description && <div className="gate-card-description">{description}</div>}
        {children && <div className="gate-card-body">{children}</div>}
        {footer && <div className="gate-card-foot">{footer}</div>}
      </section>
    </Root>
  );
}

/** The logo; after 300ms a spinner and "Loading Thaliyola…" (so quick boots don't flash). */
export function Splash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <main className="splash" aria-busy="true">
      <img src="/favicon.svg" alt="Thaliyola" width={40} height={40} className="splash-logo" />
      {slow && (
        <p className="splash-text">
          <Spinner size={16} label="Loading Thaliyola" />
          <span aria-hidden="true">Loading Thaliyola…</span>
        </p>
      )}
    </main>
  );
}
