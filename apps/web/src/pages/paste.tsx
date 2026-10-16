import { useMemo, useState } from "react";
import { Markdown, Notice } from "../components/ui";
import { draftArticle, draftFinding, setPrefill } from "../paste";
import { navigate } from "../router";

/** Paste a Slack thread, email or notes; get a draft finding or article to check and save. */
export function PasteDraftPage() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"finding" | "article">("finding");
  const draft = useMemo(() => (text.trim() ? (kind === "finding" ? draftFinding(text) : draftArticle(text)) : null), [text, kind]);

  return (
    <div className="page editor">
      <h1>Draft from pasted text</h1>
      <p className="lead">
        Paste a Slack thread, an email, incident notes or a doc. Cairn pulls out a title and the labelled parts (“Root cause:”, “Fix:”), drops chat noise and
        signatures, and opens a draft for you to check. Secrets and personal data are redacted when you save.
      </p>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={kind === "finding"} className={kind === "finding" ? "active" : ""} onClick={() => setKind("finding")}>
          Finding (something happened)
        </button>
        <button role="tab" aria-selected={kind === "article"} className={kind === "article" ? "active" : ""} onClick={() => setKind("article")}>
          Article (how things are)
        </button>
      </div>
      <div className="paste-grid">
        <label>
          Pasted text
          <textarea className="body-input" rows={18} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste here" autoFocus />
        </label>
        <section className="paste-preview" aria-label="Draft">
          <div className="field-label">Draft</div>
          {!draft ? (
            <p className="muted small">The draft appears here as you paste.</p>
          ) : draft.kind === "finding" ? (
            <div className="preview-box">
              <p className="muted small">{draft.type.replace(/_/g, " ")}</p>
              <h3>{draft.title || <span className="muted">No title found</span>}</h3>
              <Markdown text={`**Symptoms.** ${draft.symptoms || "_none found_"}\n\n**Root cause.** ${draft.root_cause || "_not stated: add it before saving_"}\n\n**Fix.** ${draft.fix || "_none found_"}`} />
            </div>
          ) : (
            <div className="preview-box">
              <p className="muted small">{draft.type.replace(/_/g, " ")}</p>
              <h3>{draft.title || <span className="muted">No title found</span>}</h3>
              <Markdown text={draft.body_md} />
            </div>
          )}
        </section>
      </div>
      <Notice>
        Rules, not AI: it won't infer a root cause that isn't written down. For a smarter draft, run the <code>draft-from-paste</code> prompt in Claude with Cairn
        connected.
      </Notice>
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={!draft}
          onClick={() => {
            setPrefill(draft!);
            navigate(`/new/${draft!.kind}`);
          }}
        >
          Open as a draft {kind}
        </button>
      </div>
    </div>
  );
}
