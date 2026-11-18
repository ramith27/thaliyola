import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { useBoot } from "./boot";
import { I } from "./icons";
import { Button, Checkbox, Dialog, ErrorState, Field, IconButton, MenuButton, TextInput, useToast, type MenuItemSpec } from "./kit";

/** The list pages with saved views (server: core/views.ts VIEW_AREAS). */
export type ViewArea = "review" | "inbox" | "security" | "projects";

export interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string>;
  is_default: boolean;
}

/** Same filters, ignoring order and empty values. Pure, for tests. */
export function sameFilters(a: Record<string, string | undefined>, b: Record<string, string | undefined>): boolean {
  const norm = (f: Record<string, string | undefined>) =>
    JSON.stringify(
      Object.entries(f)
        .filter(([, v]) => v)
        .sort(([x], [y]) => x.localeCompare(y)),
    );
  return norm(a) === norm(b);
}

/** The page's filter values from its URL query, for the keys it saves. Pure, for tests. */
export function pickFilters(query: URLSearchParams, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = query.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/** Filter keys whose value is a project or scope slug (Review and Inbox: scope; Security: project). */
const SCOPE_KEYS = ["scope", "project"];

/**
 * A view's filters minus any project or scope the person can no longer read (deleted, renamed, or access taken away),
 * so a saved view never lands on "Couldn't load". Pure, for tests.
 */
export function readableFilters(filters: Record<string, string>, canRead: (slug: string) => boolean): { filters: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(filters)) {
    if (SCOPE_KEYS.includes(k) && !canRead(v)) dropped.push(k);
    else out[k] = v;
  }
  return { filters: out, dropped };
}

export interface SavedViewsProps {
  area: ViewArea;
  /** The filters in use now (only the page's saved keys, non-empty). */
  current: Record<string, string>;
  /** Show these filters: set every saved key (missing ones cleared). */
  apply(filters: Record<string, string>): void;
  /** The filters in use now, in words ("Severity: Critical"), for the Save dialog. */
  summary?: string[];
}

/**
 * "Views ▾": a person's saved filter sets for one list page, kept on the server. Pick one to show it; save the
 * filters in use now under a name; rename, delete or choose the default in Manage views. The default opens when the
 * page is opened without filters in its link.
 */
export function SavedViews({ area, current, apply, summary }: SavedViewsProps) {
  const toast = useToast();
  const boot = useBoot();
  const list = useApi<{ views: SavedView[] }>(`/views?area=${area}`);
  const views = list.data?.views ?? [];
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const active = views.find((v) => sameFilters(v.filters, current));

  // Opened without filters: show the default view, once (Clear all afterwards really clears).
  const startedBare = useRef(Object.keys(current).length === 0);
  const applied = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // A project the person can no longer read is left out (and they're told), so the default never opens on an error.
  const show = (v: SavedView, how: "default" | "picked") => {
    const r = readableFilters(v.filters, (slug) => !!boot.scope(slug));
    if (r.dropped.length)
      toast.warning(how === "default" ? `Opened your default view “${v.name}” without its project` : `Showing “${v.name}” without its project`, {
        description: "It was saved with a project you can't open any more. Save the view again, or choose another default in Manage views.",
      });
    if (how === "picked" || Object.keys(r.filters).length) applyRef.current(r.filters);
  };
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    if (applied.current || !list.data) return;
    applied.current = true;
    const d = list.data.views.find((v) => v.is_default);
    if (startedBare.current && d && Object.keys(d.filters).length) showRef.current(d, "default");
  }, [list.data]);

  const items: MenuItemSpec[] = [
    ...(views.length
      ? [
          { type: "group" as const, label: "Your views" },
          ...views.map((v) => ({
            id: v.id,
            label: v.name,
            hint: v.is_default ? "Opens with this page" : undefined,
            checked: active?.id === v.id,
            onSelect: () => show(v, "picked"),
          })),
          { type: "separator" as const },
        ]
      : []),
    {
      id: "save",
      label: "Save these filters as a view…",
      icon: "plus",
      onSelect: () => setSaving(true),
      disabledReason: active ? `Already saved as “${active.name}”` : list.error ? "Views couldn't be loaded" : undefined,
    },
    ...(views.length ? [{ id: "manage", label: "Manage views…", icon: "settings" as const, onSelect: () => setManaging(true) }] : []),
  ];

  return (
    <>
      <MenuButton label={active ? active.name : "Saved views"} icon="bookmark" items={items} align="end" className="saved-views-button" />
      {saving && (
        <SaveViewDialog
          area={area}
          filters={current}
          summary={summary}
          taken={views.map((v) => v.name.toLowerCase())}
          onClose={() => setSaving(false)}
          onSaved={(v) => {
            setSaving(false);
            list.reload();
            toast.success(`Saved “${v.name}”`, { description: v.is_default ? "This page opens with it." : undefined });
          }}
        />
      )}
      {managing && (
        <ManageViewsDialog
          area={area}
          views={views}
          onStale={() => list.reload()}
          onClose={() => setManaging(false)}
          onDone={(changed) => {
            setManaging(false);
            list.reload();
            if (changed) toast.success("Views updated");
          }}
        />
      )}
    </>
  );
}

