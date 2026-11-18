import { useState, type CSSProperties } from "react";
import { api, getToken } from "../api";
import { CopyBlock } from "./connect";
import { Page, PageHeader } from "../components/kit";
import { ErrorBox, formatDate, Loading, Markdown, Notice } from "../components/ui";
import { useApi, useLiveRefresh } from "../hooks";
import { href } from "../router";

type Role = "primary" | "secondary" | "accent" | "background" | "surface" | "text" | "muted" | "border" | "success" | "warning" | "danger" | "info" | "other";

interface Tokens {
  colors?: { name: string; value: string; dark?: string; role?: Role; usage?: string }[];
  typography?: {
    fonts?: { role: string; family: string; weights?: number[]; source?: string }[];
    scale?: { name: string; size: string; line_height?: string; weight?: number; font?: string; usage?: string }[];
  };
  spacing?: { name: string; value: string; usage?: string }[];
  radii?: { name: string; value: string; usage?: string }[];
  shadows?: { name: string; value: string; usage?: string }[];
  breakpoints?: { name: string; value: string; usage?: string }[];
  components?: { name: string; description?: string; path?: string; status?: string }[];
  icons?: string;
  voice?: string;
  accessibility?: string;
}

interface Design {
  scope: string;
  name: string;
  exists: boolean;
  based_on: { slug: string; name: string } | null;
  inherited_from: string[];
  tokens: Tokens;
  own_tokens: Tokens;
  principles: string;
  own_principles: string;
  contrast: { name: string; mode: "light" | "dark"; ratio: number; passes: boolean }[];
  decisions: { id: string; title: string; type: string; status: string; updated_at: string; excerpt: string }[];
  used_by: { slug: string; name: string }[];
  version: number;
  source: string | null;
  updated_at: string | null;
  can_edit: boolean;
}

/** Markdown excerpt as plain text (the server already drops headings). */
const plain = (md: string) =>
  md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const TYPE_TEXT: Record<string, string> = { decision: "Decision", design_doc: "Design doc", design_tokens: "Tokens", ui_component: "Component", ux_pattern: "UX pattern", screen_spec: "Screen" };

/** A size in px for drawing, when it can be read (px or rem/em at 16px). */
const px = (v: string) => {
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "rem" || m[2] === "em" ? n * 16 : n;
};

