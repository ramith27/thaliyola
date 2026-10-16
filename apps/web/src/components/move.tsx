import { useEffect, useState } from "react";
import { api, type ScopeInfo } from "../api";
import { href } from "../router";
import { ErrorBox, Notice } from "./ui";

interface Plan {
  dry_run: boolean;
  moved: number;
  articles: { id: string; title: string; from_path: string; to_path: string; component: string | null }[];
  new_components: string[];
  subfolders: string[];
}

/** Moves a folder from this scope into a project (or another scope), with a preview first. */
export function MoveFolder({ from, folder, scopes, onDone, onCancel }: { from: string; folder: string; scopes: ScopeInfo[]; onDone: () => void; onCancel: () => void }) {
  const targets = scopes.filter((s) => s.slug !== from && (s.can_manage || s.my_role === "owner"));
  const guess = targets.find((s) => folder.toLowerCase().split("/").some((part) => part === s.name.toLowerCase() || part === s.slug));
  const [to, setTo] = useState(guess?.slug ?? targets.find((s) => s.kind === "project")?.slug ?? "");
  const [strip, setStrip] = useState(true);
  const [repos, setRepos] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const toProject = scopes.find((s) => s.slug === to)?.kind === "project";

  useEffect(() => {
    if (!to) return;
    setError(null);
    api<Plan>("/move", { method: "POST", body: { from, to, folder, strip_folder: strip, repo_folders: toProject ? repos : [], dry_run: true } })
      .then(setPlan)
      .catch(setError);
  }, [from, to, folder, strip, repos, toProject]);

  return (
    <div className="move-panel" role="dialog" aria-label={`Move ${folder}`}>
      <h3>Move “{folder}”</h3>
      {!targets.length ? (
        <Notice kind="warn">
          There's nowhere you can move it: you need to own the destination project. <a href={href("/new/project")}>Create a project</a> first.
        </Notice>
      ) : (
        <>
          <div className="row move-row">
            <label>
              Into
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {targets.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                    {s.kind !== "project" ? ` (${s.kind})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} /> Drop “{folder}” from the folder names
            </label>
          </div>
          <p className="small muted">
            Or <a href={href("/new/project")}>create a new project</a> for it first. Items keep their history and links; the destination's members and settings apply from
            then on.
          </p>
          {toProject && !!plan?.subfolders.length && (
            <fieldset className="checks">
              <legend>Which sub-folders are repositories? Each becomes one of the project's repositories and tags its pages.</legend>
              {plan.subfolders.map((f) => (
                <label key={f} className="inline">
                  <input type="checkbox" checked={repos.includes(f)} onChange={(e) => setRepos((r) => (e.target.checked ? [...r, f] : r.filter((x) => x !== f)))} /> {f}
                </label>
              ))}
            </fieldset>
          )}
          <ErrorBox error={error} />
          {plan && (
            <details className="small move-preview" open={plan.articles.length <= 8}>
              <summary>
                {plan.articles.length} article{plan.articles.length === 1 ? "" : "s"} will move
                {plan.new_components.length ? `; new repositories: ${plan.new_components.join(", ")}` : ""}
              </summary>
              <ul>
                {plan.articles.map((a) => (
                  <li key={a.id}>
                    {a.title} <span className="muted">→ {a.to_path || "(top level)"}</span>
                    {a.component && <span className="badge badge-type">{a.component}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={busy || !plan?.articles.length}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api("/move", { method: "POST", body: { from, to, folder, strip_folder: strip, repo_folders: toProject ? repos : [] } });
                  onDone();
                } catch (e) {
                  setError(e as Error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Moving…" : `Move ${plan?.articles.length ?? ""} to ${scopes.find((s) => s.slug === to)?.name ?? ""}`}
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
