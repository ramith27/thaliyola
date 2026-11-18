import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { I } from "../components/icons";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Checkbox,
  ChoiceCards,
  DataTable,
  Disclosure,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  ListRow,
  MetaLine,
  RelativeTime,
  RowList,
  SearchInput,
  Section,
  Select,
  SkeletonRows,
  StatusBadge,
  Textarea,
  useConfirm,
  useToast,
  type Column,
} from "../components/kit";
import { componentRef, lineageChoiceGroups, lineageText, type LineageChoice, type LineageKind } from "../components/lineage";
import { CONNECTION_KIND, labelFrom, plural, typeLabel, type Tone } from "../components/labels";
import { useApi, useLiveRefresh, useMediaQuery } from "../hooks";
import { href } from "../router";

/**
 * A project's Data view (project page › Data): its database connections, their schemas and tables, and one table at a
 * time with its columns, the data dictionary (what columns mean, which hold personal data), its schema history and the
 * entries that link to it; and its HTTP APIs, one at a time with the endpoints of their OpenAPI spec and their history.
 * Readers see everything; people who may propose describe columns; only Project admins say a column no longer holds
 * personal data.
 */

interface TableSummary {
  id: string;
  key: string;
  name: string;
  kind: "table" | "view";
  columns: number;
  rows: number | null;
  removed_at: string | null;
  article_id: string | null;
  pii: number;
  described: number;
}
interface ConnectionData {
  id: string;
  name: string;
  kind: string;
  label: string;
  health: "ok" | "failing" | "untested";
  enabled: boolean;
  synced_at: string | null;
  queries: boolean;
  sync: { tables: number; views: number; truncated: boolean } | null;
  schemas: { name: string; tables: TableSummary[] }[];
}
interface ApiSummary {
  id: string;
  name: string;
  kind: string;
  health: "ok" | "failing" | "untested";
  enabled: boolean;
  synced_at: string | null;
  calls: boolean;
  endpoints: number;
  removed: number;
  article_id: string | null;
  title: string | null;
  version: string | null;
}
interface ProjectData {
  project: string;
  can_describe: boolean;
  can_query: boolean;
  can_manage: boolean;
  apis: ApiSummary[];
  connections: ConnectionData[];
}
interface Endpoint {
  id: string;
  key: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  operation_id?: string;
  tags: string[];
  deprecated?: boolean;
  params: { name: string; in: string; required: boolean; type: string; description?: string }[];
  body: { content_type: string; type: string; required: boolean } | null;
  responses: { status: string; description?: string; type?: string }[];
  first_seen: string;
  removed_at: string | null;
}
interface ApiDetail {
  id: string;
  project: string;
  connection: { id: string; name: string; label: string; health: string; enabled: boolean; synced_at: string | null; calls: boolean };
  title: string | null;
  version: string | null;
  format: string | null;
  /** The spec was taken off the connection: the endpoints are the last spec's, all marked removed. */
  spec_removed: boolean;
  endpoints: Endpoint[];
  changes: { id: string; key: string; change: string; detail: Record<string, unknown>; at: string }[];
  article: { id: string; title: string; status: string; version: number } | null;
  can_call: boolean;
}
interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  pk: boolean;
  fk: string | null;
  comment: string | null;
  description: string | null;
  pii: boolean;
  noted_by: string | null;
  noted_at: string | null;
}
/** A repository that reads or writes a table; `can_remove` for people who may propose in its project. */
interface Lineage {
  kind: LineageKind;
  component: string;
  project: string;
  can_remove: boolean;
}
interface TableDetail {
  id: string;
  key: string;
  kind: "table" | "view";
  schema: string;
  name: string;
  comment: string | null;
  rows: number | null;
  first_seen: string;
  last_seen: string;
  removed_at: string | null;
  project: string;
  connection: { id: string; name: string; kind: string; label: string; health: string; queries: boolean };
  columns: TableColumn[];
  changes: { id: string; change: string; detail: { column?: string; from?: string; to?: string; type?: string; kind?: string }; at: string }[];
  article: { id: string; title: string; status: string; version: number; updated_at: string } | null;
  linked: { kind: "article" | "finding"; id: string; title: string; type: string; status: string; scope: string; via: string }[];
  lineage: Lineage[];
  /** Repositories the viewer may say read or write it (projects where they may propose). */
  lineage_choices?: LineageChoice[];
  can_describe: boolean;
  can_unflag_pii: boolean;
}

