import { useEffect, useState } from "react";
import { api } from "../api";
import { StatTile } from "../components/charts";
import { I, type IconName } from "../components/icons";
import { plural } from "../components/labels";
import { useApi } from "../hooks";
import { useBoot } from "../components/boot";
import { formatTimestamp } from "../components/labels";
import { versionText } from "../components/releases";
import { href } from "../router";
import {
  AdminTabs,
  AsyncBlock,
  Badge,
  Button,
  Card,
  Facts,
  Field,
  InfoTip,
  Page,
  PageHeader,
  PasswordInput,
  RelativeTime,
  SaveBar,
  Section,
  Select,
  SkeletonRows,
  Switch,
  SegmentedControl,
  Tabs,
  TextInput,
  useConfirm,
  useToast,
} from "../components/kit";

interface Setting {
  key: string;
  group: "access" | "knowledge" | "notifications" | "skills";
  label: string;
  help: string;
  /** Server configuration behind the setting (environment variables), for the technical details. */
  technical?: string | null;
  env: string;
  kind: "boolean" | "enum" | "int" | "number" | "string" | "secret";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  value: unknown;
  is_set?: boolean;
  hint?: string | null;
  env_value: unknown;
  source: "here" | "environment";
  updated_at: string | null;
  updated_by: string | null;
}

interface Preset {
  name: "looser" | "default" | "stricter";
  label: string;
  description: string;
  /** Only the settings whose value would change now. */
  changes: { key: string; label: string; from: unknown; to: unknown }[];
  current: boolean;
}

interface SystemData {
  settings: Setting[];
  environment: Record<string, string | number | null>;
  counts: Record<string, number | string | null>;
  presets?: Preset[];
}

type SectionId = "access" | "notifications" | "search" | "skills" | "installation" | "health";

/** In-page sections. "Access and publishing" also takes the publishing switch, which the server files under knowledge. */
const SECTIONS: { id: SectionId; title: string; lead: string; has: (s: Setting) => boolean }[] = [
  {
    id: "access",
    title: "Access and publishing",
    lead: "Who gets in, what new projects look like, who publishes without review, and whether people may approve by asking Claude.",
    has: (s) => s.group === "access" || /publish/.test(s.key),
  },
  { id: "notifications", title: "Notifications", lead: "Where Thaliyola tells people about proposals, decisions and the weekly digest.", has: (s) => s.group === "notifications" },
  {
    id: "search",
    title: "Search and duplicates",
    lead: "How strict search and duplicate detection are. The defaults suit most teams.",
    has: (s) => s.group === "knowledge" && !/publish/.test(s.key),
  },
  {
    id: "skills",
    title: "Skills for Claude",
    lead: "Whether Thaliyola gives Claude the skills your team publishes, and how strict skill review is. Changes take effect at once and are recorded in the audit log.",
    has: (s) => s.group === "skills",
  },
];


const ENV_LABELS: Record<string, string> = {
  auth_mode: "Sign-in mode",
  public_url: "Public URL",
  admin_emails: "Administrators set on the server (ADMIN_EMAILS)",
  mail: "Email",
  asset_store: "File storage",
  upload_limit_mb: "Upload limit (MB)",
  rate_limit_per_minute: "Requests per person per minute",
  sources: "Team sources",
  vulnerability_scan: "Dependency scanning",
  advisory_feed: "Critical advisories feed",
  connections: "Connections",
  skills_git_hosts: "Self-hosted git servers for skill imports (SKILLS_GIT_HOSTS)",
  skills_import_limit_mb: "Skill import limit (MB)",
};

const AUTH_MODE: Record<string, string> = { local: "Built-in sign-in", cloudflare: "Company sign-in (Cloudflare Access)", dev: "Access tokens (development)" };

const COUNTS: { key: string; label: string; icon: IconName; link?: (v: number) => string | undefined }[] = [
  { key: "people", label: "People", icon: "user", link: () => href("/admin/users") },
  { key: "services", label: "Service accounts", icon: "bot", link: () => href("/admin/users", { show: "service" }) },
  { key: "waiting", label: "Waiting for approval", icon: "clock", link: (v) => (v > 0 ? href("/admin/users") : undefined) },
  { key: "projects", label: "Projects", icon: "folder", link: () => href("/admin/projects") },
  { key: "articles", label: "Articles", icon: "doc" },
  { key: "findings", label: "Findings", icon: "bolt" },
  { key: "pending_reviews", label: "Proposals to review", icon: "review", link: (v) => (v > 0 ? href("/review") : undefined) },
];