function SaveViewDialog({
  area,
  filters,
  summary,
  taken,
  onClose,
  onSaved,
}: {
  area: ViewArea;
  filters: Record<string, string>;
  summary?: string[];
  taken: string[];
  onClose(): void;
  onSaved(v: SavedView): void;
}) {
  const [name, setName] = useState("");
  const [isDefault, setDefault] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setProblem("Give the view a name");
    if (taken.includes(n.toLowerCase())) return setProblem("You already have a view with this name");
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<SavedView>("/views", { method: "POST", body: { area, name: n, filters, is_default: isDefault } }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title="Save as a view"
      description="Only you see your views. Pick one from Saved views to show these filters again."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving">
            Save view
          </Button>
        </>
      }
    >
      <form id={formId} className="saved-views-form" noValidate onSubmit={(e) => void submit(e)}>
        <Field label="Name" error={problem} counter={{ value: name.length, max: 60 }}>
          <TextInput value={name} maxLength={60} placeholder="e.g. Waiting for me in Payments" onChange={(e) => (setName(e.target.value), setProblem(null))} />
        </Field>
        <div className="saved-views-summary">
          <p className="field-label">Filters</p>
          {summary && summary.length ? (
            <ul>
              {summary.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">{Object.keys(filters).length ? "The filters, search and sort in use now." : "No filters: everything, in the default order."}</p>
          )}
        </div>
        <Checkbox label="Open this page with it" description="Used when you open the page without filters in its link." checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />
        {!!error && <ErrorState compact error={error} title="Couldn't save the view" />}
      </form>
    </Dialog>
  );
}

interface Draft {
  id: string;
  name: string;
  deleted: boolean;
}

function ManageViewsDialog({
  area,
  views,
  onClose,
  onDone,
  onStale,
}: {
  area: ViewArea;
  views: SavedView[];
  onClose(): void;
  onDone(changed: boolean): void;
  onStale(): void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => views.map((v) => ({ id: v.id, name: v.name, deleted: false })));
  const [def, setDef] = useState<string>(() => views.find((v) => v.is_default)?.id ?? "");
  // After a reload, drop drafts for views that are gone and add any made elsewhere; edits to the rest are kept.
  useEffect(() => {
    setDrafts((ds) => {
      const ids = new Set(views.map((v) => v.id));
      const known = new Set(ds.map((d) => d.id));
      if (ds.every((d) => ids.has(d.id)) && views.every((v) => known.has(v.id))) return ds;
      return [...ds.filter((d) => ids.has(d.id)), ...views.filter((v) => !known.has(v.id)).map((v) => ({ id: v.id, name: v.name, deleted: false }))];
    });
    setDef((d) => (d && !views.some((v) => v.id === d) ? "" : d));
  }, [views]);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const radio = useId();
  const set = (id: string, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const kept = drafts.filter((d) => !d.deleted);
    if (kept.some((d) => !d.name.trim())) return setProblem("Every view needs a name");
    const names = kept.map((d) => d.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) return setProblem("Two views have the same name");
    setProblem(null);
    const before = new Map(views.map((v) => [v.id, v]));
    const deleted = drafts.filter((d) => d.deleted && before.has(d.id)).map((d) => d.id);
    const rename = kept.filter((d) => before.has(d.id) && d.name.trim() !== before.get(d.id)!.name).map((d) => ({ id: d.id, name: d.name.trim() }));
    const oldDefault = views.find((v) => v.is_default)?.id ?? "";
    const newDefault = kept.some((d) => d.id === def) ? def : "";
    if (!deleted.length && !rename.length && newDefault === oldDefault) return onDone(false);
    setBusy(true);
    setError(null);
    try {
      // One request, applied together on the server: swapping two names works, and a failure changes nothing.
      await api("/views/manage", {
        method: "POST",
        body: { area, rename, delete: deleted, ...(newDefault !== oldDefault ? { default: newDefault || null } : {}) },
      });
      onDone(true);
    } catch (err) {
      setError(err);
      setBusy(false);
      onStale(); // someone may have changed these views elsewhere: reload them so the list matches the server
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="Manage views"
      description="Rename or delete your views, and choose the one this page opens with."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving">
            Save changes
          </Button>
        </>
      }
    >
      <form id={formId} className="saved-views-form" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className="saved-views-list">
          <legend className="sr-only">Your views</legend>
          {drafts.map((d) => (
            <div key={d.id} className="saved-views-row" data-deleted={d.deleted || undefined}>
              {d.deleted ? (
                <>
                  <span className="saved-views-gone">
                    <I name="trash" size={14} /> “{d.name}” will be deleted
                  </span>
                  <Button size="sm" variant="ghost" icon="undo" onClick={() => set(d.id, { deleted: false })}>
                    Keep it
                  </Button>
                </>
              ) : (
                <>
                  <TextInput aria-label={`Name of “${views.find((v) => v.id === d.id)?.name ?? d.name}”`} value={d.name} maxLength={60} onChange={(e) => set(d.id, { name: e.target.value })} />
                  <label className="saved-views-default">
                    <input type="radio" name={radio} checked={def === d.id} onChange={() => setDef(d.id)} />
                    Default
                  </label>
                  <IconButton icon="trash" label={`Delete “${d.name}”`} size="sm" onClick={() => (set(d.id, { deleted: true }), def === d.id && setDef(""))} />
                </>
              )}
            </div>
          ))}
          <label className="saved-views-default saved-views-none">
            <input type="radio" name={radio} checked={def === ""} onChange={() => setDef("")} />
            No default: open the page unfiltered
          </label>
        </fieldset>
        {problem && (
          <p className="field-error" role="alert">
            <I name="alert" size={14} />
            {problem}
          </p>
        )}
        {!!error && <ErrorState compact error={error} title="Nothing was changed" />}
      </form>
    </Dialog>
  );
}
