import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api, canIn, may, type Folder, type Me, type ScopeInfo } from "../api";
import { useApi } from "../hooks";
import { href } from "../router";
import { Badge, Button, Callout, Checkbox, Dialog, Disclosure, ErrorState, Field, ProjectPicker, Select, SkeletonText, TextInput } from "./kit";
import { labelFrom, plural, REPO_KIND } from "./labels";

interface Plan {
  dry_run: boolean;
  moved: number;
  articles: { id: string; title: string; from_path: string; to_path: string; component: string | null }[];
  new_components: string[];
  subfolders: string[];
}

const NEW = "";
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Moves a folder from this scope into a project (or another scope), with a preview first. Moving needs Review
 * where the entries are and where they go. The folder can also become a new project: Project creators create it
 * directly, team leads and Team managers create it for one of their teams.
 *
 * Dialog content: the caller (browse) renders it inside a Dialog titled "Move “folder”".
 */
export function MoveFolder({ from, folder, scopes, me, onDone, onCancel }: { from: string; folder: string; scopes: ScopeInfo[]; me: Me; onDone: () => void; onCancel: () => void }) {
  const teams = useApi<{ teams: { slug: string; name: string; can_manage: boolean }[] }>("/teams");
  const leadTeams = (teams.data?.teams ?? []).filter((t) => t.can_manage);
  const creator = may(me, "create_projects");
  const canCreate = creator || leadTeams.length > 0;
  const isTarget = (s: ScopeInfo) => s.slug !== from && canIn(s, "review", me);
  const targets = scopes.filter(isTarget);
  const last = folder.split("/").pop() ?? folder;
  const guess = targets.find((s) => folder.toLowerCase().split("/").some((part) => part === s.name.toLowerCase() || part === s.slug));
  const [to, setTo] = useState(guess?.slug ?? targets.find((s) => s.kind === "project")?.slug ?? (creator ? NEW : (targets[0]?.slug ?? NEW)));
  const [name, setName] = useState(last);
  const [short, setShort] = useState("");
  const [team, setTeam] = useState("");
  const [strip, setStrip] = useState(true);
  const [into, setInto] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isNew = to === NEW;
  const newSlug = short || slugify(name);
  const dest = scopes.find((s) => s.slug === to);
  const toProject = isNew || dest?.kind === "project";

  // Team leads and Team managers without Create projects create projects through one of their teams.
  useEffect(() => {
    if (!creator && !team && leadTeams[0]) setTeam(leadTeams[0].slug);
  }, [creator, team, leadTeams]);

  useEffect(() => {
    if (isNew && !newSlug) return;
    if (!isNew && !to) return;
    let stale = false;
    setError(null);
    setPlanning(true);
    api<Plan>("/move", {
      method: "POST",
      body: { from, to: isNew ? newSlug : to, folder, strip_folder: strip, into_folder: into, repo_folders: toProject ? repos : [], dry_run: true, new_project: isNew || undefined },
    })
      .then((p) => !stale && setPlan(p))
      .catch((e) => !stale && setError(e))
      .finally(() => !stale && setPlanning(false));
    return () => {
      stale = true;
    };
  }, [from, to, isNew, newSlug, folder, strip, into, repos, toProject]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let target = to;
      if (isNew) {
        const body = { slug: newSlug, name: name.trim(), team_role: "writer" };
        if (team) await api(`/teams/${team}/projects`, { method: "POST", body });
        else await api("/projects", { method: "POST", body: { slug: newSlug, name: name.trim() } });
        target = newSlug;
      }
      await api("/move", { method: "POST", body: { from, to: target, folder, strip_folder: strip, into_folder: into, repo_folders: toProject ? repos : [] } });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!targets.length && !creator && !teams.data && !teams.error) return <SkeletonText lines={3} />;
  if (!targets.length && !canCreate) {
    return (
      <div className="it-move">
        <Callout tone="warning">
          There's nowhere you can move it: you need Review in the destination (Reviewers, Moderators and Project admins have it), or to be able to start a project (Project creators and team
          leads).
        </Callout>
        <div className="it-move-actions">
          <Button onClick={onCancel}>Close</Button>
        </div>
      </div>
    );
  }

  const count = plan?.articles.length ?? 0;
  const blocked = !plan
    ? "Working out what will move"
    : !count
      ? "There's nothing in this folder to move"
      : isNew && !name.trim()
        ? "Enter a project name"
        : isNew && !newSlug
          ? "Enter a short name"
          : isNew && !creator && !team
            ? "Choose a team"
            : undefined;
  const destName = isNew ? name.trim() || "the new project" : (dest?.name ?? "");

  return (
    <div className="it-move">
      <div className="it-move-grid">
        <Field label="Move into">
          <ProjectPicker searchable value={to} onChange={setTo} scopes={scopes} filter={isTarget} noneLabel={canCreate ? "A new project…" : undefined} />
        </Field>
        <Checkbox label={`Drop “${folder}” from the folder names`} checked={strip} onChange={(e) => setStrip(e.target.checked)} />
      </div>

      {isNew && (
        <div className="it-move-new">
          <div className="it-move-grid">
            <Field label="Project name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Short name" optional hint="Lowercase letters, numbers and dashes.">
              <TextInput value={short} onChange={(e) => setShort(e.target.value)} placeholder={slugify(name) || "project"} pattern="[a-z0-9][a-z0-9-]*" />
            </Field>
          </div>
          <Field label="Team">
            <Select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              options={[...(creator ? [{ value: "", label: "No team (add people later)" }] : []), ...leadTeams.map((t) => ({ value: t.slug, label: t.name }))]}
            />
          </Field>
          <p className="it-move-note">
            {team ? "The team gets Contributor on it and you become its Project admin. " : "You become its Project admin and can add people and teams in its settings. "}
            Repositories and members can be changed in the project's settings afterwards.
          </p>
        </div>
      )}

      {!isNew && (
        <Field label="Into folder" optional hint="Top level, or e.g. Imported/Confluence.">
          <FolderInput scope={to} value={into} onChange={setInto} />
        </Field>
      )}
      {!isNew && (
        <p className="it-move-note">
          Items keep their history and links; the destination's members and settings apply from then on. Or choose “A new project…” to make this folder its own project.
        </p>
      )}

      {toProject && !!plan?.subfolders.length && (
        <fieldset className="it-move-repos">
          <legend>Which sub-folders are repositories? Each becomes one of the project's repositories and tags its pages.</legend>
          {plan.subfolders.map((f) => (
            <Checkbox key={f} label={f} checked={repos.includes(f)} onChange={(e) => setRepos((r) => (e.target.checked ? [...r, f] : r.filter((x) => x !== f)))} />
          ))}
        </fieldset>
      )}

      {!!error && <ErrorState compact error={error} title="Couldn't move the folder" />}

      {plan && (
        <Disclosure
          key={count <= 8 ? "short" : "long"}
          defaultOpen={count <= 8}
          className="it-move-preview"
          summary={
            <>
              {plural(count, "article")} will move
              {plan.new_components.length ? `; new repositories: ${plan.new_components.join(", ")}` : ""}
            </>
          }
        >
          <ul className="it-move-list" aria-busy={planning || undefined}>
            {plan.articles.map((a) => (
              <li key={a.id}>
                <span>{a.title}</span> <span className="it-move-dest">→ {a.to_path || "(top level)"}</span>
                {a.component && <Badge variant="outline">{a.component}</Badge>}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <div className="it-move-actions">
        {isNew && (
          <a className="it-move-full" href={href("/new/project")}>
            Need repositories and a starter pack? Use the full form
          </a>
        )}
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} loadingText="Moving…" disabledReason={blocked} onClick={() => void run()}>
          {isNew ? `Create “${name.trim() || "project"}” and move ${count}` : `Move ${count} to ${destName}`}
        </Button>
      </div>
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

/** A text input with the destination's existing folders as suggestions (a new name creates a folder). */
function FolderInput({ scope, value, onChange, placeholder, ...rest }: { scope: string; value: string; onChange: (v: string) => void; placeholder?: string; id?: string }) {
  const folders = useFolders(scope);
  const listId = useId();
  return (
    <>
      <TextInput {...rest} list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" />
      <datalist id={listId}>
        {folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}

/**
 * Moves one article or finding: into another project (or Team/Library), into a folder there, and/or onto one of
 * the project's repositories. Also re-files an item inside its own project. Renders its own dialog.
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
  // Moving needs Review where it goes (and where it is).
  const isTarget = (s: ScopeInfo) => s.slug === from || canIn(s, "review");
  const targets = scopes.filter(isTarget);
  // The picker marks the option it starts on "(where it is now)", so it starts on `from` and moves to the
  // default destination (the first other project) before the first paint.
  const [to, setTo] = useState(from);
  const [folder, setFolder] = useState(path ?? "");
  const [component, setComponent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dest = scopes.find((s) => s.slug === to);
  const source = scopes.find((s) => s.slug === from);
  const isProject = dest?.kind === "project";
  const staying = to === from;
  const first = useRef(true);

  function choose(next: string) {
    setTo(next);
    setFolder(next === from ? (path ?? "") : "");
    setComponent("");
  }
  useLayoutEffect(() => {
    if (!first.current) return;
    first.current = false;
    const d = targets.find((s) => s.kind === "project" && s.slug !== from);
    if (d) choose(d.slug);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function move() {
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
      setError(e);
      setBusy(false);
    }
  }

  const place = (name: string | undefined, f: string) => [name ?? "", f].filter(Boolean).join(" › ");
  const summaryFrom = place(source?.name ?? from, kind === "article" ? (path ?? "") : "");
  const summaryTo = place(dest?.name ?? to, kind === "article" ? folder.trim() : "");

  return (
    <Dialog
      open
      onClose={onCancel}
      dismissible={!busy}
      size="lg"
      title={`Move this ${kind}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} loadingText="Moving…" onClick={() => void move()}>
            {staying ? "Save location" : `Move to ${dest?.name ?? to}`}
          </Button>
        </>
      }
    >
      <div className="it-move">
        <div className="it-move-grid">
          <Field label="Project or space" className="it-move-wide">
            <ProjectPicker searchable value={to} onChange={choose} scopes={scopes} filter={isTarget} currentLabel="(where it is now)" />
          </Field>
          {kind === "article" && (
            <Field label="Folder" optional hint="Pick an existing folder or type a new one.">
              <FolderInput scope={to} value={folder} onChange={setFolder} placeholder="Top level, or e.g. Runbooks or api/Domains" />
            </Field>
          )}
          {isProject && (
            <Field label="Repository" optional>
              <Select
                value={component}
                onChange={(e) => setComponent(e.target.value)}
                options={[
                  { value: "", label: staying ? "Keep as it is" : "None (the whole project)" },
                  ...(staying ? [{ value: "__none__", label: "None (the whole project)" }] : []),
                  ...dest!.components.map((c) => ({ value: c.slug, label: `${c.slug} (${labelFrom(REPO_KIND, c.kind).toLowerCase()})` })),
                ]}
              />
            </Field>
          )}
        </div>
        <p className="it-move-summary">
          <span className="it-move-from">From {summaryFrom || "(top level)"}</span>
          <span aria-hidden="true"> → </span>
          <span className="sr-only">to </span>
          <strong>{summaryTo || "(top level)"}</strong>
        </p>
        <p className="it-move-note">
          {kind === "finding" ? "Findings have no folders; pick a repository to group it with that codebase. " : ""}
          It keeps its history and links{!staying ? `, and ${dest?.name ?? to}'s members and settings apply from now on` : ""}.
          {isProject && !dest!.components.length && " This project has no repositories yet; add them in its settings."}
        </p>
        {!targets.some((s) => s.slug !== from) && <p className="it-move-note">You can only re-file it here: moving it elsewhere needs Review in the destination.</p>}
        {!!error && <ErrorState compact error={error} title="Couldn't move it" />}
      </div>
    </Dialog>
  );
}
