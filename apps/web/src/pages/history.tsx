import { useState } from "react";
import { api, type WriteResult } from "../api";
import { Diff, ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

interface VersionList {
  kind: "article" | "finding";
  id: string;
  title: string;
  current_version: number;
  can_restore: boolean;
  versions: { version: number; title: string; summary: string; created_at: string; author: string | null; approver: string | null }[];
}

interface Version {
  kind: "article" | "finding";
  version: number;
  title: string;
  content: { body_md?: string; symptoms?: string; root_cause?: string; fix?: string | null; tags?: string[] };
}

/** One text per version, so any two versions can be diffed line by line. */
function asText(v: Version) {
  if (v.kind === "article") return `# ${v.title}\n\n${v.content.body_md ?? ""}`;
  const c = v.content;
  return [`# ${v.title}`, `## Symptoms\n${c.symptoms ?? ""}`, `## Root cause\n${c.root_cause ?? ""}`, `## Fix\n${c.fix ?? ""}`, ...(c.tags?.length ? [`Tags: ${c.tags.join(", ")}`] : [])].join("\n\n");
}

export function HistoryPage({ id }: { id: string }) {
  const list = useApi<VersionList>(`/items/${id}/versions`);
  const [picked, setPicked] = useState<number | null>(null);
  const versions = list.data?.versions ?? [];
  const selected = picked ?? versions[0]?.version ?? null;
  const previous = versions.find((v) => selected !== null && v.version < selected)?.version ?? null;
  const a = useApi<Version>(selected !== null ? `/items/${id}/versions/${selected}` : null);
  const b = useApi<Version>(previous !== null ? `/items/${id}/versions/${previous}` : null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  if (list.error) return <ErrorBox error={list.error} />;
  if (!list.data) return <Loading />;
  const d = list.data;

  async function restore(version: number) {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<WriteResult>(`/items/${id}/restore`, { method: "POST", body: { version } }));
      setPicked(null);
      list.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-wide">
      <p className="breadcrumbs muted small">
        <a href={href(`/${d.kind}/${id}`)}>{d.title}</a> / history
      </p>
      <h1>History</h1>
      <p className="lead">Every published version is kept. Restoring an old version publishes it again as a new version; nothing is lost.</p>
      <ErrorBox error={error} />
      {result &&
        (result.published ? (
          <Notice kind="ok">Restored as a new version.</Notice>
        ) : (
          <Notice kind="info">
            Restore proposed for review. <a href={href(`/review/${result.revision_id}`)}>Open the proposal</a>.
          </Notice>
        ))}
      {!versions.length ? (
        <p className="muted">No published versions yet.</p>
      ) : (
        <div className="versions">
          <ul className="plain version-list" aria-label="Versions">
            {versions.map((v) => (
              <li key={v.version} className={v.version === selected ? "active" : ""} onClick={() => setPicked(v.version)}>
                <div>
                  <span className="v">v{v.version}</span>
                  {v.version === d.current_version && <span className="muted small"> · current</span>}
                </div>
                <div className="small">{v.summary}</div>
                <div className="muted small">
                  {v.author ?? "unknown"} · {formatDate(v.created_at)}
                  {v.approver && v.approver !== v.author ? ` · approved by ${v.approver}` : ""}
                </div>
              </li>
            ))}
          </ul>
          <section>
            <div className="section-head">
              <h2>
                v{selected}
                {previous !== null ? <span className="muted small"> compared with v{previous}</span> : <span className="muted small"> (first version)</span>}
              </h2>
              {selected !== null && selected !== d.current_version && (
                <button className="btn btn-small" disabled={busy} onClick={() => restore(selected)}>
                  {d.can_restore ? `Restore v${selected}` : `Propose restoring v${selected}`}
                </button>
              )}
            </div>
            <ErrorBox error={a.error ?? b.error} />
            {a.data && (previous === null || b.data) ? <Diff before={b.data && previous !== null ? asText(b.data) : ""} after={asText(a.data)} /> : <Loading />}
          </section>
        </div>
      )}
    </div>
  );
}
