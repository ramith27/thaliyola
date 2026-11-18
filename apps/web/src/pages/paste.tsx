import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { clearInboxOrigin, peekInboxOrigin, setInboxOrigin, type InboxOrigin } from "../components/handoff";
import { Badge, Button, Callout, ChoiceCards, Disclosure, Field, FormActions, Page, PageHeader, RunWithClaude, SegmentedControl, Textarea, TypeLabel } from "../components/kit";
import { Markdown } from "../components/ui";
import { useAppRoute, useMediaQuery, useShortcuts } from "../hooks";
import { draftArticle, draftFinding, setPrefill, type ArticleDraft, type FindingDraft } from "../paste";
import { href, navigate } from "../router";

/** Paste a Slack thread, email or notes; get a draft finding or article to check and save. */

const HANDOVER_KEY = "thaliyola.pasteDraft";

/** Text handed over by another page (e.g. an inbox item). Read here; cleared once the page has mounted. */
function handedOver(): string {
  try {
    return sessionStorage.getItem(HANDOVER_KEY) ?? "";
  } catch {
    return "";
  }
}

type Kind = "finding" | "article";

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "finding", label: "Finding (something happened)" },
  { value: "article", label: "Article (how things are)" },
];

const EXAMPLE = `Checkout returning 502s for EU customers

Wes  10:42 AM
Seeing a spike of 502s on /checkout since the 10:15 deploy, only for EU traffic.
:eyes: 2

Priya  10:58 AM
Root cause: the new payments-gateway pool size was set to 5 in the EU config, so requests queued and timed out at the load balancer.
Fix: raised the pool to 50 and added an alert on pool saturation.`;

/** Parts the draft couldn't find, as short warnings. */
function missingParts(d: FindingDraft | ArticleDraft): string[] {
  const out: string[] = [];
  if (!d.title) out.push("No title found: add one before saving");
  if (d.kind === "finding") {
    if (!d.root_cause) out.push("Root cause not found: add it before saving");
    if (!d.fix) out.push("Fix not found");
  }
  return out;
}

