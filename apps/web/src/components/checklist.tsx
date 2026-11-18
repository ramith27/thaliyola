import { type ReactNode } from "react";
import { api } from "../api";
import { I } from "./icons";
import { useApi } from "../hooks";
import { Button, Card, Disclosure, ErrorState, InfoTip, Skeleton, SkeletonText, useAsyncAction } from "./kit";

/**
 * A step's detail in plain words; the server sends environment variable names and other server configuration
 * separately (`technical`), shown behind a "Technical details" InfoTip (principle 5).
 */
function StepDetail({ step }: { step: ChecklistStep }) {
  if (!step.technical) return <>{step.detail}</>;
  return (
    <>
      {step.detail}{" "}
      <InfoTip label="Technical details">
        <code>{step.technical}</code>
      </InfoTip>
    </>
  );
}

// ---- First-run checklist (SPEC §6.2 item 3, "Finish setting up") ------------------------------------------------

export interface ChecklistStep {
  key: string;
  title: string;
  detail: string;
  /** Server configuration for whoever runs it (environment variables); null when there is none. */
  technical?: string | null;
  done: boolean;
  link: string;
}

export interface OnboardingData {
  steps: ChecklistStep[];
  dismissed: boolean;
}

type Result<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void };

/** Whether the checklist has nothing left to show (hidden by the person, or every step done). */
export const checklistFinished = (d: OnboardingData) => d.dismissed || d.steps.every((s) => s.done);

const isExternal = (link: string) => /^https?:/i.test(link);

/**
 * The setup checklist, or `fallback` once it's finished or hidden.
 * Home passes its own `/onboarding` result (so it knows when the For-you band is empty) and `followHref`, which
 * replaces the server's "#/" link on "Follow what matters to you" with the first readable project.
 */
export function Checklist({
  fallback = null,
  result,
  followHref,
  onHidden,
}: {
  fallback?: ReactNode;
  result?: Result<OnboardingData>;
  followHref?: string;
  /** Called once Hide has been saved, so the page can move focus to what replaces the checklist. */
  onHidden?: () => void;
}) {
  const own = useApi<OnboardingData>(result ? null : "/onboarding");
  const r = result ?? own;
  const { data, error, reload } = r;
  const hide = useAsyncAction(
    async (dismissed: boolean) => {
      await api("/account/prefs", { method: "PUT", body: { onboarding_dismissed: dismissed } });
      if (dismissed) onHidden?.();
      reload();
    },
    {
      success: "Setup checklist hidden",
      undo: async () => {
        await api("/account/prefs", { method: "PUT", body: { onboarding_dismissed: false } });
        reload();
      },
    },
  );

  if (!data) {
    if (error) {
      return (
        <Card as="section" title="Finish setting up" className="hm-setup">
          <ErrorState compact error={error} title="Couldn't load the setup checklist" onRetry={reload} />
        </Card>
      );
    }
    // Reserve the card's height while it loads, so nothing below jumps.
    return (
      <Card className="hm-setup hm-setup-skeleton">
        <span className="sr-only" role="status">
          Loading the setup checklist
        </span>
        <Skeleton width="45%" height={18} />
        <Skeleton width="100%" height={6} radius="full" />
        <SkeletonText lines={3} />
      </Card>
    );
  }
  if (checklistFinished(data)) return <>{fallback}</>;

  const steps = data.steps.map((s) => (s.key === "follow" && followHref && (!s.link || s.link === "#/") ? { ...s, link: followHref } : s));
  const done = steps.filter((s) => s.done);
  const open = steps.filter((s) => !s.done);
  const [next, ...rest] = open;

  return (
    <Card
      as="section"
      title="Finish setting up"
      className="hm-setup"
      description={
        <div className="hm-setup-progress">
          <span className="tabular">
            {done.length} of {steps.length} done
          </span>
          <span className="hm-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done.length}>
            <span className="hm-progress-fill" style={{ width: `${(done.length / Math.max(1, steps.length)) * 100}%` }} />
          </span>
        </div>
      }
      actions={
        <Button variant="ghost" size="sm" loading={hide.busy} onClick={() => void hide.run(true)}>
          Hide
        </Button>
      }
    >
      <div className="hm-setup-body">
        {next && (
          <div className="hm-setup-next">
            <p className="hm-setup-next-label">Next step</p>
            <p className="hm-setup-next-detail">
              <StepDetail step={next} />
            </p>
            <Button href={next.link} external={isExternal(next.link)} iconEnd={isExternal(next.link) ? undefined : "chevron-right"}>
              {next.title}
            </Button>
          </div>
        )}
        {rest.length > 0 && (
          <ul className="hm-steps" aria-label="Other steps">
            {rest.map((s) => (
              <li key={s.key} className="hm-step">
                <span className="hm-step-check" aria-hidden="true" />
                <div className="hm-step-text">
                  <a className="hm-step-title" href={s.link} target={isExternal(s.link) ? "_blank" : undefined} rel={isExternal(s.link) ? "noopener noreferrer" : undefined}>
                    {s.title}
                    {isExternal(s.link) && (
                      <>
                        {" "}
                        <I name="external" size={14} />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </>
                    )}
                  </a>
                  <p className="hm-step-detail">
                    <StepDetail step={s} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {done.length > 0 && (
          <Disclosure summary={`Show done steps (${done.length})`} className="hm-setup-done">
            <ul className="hm-steps" aria-label="Done steps">
              {done.map((s) => (
                <li key={s.key} className="hm-step" data-state="done">
                  <span className="hm-step-check" aria-hidden="true">
                    <I name="check" size={14} />
                  </span>
                  <div className="hm-step-text">
                    <span className="hm-step-title">
                      <span className="sr-only">Done: </span>
                      {s.title}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </Card>
  );
}

/** Shown in the setup slot when the checklist is hidden or finished and the person hasn't connected Claude yet. */
export function ConnectClaudeCard() {
  return (
    <Card
      as="section"
      title={
        // tabIndex -1: focus lands here when this card replaces the hidden checklist.
        <span id="hm-connect-title" tabIndex={-1}>
          Connect Claude to Thaliyola
        </span>
      }
      className="hm-setup"
    >
      <div className="hm-setup-body">
        <p className="hm-setup-next-detail">Create a token and copy one command. Claude will search team knowledge before it investigates and load project context before it codes.</p>
        <div>
          <Button href="#/connect" icon="plug">
            Connect your tools
          </Button>
        </div>
      </div>
    </Card>
  );
}