async function download(slug: string, format: string) {
  const token = getToken();
  const res = await fetch(`/api/scopes/${encodeURIComponent(slug)}/design/export?format=${format}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${slug}-design.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function DesignPage({ slug }: { slug: string }) {
  const { data, error, reload } = useApi<Design>(`/scopes/${encodeURIComponent(slug)}/design`);
  useLiveRefresh(reload);
  const [editing, setEditing] = useState(false);
  const [exportError, setExportError] = useState<Error | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.tokens;
  const empty = !t.colors?.length && !t.typography?.fonts?.length && !t.typography?.scale?.length && !t.spacing?.length && !t.components?.length;
  const own = new Set((data.own_tokens.colors ?? []).map((c) => c.name.toLowerCase()));
  const contrastFor = (name: string, mode: "light" | "dark") => data.contrast.find((c) => c.name === name && c.mode === mode);

  return (
    <Page width="wide">
      <div className="design-page">
        <PageHeader
          title={`${data.name} design system`}
          documentTitle={`${data.name}: design system`}
          icon="sliders"
          scope={data.scope}
          crumbs={[{ label: data.name, href: href(`/${data.scope === "team" || data.scope === "library" ? "scope" : "project"}/${data.scope}`) }, { label: "Design system", muted: true }]}
          meta={
            <span className="muted small">
              {data.based_on ? (
                <>
                  Based on <a href={href(`/scope/${data.based_on.slug}/design`)}>{data.based_on.name}</a>, overriding what differs.{" "}
                </>
              ) : null}
              {data.version ? `Version ${data.version}, updated ${formatDate(data.updated_at)}` : "Not recorded yet"}
              {data.source ? ` · from ${data.source}` : ""}
              {data.used_by.length ? ` · used by ${data.used_by.map((u) => u.name).join(", ")}` : ""}
            </span>
          }
          actions={
            <>
              {(["css", "tailwind", "w3c", "json"] as const).map((f) => (
                <button key={f} className="btn btn-small" disabled={empty} onClick={() => download(data.scope, f).catch(setExportError)}>
                  {f === "css" ? "CSS variables" : f === "tailwind" ? "Tailwind" : f === "w3c" ? "Design tokens" : "JSON"}
                </button>
              ))}
              {data.can_edit && (
                <button className="btn btn-small btn-primary" onClick={() => setEditing((e) => !e)}>
                  {editing ? "Close editor" : "Edit"}
                </button>
              )}
            </>
          }
        />
        <ErrorBox error={exportError} />

        {editing && <DesignEditor design={data} onSaved={() => (setEditing(false), reload())} />}

        {empty && !editing && (
          <Notice>
            No design recorded yet. In Claude Code, open the app's repository and run <code>/mcp__thaliyola__capture-design</code>: it reads the colours, fonts, spacing and components from
            the code. {data.can_edit ? "Or press Edit to base it on the Library's system or paste tokens." : ""}
          </Notice>
        )}

        {!empty && <DriftPanel scope={data.scope} />}

        {!!t.colors?.length && (
          <section>
            <h2>Colour</h2>
            <ul className="plain swatches">
              {t.colors.map((c) => {
                const light = contrastFor(c.name, "light");
                const dark = contrastFor(c.name, "dark");
                return (
                  <li key={c.name} className="swatch card">
                    <div className="swatch-chips">
                      <span className="swatch-chip" style={{ background: c.value } as CSSProperties} title={`Light: ${c.value}`} />
                      {c.dark && <span className="swatch-chip" style={{ background: c.dark } as CSSProperties} title={`Dark: ${c.dark}`} />}
                    </div>
                    <div className="swatch-body">
                      <div>
                        <strong>{c.name}</strong> {c.role && <span className="badge badge-type">{c.role}</span>}
                      </div>
                      {data.based_on && <div className="muted small">{own.has(c.name.toLowerCase()) ? `${data.name} override` : `from ${data.based_on.name}`}</div>}
                      <code className="small">
                        {c.value}
                        {c.dark ? ` · dark ${c.dark}` : ""}
                      </code>
                      {c.usage && <div className="small muted">{c.usage}</div>}
                      {(light || dark) && (
                        <div className="small">
                          {[light, dark].filter(Boolean).map((r) => (
                            <span key={r!.mode} className={`contrast ${r!.passes ? "ok" : "low"}`}>
                              {r!.mode} {r!.ratio}:1 {r!.passes ? "AA" : "below AA"}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {(!!t.typography?.fonts?.length || !!t.typography?.scale?.length) && (
          <section>
            <h2>Typography</h2>
            {(t.typography?.fonts ?? []).map((f) => (
              <div key={f.role} className="font-row">
                <span className="badge badge-type">{f.role}</span>
                <span className="font-sample" style={{ fontFamily: f.family }}>
                  The quick brown fox jumps over the lazy dog
                </span>
                <code className="small">
                  {f.family}
                  {f.weights?.length ? ` · ${f.weights.join(", ")}` : ""}
                </code>
              </div>
            ))}
            {!!t.typography?.scale?.length && (
              <div className="table-wrap">
                <table className="table type-scale">
                  <tbody>
                    {t.typography.scale.map((s) => {
                      const size = px(s.size);
                      return (
                        <tr key={s.name}>
                          <td>
                            <strong>{s.name}</strong>
                            <div className="small muted">
                              {s.size}
                              {s.line_height ? ` / ${s.line_height}` : ""}
                              {s.weight ? ` · ${s.weight}` : ""}
                            </div>
                          </td>
                          <td>
                            <span
                              className="type-sample"
                              style={{
                                fontSize: size ? `${Math.min(size, 44)}px` : undefined,
                                lineHeight: s.line_height,
                                fontWeight: s.weight,
                                fontFamily: (t.typography?.fonts ?? []).find((f) => f.role === (s.font ?? "body"))?.family,
                              }}
                            >
                              {s.usage || "Design that every session can use"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {(!!t.spacing?.length || !!t.radii?.length || !!t.shadows?.length) && (
          <section className="grid-2">
            {!!t.spacing?.length && (
              <div>
                <h2>Spacing</h2>
                <ul className="plain scale-list">
                  {t.spacing.map((s) => (
                    <li key={s.name}>
                      <span className="scale-name">{s.name}</span>
                      <span className="space-bar" style={{ width: `${Math.min(px(s.value) ?? 0, 240)}px` }} />
                      <code className="small">{s.value}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              {!!t.radii?.length && (
                <>
                  <h2>Corners</h2>
                  <ul className="plain shape-list">
                    {t.radii.map((r) => (
                      <li key={r.name}>
                        <span className="shape" style={{ borderRadius: r.value }} />
                        <span className="small">
                          {r.name} <code>{r.value}</code>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!!t.shadows?.length && (
                <>
                  <h2>Shadows</h2>
                  <ul className="plain shape-list">
                    {t.shadows.map((s) => (
                      <li key={s.name}>
                        <span className="shape" style={{ boxShadow: s.value }} />
                        <span className="small">{s.name}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </section>
        )}

        {!!t.breakpoints?.length && (
          <section>
            <h2>Breakpoints</h2>
            <p className="small">
              {t.breakpoints.map((b) => (
                <span key={b.name} className="chip-static">
                  {b.name} {b.value}
                </span>
              ))}
            </p>
          </section>
        )}

        {!!t.components?.length && (
          <section>
            <h2>Components</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>What it's for</th>
                    <th>Where</th>
                  </tr>
                </thead>
                <tbody>
                  {t.components.map((c) => (
                    <tr key={c.name}>
                      <td>
                        <strong>{c.name}</strong> {c.status && c.status !== "stable" && <span className="badge badge-type">{c.status}</span>}
                      </td>
                      <td className="small">{c.description}</td>
                      <td className="small">{c.path && <code>{c.path}</code>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {(data.principles || t.icons || t.voice || t.accessibility) && (
          <section className="design-rules">
            <h2>Rules</h2>
            {data.principles && <Markdown text={data.principles} />}
            <dl className="facts">
              {t.icons && (
                <>
                  <dt>Icons</dt>
                  <dd>{t.icons}</dd>
                </>
              )}
              {t.voice && (
                <>
                  <dt>Voice</dt>
                  <dd>{t.voice}</dd>
                </>
              )}
              {t.accessibility && (
                <>
                  <dt>Accessibility</dt>
                  <dd>{t.accessibility}</dd>
                </>
              )}
            </dl>
          </section>
        )}

        <Decisions design={data} onChange={reload} />
      </div>
    </Page>
  );
}

function Decisions({ design, onChange }: { design: Design; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", context: "", options: "", choice: "", consequences: "" });
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const isProject = design.scope !== "team" && design.scope !== "library";
  return (
    <section>
      <div className="section-head">
        <h2>Design decisions and specs</h2>
        <button className="btn btn-small" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Record a decision"}
        </button>
      </div>
      {notice && <Notice kind="ok">{notice}</Notice>}
      {open && (
        <form
          className="card decision-form editor"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const r = await api<{ published?: boolean }>(`/scopes/${design.scope}/design/decisions`, { method: "POST", body: { ...form, options: form.options || undefined, consequences: form.consequences || undefined } });
              setNotice(r.published ? "Recorded." : "Proposed: an owner reviews it before it's published.");
              setOpen(false);
              setForm({ title: "", context: "", options: "", choice: "", consequences: "" });
              onChange();
            } catch (err) {
              setError(err as Error);
            }
          }}
        >
          <label>
            Decision
            <input value={form.title} onChange={set("title")} required placeholder="e.g. Violet primary to tell Shop apart from Admin" />
          </label>
          <label>
            Context
            <textarea rows={2} value={form.context} onChange={set("context")} required placeholder="What prompted it" />
          </label>
          <label>
            Options considered <span className="muted small">(optional)</span>
            <textarea rows={2} value={form.options} onChange={set("options")} />
          </label>
          <label>
            Choice
            <textarea rows={2} value={form.choice} onChange={set("choice")} required />
          </label>
          <label>
            Consequences <span className="muted small">(optional)</span>
            <textarea rows={2} value={form.consequences} onChange={set("consequences")} />
          </label>
          <ErrorBox error={error} />
          <div className="actions">
            <button className="btn btn-primary">Save decision</button>
          </div>
        </form>
      )}
      {!design.decisions.length ? (
        <p className="muted small">
          No design decisions yet. Decisions tagged <code>design</code> and component, pattern, screen and token pages {isProject ? "in this project" : "here"} show up here.
        </p>
      ) : (
        <ul className="plain decision-list">
          {design.decisions.map((d) => (
            <li key={d.id}>
              <span className="badge badge-type">{TYPE_TEXT[d.type] ?? d.type}</span> <a href={href(`/article/${d.id}`)}>{d.title}</a>
              {d.status !== "published" && <span className="badge badge-pending">{d.status}</span>}
              <div className="small muted">{plain(d.excerpt)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DesignEditor({ design, onSaved }: { design: Design; onSaved: () => void }) {
  const systems = useApi<{ systems: { slug: string; name: string; kind: string }[] }>("/design-systems");
  const [json, setJson] = useState(JSON.stringify(design.own_tokens, null, 2));
  const [principles, setPrinciples] = useState(design.own_principles);
  const [basedOn, setBasedOn] = useState(design.based_on?.slug ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const versions = useApi<{ versions: { version: number; note: string | null; updated_at: string; by: string; colors: number }[] }>(`/scopes/${design.scope}/design/versions`);
  const example = `{
  "colors": [{ "name": "primary", "value": "#2a78d6", "dark": "#3987e5", "role": "primary", "usage": "Buttons and links" }],
  "typography": { "fonts": [{ "role": "body", "family": "Inter, system-ui, sans-serif", "weights": [400, 600] }],
                  "scale": [{ "name": "body", "size": "1rem", "line_height": "1.5" }] },
  "spacing": [{ "name": "4", "value": "16px" }], "radii": [{ "name": "md", "value": "8px" }],
  "components": [{ "name": "Button", "description": "Primary and secondary actions", "path": "src/ui/Button.tsx" }]
}`;
  return (
    <section className="card design-editor editor">
      <h2>Edit the design system</h2>
      <label>
        Based on
        <select value={basedOn} onChange={(e) => setBasedOn(e.target.value)}>
          <option value="">Nothing (standalone)</option>
          {(systems.data?.systems ?? [])
            .filter((s) => s.slug !== design.scope)
            .map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Tokens (JSON). {basedOn ? "List only what differs from the base: entries replace the base's by name." : ""}
        <textarea className="body-input" rows={14} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      </label>
      <details className="small">
        <summary>Example</summary>
        <CopyBlock text={example} />
      </details>
      <label>
        Rules (Markdown)
        <textarea className="body-input" rows={5} value={principles} onChange={(e) => setPrinciples(e.target.value)} placeholder="- Primary for the one main action on a screen" />
      </label>
      <label>
        Note <span className="muted small">(optional, kept with this version)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button
          className="btn btn-primary"
          onClick={async () => {
            setError(null);
            let tokens: unknown;
            try {
              tokens = JSON.parse(json || "{}");
            } catch {
              setError(new Error("The tokens aren't valid JSON."));
              return;
            }
            try {
              await api(`/scopes/${design.scope}/design`, { method: "PUT", body: { tokens, replace: true, principles, based_on: basedOn || null, note: note || undefined } });
              onSaved();
            } catch (err) {
              setError(err as Error);
            }
          }}
        >
          Save
        </button>
      </div>
      {!!versions.data?.versions.length && (
        <details className="small">
          <summary>History ({versions.data.versions.length} versions)</summary>
          <ul className="plain version-list">
            {versions.data.versions.map((v) => (
              <li key={v.version}>
                Version {v.version} · {formatDate(v.updated_at)} · {v.by}
                {v.note ? ` · ${v.note}` : ""}
                {v.version !== design.version && (
                  <button
                    className="link-btn small"
                    onClick={() => api(`/scopes/${design.scope}/design/restore`, { method: "POST", body: { version: v.version } }).then(onSaved, setError)}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

interface Drift {
  changed: { kind: string; name: string; stored: string; code: string; mode?: "dark" }[];
  missing_in_code: { kind: string; name: string; stored: string }[];
  new_in_code: { kind: string; name: string; code: string }[];
  hardcoded: { value: string; file: string; line?: number; count?: number; suggestion: string; nearest: { name: string; distance: number } | null }[];
  counts: { changed: number; missing_in_code: number; new_in_code: number; hardcoded: number; off_palette: number };
  differences: number;
  source: string;
  checked_at: string;
  checked_by: string | null;
}

/** The latest code-vs-design check (from CI or an agent's check-design), or how to run one. */
function DriftPanel({ scope }: { scope: string }) {
  const { data, reload } = useApi<{ drift: Drift | null }>(`/scopes/${encodeURIComponent(scope)}/design/drift`);
  useLiveRefresh(reload);
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const d = data.drift;
  if (!d)
    return (
      <section className="drift-panel">
        <h2>Code vs design</h2>
        <p className="muted small">
          Not checked yet. Run <code>/mcp__thaliyola__check-design</code> in the app's repository, or add the design check to CI (<a href={href("/guide")}>Guide</a> → Design systems).
        </p>
      </section>
    );
  const c = d.counts;
  return (
    <section className="drift-panel">
      <h2>Code vs design</h2>
      {d.differences === 0 ? (
        <Notice kind="ok">The code matched this design system when it was last checked, {formatDate(d.checked_at)}.</Notice>
      ) : (
        <Notice kind="warn">
          At the last check ({formatDate(d.checked_at)}{d.checked_by ? ` by ${d.checked_by}` : ""}): <strong>{c.changed}</strong> values differ from the code, <strong>{c.hardcoded}</strong> hard-coded colours
          ({c.off_palette} off the palette), {c.missing_in_code} recorded but not in the code, {c.new_in_code} in the code but not recorded.{" "}
          <button className="btn btn-small btn-ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide details" : "Show details"}
          </button>
        </Notice>
      )}
      {open && d.differences > 0 && (
        <div className="drift-details small">
          {d.changed.length > 0 && (
            <>
              <h3>Different in the code</h3>
              <ul className="plain">
                {d.changed.map((x) => (
                  <li key={`${x.kind}-${x.name}-${x.mode ?? ""}`}>
                    {x.kind} <strong>{x.name}</strong>
                    {x.mode ? " (dark)" : ""}: recorded <code>{x.stored}</code>, code <code>{x.code}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.hardcoded.length > 0 && (
            <>
              <h3>Hard-coded colours</h3>
              <ul className="plain">
                {d.hardcoded.slice(0, 50).map((h) => (
                  <li key={`${h.file}-${h.value}`}>
                    <code>
                      {h.file}
                      {h.line ? `:${h.line}` : ""}
                    </code>{" "}
                    <code>{h.value}</code>
                    {h.count && h.count > 1 ? ` ×${h.count}` : ""} → {h.suggestion}
                  </li>
                ))}
                {d.hardcoded.length > 50 && <li className="muted">and {d.hardcoded.length - 50} more</li>}
              </ul>
            </>
          )}
          {(d.new_in_code.length > 0 || d.missing_in_code.length > 0) && (
            <>
              <h3>Not on both sides</h3>
              <ul className="plain">
                {d.new_in_code.slice(0, 30).map((x) => (
                  <li key={`n-${x.kind}-${x.name}`}>
                    In the code only: {x.kind} <code>{x.name}</code> <code>{x.code}</code>
                  </li>
                ))}
                {d.missing_in_code.slice(0, 30).map((x) => (
                  <li key={`m-${x.kind}-${x.name}`}>
                    Recorded only: {x.kind} <strong>{x.name}</strong> <code>{x.stored}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.source && <p className="muted">From {d.source}</p>}
        </div>
      )}
    </section>
  );
}