const fmt = new Intl.NumberFormat();
const rowsText = (n: number | null) => (n === null ? null : `about ${fmt.format(n)} ${n === 1 ? "row" : "rows"}`);

/** One line for a schema change. */
function changeText(c: TableDetail["changes"][number]): string {
  const d = c.detail;
  switch (c.change) {
    case "added":
      return `${d.kind === "view" ? "View" : "Table"} appeared`;
    case "removed":
      return `${d.kind === "view" ? "View" : "Table"} removed`;
    case "column_added":
      return `Column ${d.column} added (${d.type})`;
    case "column_removed":
      return `Column ${d.column} removed`;
    case "type_changed":
      return `Column ${d.column}: ${d.from} → ${d.to}`;
    default:
      return c.change;
  }
}

const METHOD_TONE: Record<string, Tone> = { GET: "accent", HEAD: "neutral", POST: "success", PUT: "warning", PATCH: "warning", DELETE: "danger" };

/** One line for an endpoint change. */
function endpointChangeText(c: ApiDetail["changes"][number]): string {
  const d = c.detail as {
    kind?: string;
    returned?: boolean;
    spec_removed?: boolean;
    now_required?: string[];
    params_added?: string[];
    params_removed?: string[];
    type_changed?: { param: string; from: string; to: string }[];
    body?: { to: string | null };
    responses_added?: string[];
    responses_removed?: string[];
    responses_changed?: { status: string; from: string | null; to: string | null }[];
    deprecated?: boolean;
  };
  if (c.change === "added") return d.returned ? "Back in the spec" : "New endpoint";
  if (c.change === "removed") return d.spec_removed ? "The spec was removed from the connection" : "Removed from the spec";
  const parts: string[] = [];
  if (d.now_required?.length) parts.push(`now requires ${d.now_required.join(", ")}`);
  else if (d.params_added?.length) parts.push(`new parameters ${d.params_added.join(", ")}`);
  if (d.params_removed?.length) parts.push(`${d.params_removed.join(", ")} removed`);
  for (const t of d.type_changed ?? []) parts.push(`${t.param}: ${t.from} → ${t.to}`);
  if (d.body) parts.push(d.body.to ? "request body changed" : "request body removed");
  if (d.responses_removed?.length) parts.push(`responses ${d.responses_removed.join(", ")} removed`);
  if (d.responses_added?.length) parts.push(`new responses ${d.responses_added.join(", ")}`);
  for (const r of d.responses_changed ?? []) parts.push(r.to === null ? `${r.status} response no longer described` : r.from === null ? `${r.status} response now described` : `${r.status} response: ${r.from} → ${r.to}`);
  if (d.deprecated !== undefined) parts.push(d.deprecated ? "deprecated" : "no longer deprecated");
  const text = parts.join("; ") || "changed";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function DataView({
  slug,
  table,
  api: apiId,
  onTable,
  onApi,
}: {
  slug: string;
  table?: string;
  api?: string;
  onTable(id: string | undefined): void;
  onApi(id: string | undefined): void;
}) {
  const result = useApi<ProjectData>(`/projects/${encodeURIComponent(slug)}/data`);
  useLiveRefresh(result.reload);
  const phone = useMediaQuery("(max-width: 900px)");
  const [q, setQ] = useState("");
  const data = result.data;

  // Open the first table (or API) on wide screens, so the page isn't half empty.
  const first = data?.connections.flatMap((c) => c.schemas.flatMap((s) => s.tables))[0]?.id;
  const selectedApi = apiId ?? (!table && !phone && !first ? data?.apis[0]?.id : undefined);
  const selected = selectedApi ? undefined : (table ?? (phone ? undefined : first));
  const open = !!(selected || selectedApi);

  return (
    <AsyncBlock result={result} label="Loading the project's data" skeleton={<SkeletonRows count={6} density="compact" />} errorTitle="Couldn't load the project's data">
      {(d) =>
        !d.connections.length && !d.apis.length ? (
          <EmptyState
            icon="database"
            title="No databases or APIs connected"
            description="Connect a database or an API in project settings › Connections, and Thaliyola brings in its tables (one article each) or its endpoints (one API contract)."
            primary={
              d.can_manage ? (
                <Button href={href(`/scope/${slug}/settings`, { tab: "connections" })} icon="plug">
                  Open Connections
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="cn-data" data-detail={phone && open ? "open" : undefined}>
            {(!phone || !open) && <TableList data={d} slug={slug} q={q} setQ={setQ} selected={selected} selectedApi={selectedApi} onTable={onTable} onApi={onApi} />}
            {selectedApi ? (
              <ApiDetailPane key={selectedApi} id={selectedApi} phone={phone} onBack={() => onApi(undefined)} />
            ) : selected ? (
              <TableDetailPane key={selected} id={selected} phone={phone} onBack={() => onTable(undefined)} onChanged={result.reload} />
            ) : !phone ? (
              <EmptyState icon="table" title="Nothing synced yet" description="Tables appear here after the first sync. Project admins can sync now from project settings › Connections." />
            ) : null}
          </div>
        )
      }
    </AsyncBlock>
  );
}

function TableList({
  data,
  slug,
  q,
  setQ,
  selected,
  selectedApi,
  onTable,
  onApi,
}: {
  data: ProjectData;
  slug: string;
  q: string;
  setQ(v: string): void;
  selected?: string;
  selectedApi?: string;
  onTable(id: string): void;
  onApi(id: string): void;
}) {
  const needle = q.trim().toLowerCase();
  const total = data.connections.reduce((n, c) => n + c.schemas.reduce((m, s) => m + s.tables.length, 0), 0);
  const match = (t: TableSummary) => !needle || t.key.toLowerCase().includes(needle);
  const shown = data.connections.reduce((n, c) => n + c.schemas.reduce((m, s) => m + s.tables.filter(match).length, 0), 0);
  return (
    <nav className="cn-data-list" aria-label="Tables">
      {total > 8 && <SearchInput value={q} onChange={setQ} label="Find a table" placeholder="Find a table" resultCount={needle ? shown : undefined} />}
      {data.connections.map((c) => (
        <section key={c.id} className="cn-data-conn" aria-label={c.name}>
          <header className="cn-data-conn-head">
            <span className="cn-data-conn-name">
              <I name="database" size={16} /> {c.name}
            </span>
            <StatusBadge domain="connection" value={c.enabled ? c.health : "paused"} />
            <MetaLine
              items={[
                labelFrom(CONNECTION_KIND, c.kind),
                c.synced_at ? <RelativeTime key="s" prefix="Synced " date={c.synced_at} /> : "Not synced yet",
                c.queries ? "Queries allowed" : null,
              ]}
            />
            {c.sync?.truncated && <span className="cn-data-note">Only the first tables are synced. A Project admin can narrow the schemas.</span>}
          </header>
          {c.schemas.length === 0 && <p className="cn-data-note">{c.synced_at ? "No tables found." : "Tables show here after the first sync."}</p>}
          {c.schemas.map((s) => {
            const tables = s.tables.filter(match);
            if (!tables.length) return null;
            return (
              <div key={s.name} className="cn-data-schema">
                <h3 className="cn-data-schema-name">{s.name}</h3>
                <ul className="cn-data-tables">
                  {tables.map((t) => (
                    <li key={t.id}>
                      <a
                        className="cn-data-table"
                        href={href(`/project/${slug}`, { tab: "data", table: t.id })}
                        aria-current={selected === t.id ? "true" : undefined}
                        data-removed={t.removed_at ? true : undefined}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          onTable(t.id);
                        }}
                      >
                        <I name={t.kind === "view" ? "eye" : "table"} size={14} />
                        <span className="cn-data-table-name">{t.name}</span>
                        {t.pii > 0 && (
                          <span className="cn-data-pii" title={`${plural(t.pii, "column")} with personal data`}>
                            <I name="lock" size={12} />
                            <span className="sr-only">{plural(t.pii, "column")} with personal data</span>
                          </span>
                        )}
                        {t.removed_at && <span className="cn-data-gone">removed</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      ))}
      {needle && !shown && <p className="cn-data-note">No table matches “{q.trim()}”.</p>}
      {data.apis.length > 0 && (
        <section className="cn-data-conn" aria-label="APIs">
          <header className="cn-data-conn-head">
            <span className="cn-data-conn-name">
              <I name="globe" size={16} /> APIs
            </span>
          </header>
          <ul className="cn-data-tables">
            {data.apis.map((a) => (
              <li key={a.id}>
                <a
                  className="cn-data-table cn-data-api"
                  href={href(`/project/${slug}`, { tab: "data", api: a.id })}
                  aria-current={selectedApi === a.id ? "true" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                    e.preventDefault();
                    onApi(a.id);
                  }}
                >
                  <span className="cn-data-table-name">{a.name}</span>
                  <span className="cn-data-count">{a.synced_at ? plural(a.endpoints, "endpoint") : "not synced"}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}

function TableDetailPane({ id, phone, onBack, onChanged }: { id: string; phone: boolean; onBack(): void; onChanged(): void }) {
  const result = useApi<TableDetail>(`/tables/${id}`);
  const [editing, setEditing] = useState<TableColumn | null>(null);
  return (
    <div className="cn-data-detail">
      {phone && (
        <Button variant="ghost" size="sm" icon="chevron-left" onClick={onBack}>
          All tables
        </Button>
      )}
      <AsyncBlock result={result} label="Loading the table" skeleton={<SkeletonRows count={6} density="compact" />} errorTitle="Couldn't load this table">
        {(t) => (
          <>
            <header className="cn-data-head">
              <h2 className="cn-data-title">
                <I name={t.kind === "view" ? "eye" : "table"} size={20} />
                <span className="cn-data-key">{t.key}</span>
              </h2>
              <MetaLine
                items={[
                  t.kind === "view" ? "View" : "Table",
                  `in ${t.connection.name} (${t.connection.label})`,
                  rowsText(t.rows),
                  <RelativeTime key="seen" prefix="Last synced " date={t.last_seen} />,
                ]}
              />
              {t.comment && <p className="cn-data-comment">{t.comment}</p>}
              {t.article && (
                <div className="cn-data-actions">
                  <Button size="sm" icon="doc" href={href(`/article/${t.article.id}`)}>
                    Open its article
                  </Button>
                  <span className="cn-data-note">Grain, joins, gotchas and example queries live there.</span>
                </div>
              )}
            </header>
            {t.removed_at && (
              <Callout tone="warning" title="This table is gone">
                The sync <RelativeTime date={t.removed_at} /> didn't find it. Its columns are shown as last seen.
              </Callout>
            )}
            <ColumnsTable table={t} onEdit={setEditing} />
            <Section title="Schema history" level={3} count={t.changes.length}>
              {t.changes.length ? (
                <ul className="cn-data-history">
                  {t.changes.map((c) => (
                    <li key={c.id}>
                      <StatusBadge domain="schema_change" value={c.change} />
                      <span className="cn-data-history-text">{changeText(c)}</span>
                      <RelativeTime date={c.at} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cn-data-note">
                  No changes since it was first synced <RelativeTime date={t.first_seen} />.
                </p>
              )}
            </Section>
            <LineageSection table={t} onChanged={result.reload} />
            {t.linked.length > 0 && (
              <Section title="Linked entries" level={3} count={t.linked.length}>
                <RowList label={`Entries linked to ${t.key}`} density="compact">
                  {t.linked.map((l) => (
                    <ListRow
                      key={l.id}
                      leading={<I name={l.kind === "finding" ? "bolt" : "doc"} size={16} />}
                      title={l.title}
                      href={href(`/${l.kind}/${l.id}`)}
                      badges={<StatusBadge domain="item" value={l.status} />}
                      meta={<MetaLine items={[typeLabel(l.type), l.scope, l.via === "tagged" ? "Mentions this table" : null]} />}
                    />
                  ))}
                </RowList>
              </Section>
            )}
            {editing && (
              <ColumnNoteDialog
                table={t}
                column={editing}
                onClose={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  result.reload();
                  onChanged();
                }}
              />
            )}
          </>
        )}
      </AsyncBlock>
    </div>
  );
}

/**
 * Lineage: the repositories that read or write the table. People who may propose in a repository's project add and
 * remove its links; schema changes to the table then reach that project as impact notices.
 */
function LineageSection({ table, onChanged }: { table: TableDetail; onChanged(): void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const choices = table.lineage_choices ?? [];
  const article = table.article;
  if (!article) return null;
  const canAdd = choices.length > 0;
  if (!table.lineage.length && !canAdd) return null;

  async function remove(l: Lineage) {
    const ok = await confirm({
      title: `Remove ${l.component} from this table's lineage?`,
      body: `${l.component} (${l.project}) will no longer be listed as ${l.kind === "reads" ? "reading" : "writing"} ${table.key}, and its project stops hearing about schema changes to it.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const key = `${l.kind}:${l.project}/${l.component}`;
    setRemoving(key);
    try {
      await api("/links", { method: "DELETE", body: { from: componentRef(l.project, l.component), to: article!.id, relation: l.kind } });
      toast.success(`Removed ${l.component}`);
      onChanged();
    } catch (e) {
      toast.error(e, { title: "Couldn't remove it" });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Section
      title="Used by"
      level={3}
      count={table.lineage.length}
      description="Repositories that read or write this table. Schema changes reach their projects as impact notices."
      actions={
        canAdd ? (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add a repository
          </Button>
        ) : undefined
      }
    >
      {table.lineage.length ? (
        <RowList label={`Repositories that read or write ${table.key}`} density="compact">
          {table.lineage.map((l) => {
            const key = `${l.kind}:${l.project}/${l.component}`;
            return (
              <ListRow
                key={key}
                leading={<I name="git-branch" size={16} />}
                title={l.component}
                href={href(`/project/${l.project}`, { component: l.component })}
                badges={<Badge tone={l.kind === "writes" ? "warning" : "accent"}>{l.kind === "writes" ? "Writes" : "Reads"}</Badge>}
                meta={`Repository in ${l.project}`}
                actions={
                  l.can_remove ? (
                    <IconButton
                      icon="trash"
                      size="sm"
                      label={`Remove ${l.component} (${lineageText(l.kind, "repository")})`}
                      disabledReason={removing === key ? "Removing…" : undefined}
                      onClick={() => void remove(l)}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </RowList>
      ) : (
        <p className="cn-data-note">No repository is linked yet. Say which ones read or write it, so their projects hear about schema changes.</p>
      )}
      {adding && (
        <LineageDialog
          table={table}
          articleId={article.id}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
    </Section>
  );
}

function LineageDialog({ table, articleId, onClose, onSaved }: { table: TableDetail; articleId: string; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const formId = useId();
  const choices = table.lineage_choices ?? [];
  const [repo, setRepo] = useState("");
  const [kind, setKind] = useState<LineageKind>("reads");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setError(null), [repo, kind]);
  const groups = lineageChoiceGroups(choices);
  const already = table.lineage.some((l) => `${l.project}/${l.component}` === repo && l.kind === kind);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const [project, component] = repo.split("/") as [string, string];
      await api("/links", { method: "POST", body: { from: componentRef(project, component), to: articleId, relation: kind } });
      toast.success(`${component} ${lineageText(kind, "repository")} ${table.key}`);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="Add a repository"
      description={`Which repository reads or writes ${table.key}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving…" disabledReason={!repo ? "Choose a repository first" : already ? "It's listed already" : undefined}>
            Add
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="cn-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && repo && !already) void save();
        }}
      >
        <Field label="Repository" hint="Repositories of projects where you can propose changes.">
          <Select value={repo} onChange={(e) => setRepo(e.target.value)} groups={groups}>
            <option value="" disabled>
              Choose a repository
            </option>
          </Select>
        </Field>
        <ChoiceCards
          name="lineage-kind"
          legend="What it does with the table"
          value={kind}
          onChange={(v) => setKind(v as LineageKind)}
          columns={2}
          options={[
            { value: "reads", label: "Reads it", icon: "eye", description: "Queries it, or a job or report loads from it." },
            { value: "writes", label: "Writes it", icon: "pencil", description: "Inserts, updates or loads rows into it." },
          ]}
        />
        {error ? <ErrorState compact error={error} title="Couldn't add it" /> : null}
      </form>
    </Dialog>
  );
}

function ColumnsTable({ table, onEdit }: { table: TableDetail; onEdit(c: TableColumn): void }) {
  const columns: Column<TableColumn>[] = [
    {
      key: "name",
      header: "Column",
      primary: true,
      cell: (c) => (
        <span className="cn-col-name">
          <code>{c.name}</code>
          {c.pk && <Badge tone="accent">Primary key</Badge>}
          {c.pii && (
            <Badge tone="warning" icon="lock">
              Personal data
            </Badge>
          )}
        </span>
      ),
    },
    { key: "type", header: "Type", cell: (c) => <code className="cn-col-type">{c.type}</code>, mobileLabel: "Type" },
    { key: "null", header: "Empty allowed", cell: (c) => (c.nullable ? "Yes" : "No"), hideBelow: 1100 },
    {
      key: "about",
      header: "What it means",
      mobileLabel: "Means",
      cell: (c) => (
        <span className="cn-col-about">
          {c.description || c.comment ? <span>{c.description || c.comment}</span> : <span className="cn-data-note">Not described yet</span>}
          {c.fk && <span className="cn-col-fk">References {c.fk}</span>}
        </span>
      ),
    },
  ];
  return (
    <Section title="Columns" level={3} count={table.columns.length} description={table.can_describe ? "Describe what a column means, and mark personal data: it's masked in query results." : undefined}>
      <DataTable
        caption={`Columns of ${table.key}`}
        columns={columns}
        rows={table.columns}
        getRowId={(c) => c.name}
        density="compact"
        rowAction={
          table.can_describe
            ? (c) => (
                <Button size="sm" variant="ghost" icon="pencil" onClick={() => onEdit(c)} aria-label={`Describe ${c.name}`}>
                  Describe
                </Button>
              )
            : undefined
        }
        empty={<EmptyState variant="compact" title="No columns" />}
      />
    </Section>
  );
}

function ColumnNoteDialog({ table, column, onClose, onSaved }: { table: TableDetail; column: TableColumn; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const formId = useId();
  const [description, setDescription] = useState(column.description ?? "");
  const [pii, setPii] = useState(column.pii);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = column.pii && !table.can_unflag_pii;
  const dirty = description !== (column.description ?? "") || pii !== column.pii;
  useEffect(() => setError(null), [description, pii]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/tables/${table.id}/notes`, { method: "PUT", body: { notes: [{ column: column.name, description, pii }] } });
      toast.success(`Saved what ${column.name} means`);
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={`Describe ${column.name}`}
      description={`${table.key} · ${column.type}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving…" disabledReason={dirty ? undefined : "Change something first"}>
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="cn-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && dirty) void save();
        }}
      >
        <Field label="What it means" optional hint={column.comment && !column.description ? `The database says: ${column.comment}` : "Units, allowed values, how it's filled in. It also shows in the table's article."}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={3} autoGrow maxRows={8} maxLength={1000} />
        </Field>
        <Checkbox
          label="Holds personal data"
          description={locked ? "Only a Project admin can say it doesn't any more." : "Names, emails, phone numbers, addresses… Its values are masked in query results."}
          checked={pii}
          disabled={locked}
          onChange={(e) => setPii(e.target.checked)}
        />
        {error ? <ErrorState compact error={error} title="Couldn't save it" /> : null}
      </form>
    </Dialog>
  );
}

/** One API: what its spec says (endpoints grouped by tag, each opening to its parameters and responses) and its history. */
function ApiDetailPane({ id, phone, onBack }: { id: string; phone: boolean; onBack(): void }) {
  const result = useApi<ApiDetail>(`/apis/${id}`);
  const [q, setQ] = useState("");
  return (
    <div className="cn-data-detail">
      {phone && (
        <Button variant="ghost" size="sm" icon="chevron-left" onClick={onBack}>
          All tables and APIs
        </Button>
      )}
      <AsyncBlock result={result} label="Loading the API" skeleton={<SkeletonRows count={6} density="compact" />} errorTitle="Couldn't load this API">
        {(a) => {
          const live = a.endpoints.filter((e) => !e.removed_at);
          const gone = a.endpoints.filter((e) => e.removed_at);
          const needle = q.trim().toLowerCase();
          const match = (e: Endpoint) => !needle || [e.method, e.path, e.summary ?? "", ...e.tags].join(" ").toLowerCase().includes(needle);
          const shown = live.filter(match);
          const groups = new Map<string, Endpoint[]>();
          for (const e of shown) groups.set(e.tags[0] ?? "Other", [...(groups.get(e.tags[0] ?? "Other") ?? []), e]);
          // Endpoints without a tag come last.
          const other = groups.get("Other");
          if (other && groups.size > 1) {
            groups.delete("Other");
            groups.set("Other", other);
          }
          return (
            <>
              <header className="cn-data-head">
                <h2 className="cn-data-title">
                  <I name="globe" size={20} />
                  <span>{a.connection.name}</span>
                </h2>
                <MetaLine
                  items={[
                    a.title && a.title !== a.connection.name ? a.title : null,
                    a.version ? `Version ${a.version}` : null,
                    a.format,
                    plural(live.length, "endpoint"),
                    a.connection.synced_at ? <RelativeTime key="s" prefix="Synced " date={a.connection.synced_at} /> : "Not synced yet",
                  ]}
                />
                <div className="cn-data-actions">
                  {a.article && (
                    <Button size="sm" icon="doc" href={href(`/article/${a.article.id}`)}>
                      Open its API contract
                    </Button>
                  )}
                  <span className="cn-data-note">
                    {!a.connection.calls
                      ? "Calls through Thaliyola are off for this API."
                      : a.can_call
                        ? "You and Claude can call it with call_api (GET by default; every call is logged)."
                        : "Contributors and above can call it with call_api."}
                  </span>
                </div>
              </header>
              {a.spec_removed && (
                <Callout tone="warning" title="This API's spec was removed">
                  Its endpoints are no longer listed as current, and its API contract is marked possibly stale. A Project admin can add a spec URL or paste the spec in project settings › Connections to sync it again.
                </Callout>
              )}
              {!a.endpoints.length ? (
                <EmptyState
                  variant="compact"
                  icon="globe"
                  title="No endpoints yet"
                  description="A Project admin can give this API's OpenAPI spec (its URL, or pasted) in project settings › Connections, then sync it."
                />
              ) : a.spec_removed && !live.length ? null : (
                <Section title="Endpoints" level={3} count={live.length}>
                  {live.length > 8 && <SearchInput value={q} onChange={setQ} label="Find an endpoint" placeholder="Find an endpoint" resultCount={needle ? shown.length : undefined} />}
                  {[...groups].map(([tag, list]) => (
                    <div key={tag} className="cn-api-group">
                      {(groups.size > 1 || tag !== "Other") && <h4 className="cn-data-schema-name">{tag}</h4>}
                      <ul className="cn-api-list">
                        {list.map((e) => (
                          <li key={e.id}>
                            <EndpointRow e={e} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {needle && !shown.length && <p className="cn-data-note">No endpoint matches “{q.trim()}”.</p>}
                </Section>
              )}
              {gone.length > 0 && (
                <Section title={a.spec_removed && !live.length ? "From the last spec" : "No longer in the spec"} level={3} count={gone.length}>
                  <ul className="cn-api-list">
                    {gone.map((e) => (
                      <li key={e.id}>
                        <EndpointRow e={e} />
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              <Section title="History" level={3} count={a.changes.length}>
                {a.changes.length ? (
                  <ul className="cn-data-history">
                    {a.changes.map((c) => (
                      <li key={c.id}>
                        <StatusBadge domain="schema_change" value={c.change} />
                        <code className="cn-data-history-text">{c.key}</code>
                        <span>{endpointChangeText(c)}</span>
                        <RelativeTime date={c.at} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cn-data-note">No changes since it was first synced.</p>
                )}
              </Section>
            </>
          );
        }}
      </AsyncBlock>
    </div>
  );
}

function EndpointRow({ e }: { e: Endpoint }) {
  return (
    <Disclosure
      className="cn-api-endpoint"
      summary={
        <span className="cn-api-head" data-removed={e.removed_at ? true : undefined}>
          <Badge tone={METHOD_TONE[e.method] ?? "neutral"} variant="outline">
            {e.method}
          </Badge>
          <code className="cn-api-path">{e.path}</code>
          {e.summary && <span className="cn-api-summary">{e.summary}</span>}
          {e.deprecated && <Badge tone="warning">Deprecated</Badge>}
        </span>
      }
    >
      <div className="cn-api-body">
        {e.description && <p className="cn-data-comment">{e.description}</p>}
        {e.params.length > 0 && (
          <dl className="cn-api-params">
            {e.params.map((p) => (
              <div key={`${p.in}:${p.name}`} className="cn-api-param">
                <dt>
                  <code>{p.name}</code>
                  <span className="cn-col-fk">
                    {p.in}
                    {p.required ? ", required" : ""}
                  </span>
                </dt>
                <dd>
                  <code className="cn-col-type">{p.type}</code>
                  {p.description && <span> {p.description}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {e.body && (
          <p className="cn-api-line">
            <span className="cn-api-label">Body</span> <code className="cn-col-type">{e.body.type}</code>
            <span className="cn-col-fk">
              {" "}
              {e.body.content_type}
              {e.body.required ? "" : ", optional"}
            </span>
          </p>
        )}
        {e.responses.length > 0 && (
          <ul className="cn-api-responses">
            {e.responses.map((r) => (
              <li key={r.status}>
                <span className="cn-api-label">{r.status}</span> {r.type && <code className="cn-col-type">{r.type}</code>} {r.description && <span className="cn-data-note">{r.description}</span>}
              </li>
            ))}
          </ul>
        )}
        {!e.params.length && !e.body && !e.responses.length && <p className="cn-data-note">The spec says nothing more about it.</p>}
      </div>
    </Disclosure>
  );
}
