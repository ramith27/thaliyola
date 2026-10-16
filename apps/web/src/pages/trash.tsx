import { useState } from "react";
import { api } from "../api";
import { ErrorBox, formatDate, Loading, Notice, TypeBadge } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

interface Trash {
  projects: { slug: string; name: string; deleted_at: string; deleted_by: string | null; items: number }[];
  items: { kind: "article" | "finding"; id: string; title: string; type: string; scope: string; deleted_at: string; deleted_by: string | null }[];
  can_empty: boolean;
}

/** What's been deleted: restore it, or (admins) delete it for good. */
export function TrashPage() {
  const { data, error, reload } = useApi<Trash>("/trash");
  const [actionError, setActionError] = useState<Error | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function act(label: string, fn: () => Promise<unknown>) {
    setActionError(null);
    setDone(null);
    try {
      await fn();
      setDone(label);
      reload();
    } catch (e) {
      setActionError(e as Error);
    }
  }
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="page">
      <h1>Trash</h1>
      <p className="lead">
        Deleted projects, articles and findings. They're hidden everywhere (search, browsing, the graph and agents) until restored.{" "}
        {data.can_empty ? "As an admin you can delete them permanently." : "An admin can delete them permanently."}
      </p>
      <ErrorBox error={actionError} />
      {done && <Notice kind="ok">{done}</Notice>}

      <h2>Projects</h2>
      {!data.projects.length && <p className="muted">No deleted projects.</p>}
      <ul className="plain trash-list">
        {data.projects.map((p) => (
          <li key={p.slug}>
            <div>
              <strong>{p.name}</strong> <span className="muted small">· {p.items} articles and findings</span>
              <div className="muted small">
                Deleted {formatDate(p.deleted_at)}
                {p.deleted_by ? ` by ${p.deleted_by}` : ""}
              </div>
            </div>
            <div className="row-actions">
              <button
                className="btn btn-small"
                onClick={() =>
                  act(`Restored ${p.name}. Reloading…`, async () => {
                    await api(`/trash/projects/${p.slug}/restore`, { method: "POST" });
                    setTimeout(() => window.location.reload(), 500);
                  })
                }
              >
                Restore
              </button>
              {data.can_empty && (
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    const confirm = prompt(`This deletes ${p.name} and its ${p.items} items forever. Type the project's name to confirm:`);
                    if (confirm) void act(`Deleted ${p.name} permanently`, () => api(`/trash/projects/${p.slug}/purge`, { method: "POST", body: { confirm } }));
                  }}
                >
                  Delete permanently
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h2>Articles and findings</h2>
      {!data.items.length && <p className="muted">Nothing here.</p>}
      <ul className="plain trash-list">
        {data.items.map((i) => (
          <li key={i.id}>
            <div>
              <a href={href(`/${i.kind}/${i.id}`)}>{i.title}</a> <TypeBadge type={i.type} /> <span className="muted small">{i.scope}</span>
              <div className="muted small">
                Deleted {formatDate(i.deleted_at)}
                {i.deleted_by ? ` by ${i.deleted_by}` : ""}
              </div>
            </div>
            <div className="row-actions">
              <button className="btn btn-small" onClick={() => act(`Restored “${i.title}”`, () => api(`/trash/items/${i.id}/restore`, { method: "POST" }))}>
                Restore
              </button>
              {data.can_empty && (
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    if (confirm(`Delete “${i.title}” forever, with its history and files?`)) void act(`Deleted “${i.title}” permanently`, () => api(`/trash/items/${i.id}/purge`, { method: "POST" }));
                  }}
                >
                  Delete permanently
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Banner on a deleted article or finding, with Restore. */
export function TrashedNotice({ id, onRestored }: { id: string; onRestored: () => void }) {
  const [error, setError] = useState<Error | null>(null);
  return (
    <Notice kind="warn">
      <span>This is in the trash: nobody else can see it, and search and agents ignore it. </span>
      <button
        className="btn btn-small"
        onClick={async () => {
          setError(null);
          try {
            await api(`/trash/items/${id}/restore`, { method: "POST" });
            onRestored();
          } catch (e) {
            setError(e as Error);
          }
        }}
      >
        Restore
      </button>{" "}
      <a className="small" href={href("/trash")}>
        Open the trash
      </a>
      <ErrorBox error={error} />
    </Notice>
  );
}

/** Delete button for an article or finding (moves it to the trash). */
export function DeleteItemButton({ id, kind, title, scopeLink }: { id: string; kind: string; title: string; scopeLink: string }) {
  return (
    <button
      className="btn btn-danger-outline"
      onClick={async () => {
        if (!confirm(`Move “${title}” to the trash? You can restore it from the trash.`)) return;
        try {
          await api(`/items/${id}/delete`, { method: "POST" });
          window.location.hash = scopeLink.slice(1);
        } catch (e) {
          alert((e as Error).message);
        }
      }}
    >
      Delete
    </button>
  );
}