export function PasteDraftPage() {
  const route = useAppRoute();
  const inboxId = route.query.get("inbox");
  // Where the draft should land (an inbox item's place); the editor defaults to it.
  const scope = route.query.get("scope");
  const [origin] = useState<InboxOrigin | null>(() => {
    if (!inboxId) return null;
    const o = peekInboxOrigin("finding") ?? peekInboxOrigin("article");
    return o && o.inbox_id === inboxId ? o : null;
  });
  const [text, setText] = useState(handedOver);
  const [kind, setKind] = useState<Kind>("finding");
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const previewId = useId();
  const kindId = useId();
  const phone = useMediaQuery("(max-width: 640px)");
  const narrow = useMediaQuery("(max-width: 860px)");
  const draft = useMemo(() => (text.trim() ? (kind === "finding" ? draftFinding(text) : draftArticle(text)) : null), [text, kind]);

  // The hand-off is read once: clear it after mounting so a reload starts empty.
  useEffect(() => {
    try {
      sessionStorage.removeItem(HANDOVER_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  function open() {
    if (!draft) {
      setError("Paste some text first.");
      textRef.current?.focus();
      return;
    }
    setPrefill(draft);
    // Pass the inbox item on so the editor files it after saving; a stale one from another tab visit must not tag along.
    if (origin) setInboxOrigin(origin, draft.kind);
    else clearInboxOrigin();
    navigate(`/new/${draft.kind}`, scope ? { scope } : undefined);
  }

  useShortcuts({ "mod+Enter": open }, true, { labels: { "mod+Enter": "Open as a draft" } });

  function submit(e: FormEvent) {
    e.preventDefault();
    open();
  }

  const missing = draft ? missingParts(draft) : [];

  return (
    <Page width="content">
      <PageHeader
        title="Draft from pasted text"
        hideTabBar
        nav={origin ? "inbox" : undefined}
        crumbs={inboxId ? [{ label: "Inbox", href: href("/inbox") }] : undefined}
        description="Paste notes, a Slack thread or an email. We'll turn it into a draft you can check."
      />

      {origin && (
        <Callout
          tone="info"
          icon="inbox"
          title={`From the inbox: ${origin.source_name} · ${origin.title}`}
          actions={
            origin.url ? (
              <Button size="sm" variant="ghost" href={origin.url} external>
                Open original
              </Button>
            ) : undefined
          }
        >
          When you save the draft, this inbox item is filed with it.
        </Callout>
      )}

      <form className="ib-paste" onSubmit={submit} noValidate>
        {phone ? (
          // The two long labels don't fit a segmented control at phone width.
          <ChoiceCards name={kindId} legend="Create a" value={kind} onChange={(v) => setKind(v as Kind)} options={KIND_OPTIONS} />
        ) : (
          <SegmentedControl label="Create a" labelVisible options={KIND_OPTIONS} value={kind} onChange={setKind} />
        )}

        <div className="ib-paste-grid">
          <Field label="Pasted text" error={error}>
            <Textarea
              ref={textRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (e.target.value.trim()) setError(null);
              }}
              placeholder="Paste here"
              autoGrow
              minRows={phone ? 8 : 14}
              maxRows={40}
              autoFocus
            />
          </Field>

          <section className="ib-draft" aria-labelledby={previewId}>
            <h2 className="ib-draft-heading" id={previewId} aria-live="polite">
              {draft ? `Draft preview: ${kind === "finding" ? "finding" : "article"}` : "Draft preview"}
            </h2>
            {!draft ? (
              <div className="ib-ghost">
                <p className="ib-ghost-note">The draft appears here as you paste.</p>
                <ol className="ib-ghost-outline" aria-label="What the draft will have">
                  <li>Title</li>
                  {kind === "finding" ? (
                    <>
                      <li>Symptoms</li>
                      <li>Root cause</li>
                      <li>Fix</li>
                    </>
                  ) : (
                    <li>Body, with headings</li>
                  )}
                </ol>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setText(EXAMPLE);
                    setError(null);
                    textRef.current?.focus();
                  }}
                >
                  Try an example
                </button>
              </div>
            ) : (
              <div className="ib-draft-body">
                <p className="ib-draft-type">
                  <TypeLabel type={draft.type} kind={draft.kind} withIcon />
                </p>
                <h3 className="ib-draft-title">{draft.title || <span className="ib-missing">No title found</span>}</h3>
                {missing.length > 0 && (
                  <ul className="ib-warnings" aria-label="Missing parts">
                    {missing.map((m) => (
                      <li key={m}>
                        <Badge tone="warning" icon="alert">
                          {m}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                {draft.kind === "finding" ? (
                  <Markdown
                    text={`**Symptoms.** ${draft.symptoms || "_none found_"}\n\n**Root cause.** ${draft.root_cause || "_not stated: add it before saving_"}\n\n**Fix.** ${draft.fix || "_none found_"}`}
                  />
                ) : (
                  <Markdown text={draft.body_md} />
                )}
              </div>
            )}
          </section>
        </div>

        <Disclosure summary="Tips for a better draft" className="ib-tips">
          <ul className="ib-tips-list">
            <li>The first line becomes the title (or an email's subject).</li>
            <li>
              Label the parts you know, each on its own line: “Symptoms:”, “Root cause:”, “Fix:”. They are pulled out as they are.
            </li>
            <li>Chat noise (timestamps, reactions, “(edited)”) and email signatures are dropped.</li>
            <li>Secrets and personal data are redacted when you save.</li>
            <li>The draft is built by rules, not AI: it won't guess a root cause that isn't written down.</li>
          </ul>
          <RunWithClaude
            title="Get a smarter draft with Claude"
            command="/mcp__thaliyola__draft-from-paste"
            description="The draft-from-paste prompt, in Claude with Thaliyola connected, reads the text and writes the draft for you."
          />
        </Disclosure>

        <FormActions sticky hint={narrow ? undefined : "Nothing is saved yet: you check the draft in the editor first."}>
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              setError(null);
              textRef.current?.focus();
            }}
            disabledReason={text ? undefined : "There's nothing to clear"}
          >
            Clear
          </Button>
          <Button variant="primary" type="submit" shortcut="mod+Enter">
            {kind === "finding" ? "Open as draft finding" : "Open as draft article"}
          </Button>
        </FormActions>
      </form>
    </Page>
  );
}
