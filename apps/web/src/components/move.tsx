import { useEffect, useState } from "react";
import { api, type Folder, type Me, type ScopeInfo } from "../api";
import { useApi } from "../hooks";
import { href } from "../router";
import { ErrorBox, Notice } from "./ui";

interface Plan {
  dry_run: boolean;
  moved: number;
  articles: { id: string; title: string; from_path: string; to_path: string; component: string | null }[];
  new_components: string[];
  subfolders: string[];
}

const NEW = "__new__";
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Moves a folder from this scope into a project (or another scope), with a
 * preview first. The folder can also become a new project: admins create it
 * directly, team leads create it for one of their teams.
 */
export function MoveFolder({ from, folder, scopes, me, onDone, onCancel }: { from: string; folder: string; scopes: ScopeInfo[]; me: Me; onDone: () => void; onCancel: () => void }) {
  const teams = useApi<{ teams: { slug: string; name: string; can_manage: boolean }[] }>("/teams");
  const leadTeams = (teams.data?.teams ?? []).filter((t) => t.can_manage);
  const canCreate = me.admin || leadTeams.length > 0;
  const targets = scopes.filter((s) => s.slug !== from && (s.can_manage || s.my_role === "owner"));
  const last = folder.split("/").pop() ?? folder;
  const guess = targets.find((s) => folder.toLowerCase().split("/").some((part) => part === s.name.toLowerCase() || part === s.slug));
  const [to, setTo] = useState(guess?.slug ?? (targets.find((s) => s.kind === "project") ? targets.find((s) => s.kind === "project")!.slug : NEW));
  const [name, setName] = useState(last);
  const [short, setShort] = useState("");
  const [team, setTeam] = useState("");
  const [strip, setStrip] = useState(true);
  const [into, setInto] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const isNew = to === NEW;
  const newSlug = short || slugify(name);
  const toProject = isNew || scopes.find((s) => s.slug === to)?.kind === "project";

  // Team leads (not admins) create projects through one of their teams.
  useEffect(() => {
    if (!me.admin && !team && leadTeams[0]) setTeam(leadTeams[0].slug);
  }, [me.admin, team, leadTeams]);

  useEffect(() => {
    if (!to || (isNew && !newSlug)) return;
    setError(null);
    api<Plan>("/move", {
      method: "POST",
      body: { from, to: isNew ? newSlug : to, folder, strip_folder: strip, into_folder: into, repo_folders: toProject ? repos : [], dry_run: true, new_project: isNew || undefined },
    })
      .then(setPlan)
      .catch(setError);
  }, [from, to, isNew, newSlug, folder, strip, into, repos, toProject]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let dest = to;
      if (isNew) {
        const body = { slug: newSlug, name: name.trim(), team_role: "writer" };
        if (team) await api(`/teams/${team}/projects`, { method: "POST", body });
        else await api("/projects", { method: "POST", body: { slug: newSlug, name: name.trim() } });
        dest = newSlug;
      }
      await api("/move", { method: "POST", body: { from, to: dest, folder, strip_folder: strip, into_folder: into, repo_folders: toProject ? repos : [] } });
      onDone();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  const noWhere = !targets.length && !canCreate;
  return (
    <div className="move-panel" role="dialog" aria-label={`Move ${folder}`}>
      <h3>Move “{folder}”</h3>
      {noWhere ? (
        <Notice kind="warn">There's nowhere you can move it: you need to own the destination project, lead a team, or be an admin.</Notice>
      ) : (
        <>
          <div className="row move-row">
            <label>
              Into
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {canCreate && <option value={NEW}>A new project…</option>}
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
          {isNew && (
            <div className="new-project-fields">
              <div className="row">
                <label>
                  Project name
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
                </label>
                <label>
                  Short name
                  <input value={short} onChange={(e) => setShort(e.target.value)} placeholder={slugify(name) || "project"} pattern="[a-z0-9][a-z0-9-]*" />
                </label>
              </div>
              <label>
                Team
                <select value={team} onChange={(e) => setTeam(e.target.value)}>
                  {me.admin && <option value="">No team (add people later)</option>}
                  {(me.admin ? (teams.data?.teams ?? []) : leadTeams).map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="small muted">
                {team ? "The team gets writer access and you own the project. " : "You can add people and teams in its settings. "}
                Repositories and members can be changed in the project's settings afterwards.
              </p>
            </div>
          )}
          {!isNew && (
            <label className="into-folder">
              Into folder (optional)
              <IntoFolder scope={to} value={into} onChange={setInto} />
            </label>
          )}
          {!isNew && (
            <p className="small muted">
              Items keep their history and links; the destination's members and settings apply from then on. Or choose “A new project…” to make this folder its own project.
            </p>
          )}
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
            <button className="btn btn-primary" disabled={busy || !plan?.articles.length || (isNew && (!name.trim() || !newSlug || (!me.admin && !team)))} onClick={run}>
              {busy ? "Moving…" : isNew ? `Create “${name.trim() || "project"}” and move ${plan?.articles.length ?? ""}` : `Move ${plan?.articles.length ?? ""} to ${scopes.find((s) => s.slug === to)?.name ?? ""}`}
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
            {isNew && (
              <a className="small" href={href("/new/project")}>
                Need repositories and a starter pack? Use the full form
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** All folder paths in a scope's tree, for picking where things go. */
export function useFolders(scope: string | null) {
  const { data } = useApi<{ tree: Folder }>(scope ? `/scopes/${encodeURIComponent(scope)}/tree` : null);
  const out: string[] = [];
  const walk = (f: Folder, prefix: string) => {
    for (const [name, sub] of Object.entries(f.folders)) {
      const p = prefix ? `${prefix}/${name}` : name;
      out.push(p);
      walk(sub, p);
    }
  };
  if (data) walk(data.tree, "");
  return out;
}

/**
 * Moves one article or finding: into another project (or Team/Library), into
 * a folder there, and/or onto one of the project's repositories. Also re-files
 * an item inside its own project.
 */
export function MoveItem({
  id,
  kind,
  from,
  path,
  scopes,
  onDone,
  onCancel,
}: {
  id: string;
  kind: "article" | "finding";
  from: string;
  path?: string;
  scopes: ScopeInfo[];
  onDone: (to: string) => void;
  onCancel: () => void;
}) {
  const targets = scopes.filter((s) => s.slug === from || s.can_manage || s.my_role === "owner");
  const [to, setTo] = useState(targets.find((s) => s.kind === "project" && s.slug !== from)?.slug ?? from);
  const dest = scopes.find((s) => s.slug === to);
  const [folder, setFolder] = useState(to === from ? (path ?? "") : "");
  const [component, setComponent] = useState("");
  const folders = useFolders(kind === "article" ? to : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const isProject = dest?.kind === "project";

  return (
    <div className="move-panel" role="dialog" aria-label={`Move ${kind}`}>
      <h3>Move this {kind}</h3>
      <div className="move-item-fields">
        <label>
          Project or space
          <select
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setFolder(e.target.value === from ? (path ?? "") : "");
              setComponent("");
            }}
          >
            {targets.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
                {s.slug === from ? " (where it is now)" : s.kind !== "project" ? ` (${s.kind})` : ""}
              </option>
            ))}
          </select>
        </label>
        {kind === "article" && (
          <label>
            Folder
            <input list={`folders-${id}`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Top level, or e.g. Runbooks or api/Domains" />
            <datalist id={`folders-${id}`}>
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
        )}
        {isProject && (
          <label>
            Repository
            <select value={component} onChange={(e) => setComponent(e.target.value)}>
              <option value="">{to === from ? "Keep as it is" : "None (the whole project)"}</option>
              {to === from && <option value="__none__">None (the whole project)</option>}
              {dest!.components.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.slug} ({c.kind})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="small muted">
        {kind === "finding" ? "Findings have no folders; pick a repository to group it with that codebase. " : "Pick an existing folder or type a new one. "}
        It keeps its history and links{to !== from ? `, and ${dest?.name}'s members and settings apply from now on` : ""}.
        {isProject && !dest!.components.length && " This project has no repositories yet; add them in its settings."}
      </p>
      <ErrorBox error={error} />
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api("/move", {
                method: "POST",
                body: {
                  from,
                  to,
                  ids: [id],
                  ...(kind === "article" ? { into_folder: folder } : {}),
                  ...(component === "__none__" ? { component: "" } : component ? { component } : to !== from ? { component: "" } : {}),
                },
              });
              onDone(to);
            } catch (e) {
              setError(e as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Moving…" : to === from ? "Save" : `Move to ${dest?.name ?? to}`}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function IntoFolder({ scope, value, onChange }: { scope: string; value: string; onChange: (v: string) => void }) {
  const folders = useFolders(scope);
  return (
    <>
      <input list={`into-${scope}`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Top level, or e.g. Imported/Confluence" />
      <datalist id={`into-${scope}`}>
        {folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}
