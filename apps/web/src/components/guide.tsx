import { useEffect, useState, useSyncExternalStore } from "react";
import { useApi, useMediaQuery } from "../hooks";
import { I } from "./icons";
import { Button, Card, Checkbox, SkeletonText, ToggleButton } from "./kit";
import { typeLabel } from "./labels";

/**
 * The editor's writing guide (SPEC "later" list): what each section of this article or finding type should contain,
 * from the server's templates, and a short checklist. It can be hidden; the choice is remembered in this browser.
 */

export interface Guide {
  kind: "article" | "finding";
  type: string;
  sections: { heading: string; hint: string; field?: "symptoms" | "root_cause" | "fix" }[];
  checklist: string[];
}

const KEY = "thaliyola.writingGuide";
/** Below this the guide goes above the form instead of in the rail (Page's rail stacks under the editor there). */
const NARROW = "(max-width: 1100px)";
const EVENT = "thaliyola:writingGuide";

/** The remembered choice: true (shown), false (hidden) or null (never chosen). */
function readChoice(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "shown" ? true : v === "hidden" ? false : null;
  } catch {
    return null;
  }
}
let override: boolean | null = null;

/**
 * Whether the guide is showing, and a setter that remembers the choice in this browser. Until someone chooses, it
 * shows beside the editor on wide screens and stays folded away on narrow ones (where it would sit above the form).
 */
export function useWritingGuideOpen(): [boolean, (open: boolean) => void] {
  const narrow = useMediaQuery(NARROW);
  const choice = useSyncExternalStore(
    (l) => {
      window.addEventListener(EVENT, l);
      return () => window.removeEventListener(EVENT, l);
    },
    () => override ?? readChoice(),
    () => null,
  );
  const set = (next: boolean) => {
    override = next;
    try {
      localStorage.setItem(KEY, next ? "shown" : "hidden");
    } catch {
      /* storage unavailable: remembered for this page only */
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return [choice ?? !narrow, set];
}

/** The ## sections of a markdown body that have something under them (hint comments don't count). Pure, for tests. */
export function filledSections(markdown: string): Set<string> {
  const out = new Set<string>();
  const parts = markdown.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase();
    const body = (nl < 0 ? "" : part.slice(nl + 1)).replace(/<!--[\s\S]*?-->/g, "").trim();
    if (body) out.add(heading);
  }
  return out;
}

/** "Writing guide" in the editor's header: shows or hides the guide. */
export function WritingGuideToggle() {
  const [open, setOpen] = useWritingGuideOpen();
  return <ToggleButton icon="book" label="Writing guide" iconOnly="phone" pressed={open} onPressedChange={setOpen} tooltip={open ? "Hide the writing guide" : "Show the writing guide"} />;
}

export interface WritingGuideProps {
  kind: "article" | "finding";
  type: string;
  /** Headings (lower case) or finding fields that already have text: they get a tick. */
  filled?: Set<string>;
}

/** The guide itself (render it where the editor has room: the rail on wide screens, above the form on narrow ones). */
export function WritingGuide({ kind, type, filled }: WritingGuideProps) {
  const [, setOpen] = useWritingGuideOpen();
  const guide = useApi<Guide>(`/writing-guide/${kind}/${encodeURIComponent(type)}`);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  useEffect(() => setChecked(new Set()), [kind, type]);
  const g = guide.data;
  return (
    <Card
      as="section"
      padding="sm"
      className="it-guide"
      title={
        <span className="it-guide-title">
          <I name="book" size={16} /> Writing guide
        </span>
      }
      description={`${typeLabel(type)}: what each part should say.`}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Hide
        </Button>
      }
    >
      {guide.error ? (
        <p className="muted small">The guide couldn't be loaded.</p>
      ) : !g ? (
        <SkeletonText lines={5} />
      ) : (
        <>
          {g.sections.length > 0 ? (
            <ol className="it-guide-sections">
              {g.sections.map((s) => {
                const done = !!filled && filled.has(s.field ?? s.heading.toLowerCase());
                return (
                  <li key={s.heading} className="it-guide-section" data-done={done || undefined}>
                    <span className="it-guide-mark" aria-hidden="true">
                      {done ? <I name="check-circle" size={16} /> : <span className="it-guide-dot" />}
                    </span>
                    <span className="it-guide-text">
                      <span className="it-guide-heading">
                        {s.heading}
                        {done && <span className="sr-only"> (written)</span>}
                      </span>
                      <span className="it-guide-hint">{s.hint}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted small">Free-form: no set sections.</p>
          )}
          <fieldset className="it-guide-checklist">
            <legend className="it-guide-legend">Before you save</legend>
            {g.checklist.map((c, i) => (
              <Checkbox
                key={c}
                label={c}
                checked={checked.has(i)}
                onChange={(e) =>
                  setChecked((x) => {
                    const n = new Set(x);
                    if (e.target.checked) n.add(i);
                    else n.delete(i);
                    return n;
                  })
                }
              />
            ))}
          </fieldset>
        </>
      )}
    </Card>
  );
}

/**
 * Where the guide goes on an editor page: `rail` for Page's rail on wide screens, `top` above the form on narrow ones
 * (a rail stacks under a long editor there). Both are undefined while it's hidden.
 */
export function useGuidePlacement(guide: JSX.Element): { rail?: JSX.Element; top?: JSX.Element } {
  const [open] = useWritingGuideOpen();
  const narrow = useMediaQuery(NARROW);
  if (!open) return {};
  return narrow ? { top: guide } : { rail: guide };
}