const show = (s: Setting, v: unknown) =>
  s.kind === "boolean" ? (v ? "on" : "off") : s.options ? (s.options.find((o) => o.value === String(v))?.label ?? String(v)) : v === "" || v == null ? "empty" : String(v);

/** "hours" from "Browser sessions last (hours)": the unit shown after a number field. */
const unitOf = (s: Setting) => /\((hours|days|minutes|MB)\)\s*$/.exec(s.label)?.[1];

/** Why a draft value can't be saved (undefined = fine). */
function invalid(s: Setting, v: unknown): string | undefined {
  if (s.kind !== "int" && s.kind !== "number") return undefined;
  if (v === "" || v == null || Number.isNaN(Number(v))) return "Enter a number.";
  const n = Number(v);
  if (s.kind === "int" && !Number.isInteger(n)) return "Use a whole number.";
  if (s.min != null && n < s.min) return `Use ${s.min} or more.`;
  if (s.max != null && n > s.max) return `Use ${s.max} or less.`;
  return undefined;
}

/** Administrators: change the settings that apply without a restart, and see how the installation is set up. */
export function SystemSettingsPage() {
  const result = useApi<SystemData>("/system/settings");
  const { data, reload } = result;
  const build = useBoot().me.build;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // #/admin/system?section=skills opens that section (the Skills pages link here).
  const [section, setSection] = useState<SectionId>(() => {
    const asked = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("section");
    const tab = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab");
    if (tab === "health") return "health";
    return asked === "skills" || asked === "notifications" || asked === "search" || asked === "installation" || asked === "health" ? asked : "access";
  });
  const confirm = useConfirm();
  const toast = useToast();
  // After a reload, drop only the drafts that now match what's saved; other unsaved changes stay in the SaveBar.
  useEffect(() => {
    if (!data) return;
    setDraft((d) => {
      const next = { ...d };
      for (const s of data.settings) if (s.key in next && s.kind !== "secret" && String(next[s.key]) === String(s.value)) delete next[s.key];
      return Object.keys(next).length === Object.keys(d).length ? d : next;
    });
  }, [data]);

  async function save(patch: Record<string, unknown>, message: string): Promise<boolean> {
    setBusy(true);
    try {
      const out = await api<{ let_in?: number }>("/system/settings", { method: "PATCH", body: patch });
      // Only what was just saved leaves the draft: "Reset to default" or "Clear…" keeps the other unsaved changes.
      setDraft((d) => {
        const next = { ...d };
        for (const k of Object.keys(patch)) delete next[k];
        return next;
      });
      toast.success(message, out.let_in ? { description: `${out.let_in} ${out.let_in === 1 ? "person who was waiting is" : "people who were waiting are"} now in.` } : undefined);
      reload();
      return true;
    } catch (e) {
      toast.error(e, { title: "Couldn't save the settings" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!data) return;
    setSaveError(null);
    const bad = data.settings.filter((s) => s.key in draft && invalid(s, draft[s.key]));
    if (bad.length) {
      setSaveError(`Fix ${bad.length === 1 ? `"${bad[0]!.label}"` : `${bad.length} settings`} first.`);
      const first = bad[0]!;
      setSection(SECTIONS.find((x) => x.has(first))?.id ?? "access");
      requestAnimationFrame(() => document.getElementById(`setting-${first.key}`)?.focus());
      return;
    }
    const approval = data.settings.find((s) => s.key === "require_approval");
    const waiting = Number(data.counts.waiting ?? 0);
    if (approval && draft[approval.key] === false && approval.value !== false && waiting > 0) {
      const ok = await confirm({
        title: `Let ${waiting === 1 ? "1 person" : `${waiting} people`} in?`,
        body: `Switching approval off lets in ${waiting === 1 ? "the 1 person" : `the ${waiting} people`} waiting now, and everyone who signs in from now on.`,
        confirmLabel: "Save and let them in",
      });
      if (!ok) return;
    }
    await save(draft, "Saved. It applies right away.");
  }

  const set = (s: Setting, v: unknown) =>
    setDraft((d) => {
      const next = { ...d, [s.key]: v };
      if (s.kind !== "secret" && String(v) === String(s.value)) delete next[s.key];
      return next;
    });

  async function applyPreset(p: Preset, d: SystemData) {
    const byKey = new Map(d.settings.map((s) => [s.key, s]));
    const waiting = Number(d.counts.waiting ?? 0);
    const letsIn = p.changes.some((c) => c.key === "require_approval" && c.to === false) && waiting > 0;
    const ok = await confirm({
      title: `Apply the ${p.label} preset?`,
      body: (
        <>
          <p>{plural(p.changes.length, "setting changes", "settings change")} right away, for everyone:</p>
          <ul className="pp-preset-changes">
            {p.changes.map((c) => {
              const s = byKey.get(c.key);
              return (
                <li key={c.key}>
                  {c.label}: {s ? show(s, c.from) : String(c.from)} → <strong>{s ? show(s, c.to) : String(c.to)}</strong>
                </li>
              );
            })}
          </ul>
          {letsIn && <p>{waiting === 1 ? "The 1 person waiting for approval is let in." : `The ${waiting} people waiting for approval are let in.`}</p>}
        </>
      ),
      confirmLabel: `Apply ${p.label}`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const out = await api<{ changed: string[]; let_in?: number }>(`/system/presets/${p.name}`, { method: "POST" });
      // The preset's settings leave the draft (they're saved now); other unsaved changes stay.
      setDraft((dr) => {
        const next = { ...dr };
        for (const k of out.changed) delete next[k];
        return next;
      });
      toast.success(`${p.label} preset applied`, { description: out.let_in ? `${out.let_in} waiting ${out.let_in === 1 ? "person is" : "people are"} now in.` : undefined });
      reload();
    } catch (e) {
      toast.error(e, { title: "Couldn't apply the preset" });
    } finally {
      setBusy(false);
    }
  }

  async function clearSecret(s: Setting) {
    const ok = await confirm({ title: `Clear the ${s.label}?`, body: "Thaliyola stops using it until someone sets it again.", confirmLabel: "Clear", tone: "danger" });
    if (ok) await save({ [s.key]: "" }, `${s.label}: turned off`);
  }

  const source = (s: Setting) => (
    <div className="pp-setting-source">
      {s.source === "here" ? (
        <>
          <Badge tone="accent" variant="outline">
            Custom
          </Badge>
          <span>
            Changed here{s.updated_by ? ` by ${s.updated_by}` : ""}
            {s.updated_at ? (
              <>
                {" "}
                · <RelativeTime date={s.updated_at} />
              </>
            ) : null}
          </span>
          <InfoTip label={`Technical details for ${s.label}`}>
            <p>
              Overrides the environment variable <code>{s.env}</code>, which is {show(s, s.env_value)}.
            </p>
            {s.technical && <p>{s.technical}</p>}
          </InfoTip>
          <Button size="sm" variant="ghost" icon="undo" disabled={busy} onClick={() => void save({ [s.key]: null }, `${s.label}: back to the environment value`)}>
            Reset to default
          </Button>
        </>
      ) : (
        <>
          <span>From the environment</span>
          <InfoTip label={`Technical details for ${s.label}`}>
            <p>
              Set by the environment variable <code>{s.env}</code>. A change here overrides it until you reset it.
            </p>
            {s.technical && <p>{s.technical}</p>}
          </InfoTip>
        </>
      )}
    </div>
  );

  const row = (s: Setting) => {
    const v = s.key in draft ? draft[s.key] : s.value;
    const id = `setting-${s.key}`;
    const error = s.key in draft ? invalid(s, v) : undefined;
    const unit = unitOf(s);
    let control: JSX.Element;
    switch (s.kind) {
      case "boolean":
        control = <Switch label={s.label} description={s.help} checked={!!v} onChange={(on) => set(s, on)} />;
        break;
      case "enum":
        control =
          s.key === "skills_delivery" ? (
            <div className="pp-segmented-setting">
              <SegmentedControl label={s.label} labelVisible value={String(v)} onChange={(next) => set(s, next)} options={(s.options ?? []).map((o) => ({ value: o.value, label: o.label }))} />
              <p className="muted small">{s.help}</p>
            </div>
          ) : (
          <Field label={s.label} hint={s.help}>
            <Select id={id} value={String(v)} onChange={(e) => set(s, e.target.value)} options={s.options ?? []} />
          </Field>
          );
        break;
      case "int":
      case "number":
        control = (
          <Field label={s.label} hint={s.help} error={error}>
            <span className="pp-number">
              <TextInput
                id={id}
                type="number"
                inputMode={s.kind === "int" ? "numeric" : "decimal"}
                value={String(v ?? "")}
                min={s.min}
                max={s.max}
                step={s.kind === "int" ? 1 : 0.01}
                aria-invalid={error ? true : undefined}
                onChange={(e) => set(s, e.target.value === "" ? "" : Number(e.target.value))}
              />
              {unit && <span className="pp-number-unit">{unit}</span>}
            </span>
          </Field>
        );
        break;
      case "secret":
        control = (
          <Field label={s.label} hint={s.help} optional>
            <PasswordInput
              id={id}
              autoComplete="off"
              value={String(draft[s.key] ?? "")}
              placeholder={s.is_set ? `Set (${s.hint}); type to replace` : "Not set"}
              onChange={(e) => (e.target.value ? set(s, e.target.value) : setDraft(({ [s.key]: _, ...rest }) => rest))}
            />
          </Field>
        );
        break;
      default:
        control = (
          <Field label={s.label} hint={s.help}>
            <TextInput id={id} value={String(v ?? "")} onChange={(e) => set(s, e.target.value)} />
          </Field>
        );
    }
    return (
      <div key={s.key} className="pp-setting" data-state={s.key in draft ? "dirty" : undefined}>
        <div className="pp-setting-control">
          {control}
          {s.kind === "secret" && s.is_set && !(s.key in draft) && (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void clearSecret(s)}>
              Clear…
            </Button>
          )}
        </div>
        {source(s)}
      </div>
    );
  };

  return (
    <Page width="content">
      <PageHeader
        title="System settings"
        crumbs={[{ label: "Admin", href: href("/admin") }]}
        nav="admin"
        tabs={<AdminTabs current="system" />}
        description="Changes apply right away, for everyone. Only Administrators see this page."
        meta={
          <span className="pp-meta-links">
            Roles are on <a href={href("/admin/roles")}>Roles and access</a>, people on <a href={href("/admin/users")}>People</a>, projects on{" "}
            <a href={href("/admin/projects")}>Projects</a>.
          </span>
        }
      />
      <AsyncBlock result={result} label="Loading system settings" errorTitle="Couldn't load the system settings" skeleton={<SkeletonRows count={6} />}>
        {(d) => {
          const counts = (key: string) => {
            const v = d.counts[key];
            return v == null ? null : typeof v === "number" ? v : Number.isNaN(Number(v)) ? v : Number(v);
          };
          return (
            <>
              {d.presets && d.presets.length > 0 && (
                <Card
                  as="section"
                  title={
                    <span className="pp-preset-heading">
                      <I name="sliders" size={16} /> Presets
                    </span>
                  }
                  titleLevel={2}
                  description="Set who gets in, who publishes without review, new projects, sessions and duplicate checks in one go. Each shows exactly what it changes."
                  className="pp-presets-card"
                >
                  <div className="pp-presets">
                    {d.presets.map((p) => {
                      const byKey = new Map(d.settings.map((s) => [s.key, s]));
                      return (
                        <div key={p.name} className="pp-preset" data-current={p.current || undefined}>
                          <div className="pp-preset-head">
                            <h3 className="pp-preset-name">{p.label}</h3>
                            {p.current && (
                              <Badge tone="success" icon="check">
                                In place
                              </Badge>
                            )}
                          </div>
                          <p className="pp-preset-description">{p.description}</p>
                          {p.changes.length > 0 ? (
                            <>
                              <p className="pp-preset-label">Applying it changes</p>
                              <ul className="pp-preset-changes">
                                {p.changes.map((c) => {
                                  const s = byKey.get(c.key);
                                  return (
                                    <li key={c.key}>
                                      <span className="pp-preset-setting">{c.label}</span>
                                      <span className="pp-preset-values">
                                        {s ? show(s, c.from) : String(c.from)} <span aria-hidden="true">→</span>
                                        <span className="sr-only"> to </span> <strong>{s ? show(s, c.to) : String(c.to)}</strong>
                                      </span>
                                    </li>
                                  );
                                })}
                              </ul>
                            </>
                          ) : (
                            <p className="pp-preset-label">Every setting it covers already matches.</p>
                          )}
                          <div className="pp-preset-foot">
                            <Button size="sm" disabledReason={p.current ? "Already in place" : busy ? "Wait for the current save to finish" : undefined} onClick={() => void applyPreset(p, d)}>
                              Apply {p.label}…
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}
              <Tabs
                label="Settings sections"
                idPrefix="system"
                value={section}
                onChange={(id) => setSection(id as SectionId)}
                items={[
                  ...SECTIONS.map((x) => ({ id: x.id, label: x.title, count: d.settings.filter((s) => x.has(s) && s.key in draft).length || undefined, countTone: "accent" as const })),
                  { id: "installation", label: "This installation" },
                  { id: "health", label: "Health" },
                ]}
              />
              <div role="tabpanel" id="system-panel-health" aria-labelledby="system-tab-health" hidden={section !== "health"} className="pp-panel">
                {section === "health" && <HealthPanel />}
              </div>
              {SECTIONS.map((x) => (
                <div key={x.id} role="tabpanel" id={`system-panel-${x.id}`} aria-labelledby={`system-tab-${x.id}`} hidden={section !== x.id} className="pp-panel">
                  <Card as="section" title={x.title} titleLevel={2} description={x.lead}>
                    <div className="pp-settings">{d.settings.filter(x.has).map(row)}</div>
                    {x.id === "skills" && (
                      <div className="pp-skills-foot">
                        <p className="muted small">
                          Self-hosted git servers skill imports may reach: {String(d.environment.skills_git_hosts ?? "none")} (SKILLS_GIT_HOSTS, set on the server). People can switch off their own skills in Account › Skills for Claude.
                        </p>
                        <Button size="sm" variant="ghost" iconEnd="chevron-right" href={href("/skills", { tab: "all" })}>
                          Manage skills
                        </Button>
                      </div>
                    )}
                  </Card>
                </div>
              ))}
              <div role="tabpanel" id="system-panel-installation" aria-labelledby="system-tab-installation" hidden={section !== "installation"} className="pp-panel">
                <div className="pp-stack">
                  <Section title="At a glance">
                    <div className="pp-tile-grid">
                      {COUNTS.filter((c) => c.key in d.counts).map((c) => {
                        const v = counts(c.key);
                        return (
                          <StatTile
                            key={c.key}
                            label={c.label}
                            value={v}
                            icon={c.icon}
                            href={typeof v === "number" ? c.link?.(v) : undefined}
                            tone={c.key === "waiting" && typeof v === "number" && v > 0 ? "warning" : undefined}
                          />
                        );
                      })}
                    </div>
                  </Section>
                  <Card as="section" title="This installation" titleLevel={2} description="Set in the server's environment; changing these needs a redeploy.">
                    <Facts
                      columns={2}
                      items={[
                        // Thaliyola's own version (package.json) and the commit it was built from (BUILD_SHA / CI_COMMIT_SHA / git).
                        {
                          term: "Thaliyola version",
                          value: build ? (
                            <span>
                              <code>{versionText(build)}</code> <a href={href("/whats-new")}>What's new</a>
                            </span>
                          ) : (
                            <span className="muted">unknown</span>
                          ),
                        },
                        { term: "Built", value: build?.built_at ? formatTimestamp(build.built_at) : <span className="muted">run from source</span> },
                        ...Object.entries(d.environment).map(([k, v]) => ({
                          term: ENV_LABELS[k] ?? k,
                          value:
                            v == null ? (
                              <span className="muted">not set</span>
                            ) : v === "on" || v === "off" ? (
                              <Badge tone={v === "on" ? "success" : "neutral"} icon={v === "on" ? "check" : undefined}>
                                {v === "on" ? "On" : "Off"}
                              </Badge>
                            ) : k === "auth_mode" ? (
                              (AUTH_MODE[String(v)] ?? String(v))
                            ) : (
                              String(v)
                            ),
                        })),
                        { term: "Database schema (migration)", value: d.counts.migration == null ? "—" : <code>{String(d.counts.migration)}</code> },
                      ]}
                    />
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </AsyncBlock>
      <SaveBar dirtyCount={Object.keys(draft).length} onSave={() => void saveDraft()} onDiscard={() => { setDraft({}); setSaveError(null); }} saving={busy} error={saveError} />
    </Page>
  );
}

interface Job {
  name: string;
  last_run: string;
  status: "ok" | "failed" | "running" | null;
  last_success: string | null;
  last_error: string | null;
  duration_ms: number | null;
  failures: number;
  details: Record<string, unknown>;
}
interface Health {
  database: { size: string; version: string; encoding: string; migration: string | null };
  jobs: Job[];
  backups: { last: Job | null; offsite: Job | null; restore_check: Job | null; stale: boolean | null; note: string | null };
  embeddings: { enabled: boolean; pending: number };
  disk: { free_bytes: number; total_bytes: number } | null;
  connections: { health: string; n: number }[];
  activity: { sessions: number; incidents: number };
  problems: string[];
}

const JOB_LABEL: Record<string, string> = {
  maintenance: "Maintenance (stale entries, clean-up, revisit reminders, who-knows-what)",
  digests: "Weekly digests",
  sources: "Team sources",
  sessions: "Sessions (expiring questions)",
  security: "Dependency re-check",
  advisories: "Advisory feed",
  token_expiry: "Token expiry",
  expertise: "Who knows what",
  backup: "Backup",
  backup_offsite: "Off-site copy",
  restore_check: "Restore check",
};
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** Admin › System › Health: whether the installation is well, and what needs a look. */
function HealthPanel() {
  const result = useApi<Health>("/system/health");
  return (
    <AsyncBlock result={result} label="Loading health" skeleton={<SkeletonRows count={6} />} errorTitle="Couldn't load the health page">
      {(h) => (
        <div className="pp-stack">
          {h.problems.length ? (
            <Card as="section" title="Needs a look" titleLevel={2} tone="danger">
              <ul className="list">
                {h.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Card>
          ) : (
            <Card as="section" title="All well" titleLevel={2} description="Backups, restore checks and background jobs are running as they should." />
          )}
          <Section title="Backups">
            <Facts
              items={[
                { term: "Last backup", value: h.backups.last?.last_success ? <RelativeTime date={h.backups.last.last_success} /> : "none reported" },
                { term: "Off-site copy", value: h.backups.offsite?.last_success ? <RelativeTime date={h.backups.offsite.last_success} /> : "not set up (BACKUP_S3_BUCKET)" },
                {
                  term: "Last restore check",
                  value: h.backups.restore_check ? (
                    <>
                      <Badge tone={h.backups.restore_check.status === "ok" ? "success" : "danger"}>{h.backups.restore_check.status === "ok" ? "passed" : "failed"}</Badge> <RelativeTime date={h.backups.restore_check.last_run} />
                    </>
                  ) : (
                    "not run yet (monthly)"
                  ),
                },
              ]}
            />
            {h.backups.note && <p className="muted small">{h.backups.note}</p>}
          </Section>
          <Section title="Background jobs">
            <div className="table-wrap">
              <table className="table health-jobs">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Last run</th>
                    <th>Last success</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {h.jobs.map((j) => (
                    <tr key={j.name}>
                      <td>{JOB_LABEL[j.name] ?? j.name}</td>
                      <td>
                        <RelativeTime date={j.last_run} />
                        {j.duration_ms !== null ? <span className="muted small"> · {j.duration_ms < 1000 ? `${j.duration_ms} ms` : `${(j.duration_ms / 1000).toFixed(1)} s`}</span> : null}
                      </td>
                      <td>{j.last_success ? <RelativeTime date={j.last_success} /> : "—"}</td>
                      <td>
                        {j.status === "failed" ? (
                          <>
                            <Badge tone="danger">failed{j.failures > 1 ? ` ×${j.failures}` : ""}</Badge> <span className="small">{j.last_error}</span>
                          </>
                        ) : j.status === "ok" ? (
                          <Badge tone="success">ok</Badge>
                        ) : (
                          <span className="muted small">ran</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title="The installation">
            <Facts
              items={[
                { term: "Database", value: `${h.database.size}, PostgreSQL ${h.database.version}, ${h.database.encoding}` },
                { term: "Latest migration", value: h.database.migration ?? "—" },
                { term: "Search by meaning", value: h.embeddings.enabled ? `on, ${plural(h.embeddings.pending, "section")} waiting to be indexed` : "off" },
                ...(h.disk ? [{ term: "Disk for uploads", value: `${gb(h.disk.free_bytes)} free of ${gb(h.disk.total_bytes)}` }] : []),
                { term: "Connections", value: h.connections.length ? h.connections.map((c) => `${c.n} ${c.health}`).join(", ") : "none" },
                { term: "Right now", value: `${plural(h.activity.sessions, "session")} online, ${plural(h.activity.incidents, "open incident")}` },
              ]}
            />
          </Section>
        </div>
      )}
    </AsyncBlock>
  );
}
