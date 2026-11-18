/**
 * #/dev/kit (DEV builds only, lazy-loaded): every kit component and compatibility wrapper, for review in light and
 * dark at 390px and 1280px. Nothing here talks to the server except the scope list it reads from boot.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getTheme, setTheme, type Theme } from "../../theme";
import { StatTile, ChartCard, HBars } from "../charts";
import { BootProvider, useOptionalBoot, type BootData } from "../boot";
import type { Me, ScopeInfo } from "../../api";
import { CATEGORY, STATUS, type Category, type StatusDomain } from "../labels";
import { MoreActions } from "../more";
import { PersonInput } from "../people";
import { ConfirmButton, Diff, ErrorBox, Markdown, Notice, RelatedList, ScopeBadge, SourceLinks, StatusBadge as LegacyStatusBadge, TypeBadge, WriteOutcome } from "../ui";
import {
  AdminTabs,
  AsyncBlock,
  Avatar,
  AvatarStack,
  Badge,
  Breadcrumbs,
  BulkBar,
  Button,
  Callout,
  Card,
  CategoryBadge,
  Checkbox,
  Chip,
  ChipGroup,
  ChoiceCards,
  CodeBlock,
  CopyButton,
  CountBadge,
  DataTable,
  Dialog,
  DiffView,
  Disclosure,
  EmptyState,
  ErrorState,
  Facts,
  Field,
  FileDrop,
  FilterBar,
  FormActions,
  FormSection,
  GateCard,
  GroupHeader,
  IconButton,
  InfoTip,
  ItemRow,
  Kbd,
  KeyHint,
  ListRow,
  LoadMore,
  LocationLabel,
  MenuButton,
  MetaLine,
  NewItemsPill,
  OverflowMenu,
  Page,
  PageHeader,
  PasswordInput,
  PersonChip,
  Popover,
  ProjectPicker,
  RelativeTime,
  RowList,
  RunWithClaude,
  SaveBar,
  SearchInput,
  Section,
  SecretReveal,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  SkeletonCard,
  SkeletonRows,
  SkeletonText,
  SkeletonTiles,
  Spinner,
  Splash,
  SplitButton,
  StatusBadge,
  Stepper,
  Switch,
  Tabs,
  Textarea,
  TextInput,
  ToggleButton,
  Tooltip,
  TypeLabel,
  useAsyncAction,
  useConfirm,
  useToast,
  type MenuItemSpec,
} from "./index";

const SECTIONS = [
  ["buttons", "Buttons"],
  ["forms", "Fields and inputs"],
  ["navigation", "Tabs, segments and chips"],
  ["structure", "Cards and sections"],
  ["data", "Tables and lists"],
  ["display", "Badges, people and time"],
  ["code", "Code, copy and secrets"],
  ["feedback", "Feedback"],
  ["overlays", "Menus, dialogs and popovers"],
  ["diff", "Diff"],
  ["charts", "Stat tiles and charts"],
  ["gates", "Gates"],
  ["legacy", "Compatibility wrappers"],
] as const;

function Demo({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="kit-gallery-demo" data-wide={wide || undefined}>
      <h3 className="kit-gallery-demo-title">{title}</h3>
      <div className="kit-gallery-demo-body">{children}</div>
    </div>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MENU: MenuItemSpec[] = [
  { type: "group", label: "Item" },
  { id: "edit", label: "Edit", icon: "pencil", shortcut: "E", onSelect: () => undefined },
  { id: "move", label: "Move…", icon: "move", hint: "To another project or folder", onSelect: () => undefined },
  { id: "history", label: "Version history", icon: "history", href: "#/dev/kit" },
  { id: "docs", label: "Open the docs", icon: "external", href: "https://example.com", external: true },
  { id: "verify", label: "Confirm still accurate", icon: "check", disabledReason: "Only people with Verify can do this", onSelect: () => undefined },
  { type: "separator" },
  { id: "watch", label: "Watching", checked: true, onSelect: () => undefined },
  { type: "separator" },
  { id: "trash", label: "Move to trash", icon: "trash", tone: "danger", onSelect: () => undefined },
];

interface Row {
  id: string;
  name: string;
  admins: string;
  items: number;
  visibility: string;
  depth: number;
  archived?: boolean;
}
const ROWS: Row[] = [
  { id: "order-service", name: "Order service v2", admins: "Rita Shah, Wes Ng", items: 142, visibility: "members", depth: 0 },
  { id: "order-api", name: "Order API", admins: "Rita Shah", items: 38, visibility: "team", depth: 1 },
  { id: "order-workers", name: "Order workers", admins: "—", items: 7, visibility: "team", depth: 1, archived: true },
  { id: "payments", name: "Payments", admins: "Ana Lima", items: 1204, visibility: "members", depth: 0 },
];

const BEFORE = `# Refund flow

Refunds are issued by the payments worker.

The worker retries failed refunds three times, then raises an alert in #payments-oncall.

| Step | Owner |
|---|---|
| Request | Support |
| Approve | Finance |

Keep the idempotency key for 30 days.

Escalate to the Payments team after 24 hours.`;
const AFTER = `# Refund flow

Refunds are issued by the payments worker.

The worker retries failed refunds five times with backoff, then raises an alert in #payments-oncall.

| Step | Owner |
|---|---|
| Request | Support |
| Approve | Finance |

Keep the idempotency key for 90 days.

Escalate to the Payments team after 24 hours.

Refunds over £5,000 need a second approver.`;

const scope = (slug: string, name: string, kind: ScopeInfo["kind"], parent: string | null = null): ScopeInfo => ({
  id: slug,
  slug,
  name,
  kind,
  parent,
  description: "",
  visibility: kind === "project" ? "members" : "team",
  components: [],
  my_role: null,
  can_manage: true,
  effective_permissions: ["read", "propose", "review", "manage_settings", "manage_members"],
});

/** Demo boot data, so the gallery also works signed out or with the API down. */
const DEMO_BOOT: BootData = {
  me: { id: "demo", email: "admin@example.com", kind: "human", admin: true, permissions: [], local_account: false, must_change_password: false, auth_mode: "dev", default_project_visibility: "members" } as Me,
  scopes: [
    scope("team", "Team space", "team"),
    scope("library", "Library", "library"),
    scope("personal-demo", "Personal", "personal"),
    scope("order-service", "Order service v2", "project"),
    scope("order-api", "Order API", "project", "order-service"),
    scope("order-workers", "Order workers", "project", "order-service"),
    scope("payments", "Payments", "project"),
  ],
  articleTypes: [],
  findingTypes: [],
};

export function KitGallery() {
  const boot = useOptionalBoot();
  if (boot) return <GalleryBody />;
  return (
    <BootProvider initial={DEMO_BOOT}>
      <GalleryBody />
    </BootProvider>
  );
}

function GalleryBody() {
  const boot = useOptionalBoot();
  // "#/dev/kit?only=forms" shows one section (handy for screenshots).
  const only = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("only");
  const show = (id: string) => !only || only === id;
  const scopes = boot?.scopes ?? [];
  const firstProject = scopes.find((s) => s.kind === "project")?.slug ?? "order-service";
  const toast = useToast();
  const confirm = useConfirm();
  const [theme, setThemeState] = useState<Theme>(getTheme());

  // Buttons
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(false);
  const [fav, setFav] = useState(true);
  // Forms
  const [name, setName] = useState("Deploy token");
  const [nameError, setNameError] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [kind, setKind] = useState("runbook");
  const [where, setWhere] = useState(firstProject);
  const [agree, setAgree] = useState(true);
  const [emails, setEmails] = useState(true);
  const [emailStatus, setEmailStatus] = useState<"saving" | "saved" | undefined>("saved");
  const [visibility, setVisibility] = useState<string | string[]>("members");
  const [kinds, setKinds] = useState<string | string[]>(["rss", "slack"]);
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [person, setPerson] = useState("");
  const [dirty, setDirty] = useState(0);
  // Navigation
  const [tab, setTab] = useState("overview");
  const [period, setPeriod] = useState<"7" | "30" | "90">("30");
  const [status, setStatus] = useState("pending");
  const [cats, setCats] = useState<string[]>(["new", "edit"]);
  // Data
  const [selected, setSelected] = useState<Set<string>>(new Set(["order-api"]));
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [groupOpen, setGroupOpen] = useState(true);
  const [listSel, setListSel] = useState<Set<string>>(new Set(["b"]));
  // Feedback
  const [asyncState, setAsyncState] = useState<"loading" | "error" | "empty" | "data" | "refreshing">("data");
  const action = useAsyncAction(async () => {
    await wait(700);
    return 3;
  }, { success: (n) => `Approved ${n} proposals`, undo: async () => wait(300) });
  // Overlays
  const [dialog, setDialog] = useState<"sm" | "md" | "lg" | null>(null);
  const [sheet, setSheet] = useState<"bottom" | "left" | "right" | null>(null);
  const [pop, setPop] = useState(false);
  const popRef = useRef<HTMLButtonElement>(null);
  const [diffMode, setDiffMode] = useState<"rendered" | "source">("rendered");
  const [lastConfirm, setLastConfirm] = useState("Nothing confirmed yet.");

  useEffect(() => {
    if (emailStatus !== "saving") return;
    const t = setTimeout(() => setEmailStatus("saved"), 800);
    return () => clearTimeout(t);
  }, [emailStatus]);

  const sorted = [...ROWS].sort((a, b) => {
    const k = sort.key as keyof Row;
    const v = String(a[k]).localeCompare(String(b[k]), undefined, { numeric: true });
    return sort.dir === "asc" ? v : -v;
  });

  return (
    <Page width="wide">
      <PageHeader
        title="Kit gallery"
        documentTitle="Kit gallery"
        crumbs={[{ label: "Developer", href: "#/dev/kit" }]}
        eyebrow="Developer · DEV builds only"
        icon="sparkle"
        status={<Badge tone="accent">Foundation</Badge>}
        description="Every shared component in one place. Switch the theme here, and resize to 390px and 320px to check phones."
        info={{ label: "How to use this page", content: <p>Each demo is interactive. Tab through to check focus rings, arrows and Escape.</p> }}
        meta={<MetaLine items={[<span key="a">SPEC §5</span>, <RelativeTime key="b" date={new Date(Date.now() - 3 * 3600_000).toISOString()} prefix="Updated" />]} />}
        actions={
          <>
            <ToggleButton pressed={watching} onPressedChange={(v) => setWatching(v)} icon="eye" label="Watch" pressedLabel="Watching" iconOnly="phone" tooltip="Get notified about changes" />
            <Button icon="share" onClick={() => toast.success("Link copied")}>
              Share
            </Button>
          </>
        }
        primary={
          <Button variant="primary" icon="plus" onClick={() => toast.info("Primary action")}>
            New article
          </Button>
        }
        menu={MENU}
        tabs={
          <Tabs
            label="Gallery views"
            value="all"
            items={[
              { id: "all", label: "All components", href: "#/dev/kit", count: SECTIONS.length },
              { id: "a11y", label: "Accessibility notes", href: "#/dev/kit?view=a11y" },
            ]}
          />
        }
      />

      <nav className="kit-gallery-toc" aria-label="Gallery sections">
        <SegmentedControl
          label="Theme"
          labelVisible
          size="sm"
          options={[
            { value: "system", label: "System", icon: "monitor" },
            { value: "light", label: "Light", icon: "sun" },
            { value: "dark", label: "Dark", icon: "moon" },
          ]}
          value={theme}
          onChange={(t) => {
            setTheme(t);
            setThemeState(t);
          }}
        />
        <ul className="kit-gallery-links">
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <a href={`#/dev/kit`} onClick={(e) => (e.preventDefault(), document.getElementById(`kit-${id}`)?.scrollIntoView())}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* ---------------------------------------------------------------- Buttons */}
      {show("buttons") && (
        <>
      <Section id="kit-buttons" title="Buttons" description="At most one primary per view. Async buttons show a spinner and keep their width.">
        <div className="kit-gallery-grid">
          <Demo title="Variants">
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger-solid">Delete permanently</Button>
          </Demo>
          <Demo title="Sizes and icons">
            <Button size="sm" icon="plus">
              Small
            </Button>
            <Button icon="doc">Medium</Button>
            <Button size="lg" iconEnd="arrow" variant="primary">
              Large
            </Button>
            <Button href="https://example.com" external variant="ghost">
              External link
            </Button>
          </Demo>
          <Demo title="States">
            <Button
              variant="primary"
              loading={loading}
              loadingText="Saving"
              onClick={() => {
                setLoading(true);
                setTimeout(() => setLoading(false), 1500);
              }}
            >
              Save changes
            </Button>
            <Button disabledReason="Add a summary of changes first">Submit</Button>
            <Button disabled>Silently disabled</Button>
            <Button shortcut="mod+s" icon="check">
              With shortcut
            </Button>
          </Demo>
          <Demo title="Icon buttons">
            <IconButton icon="pencil" label="Edit" />
            <IconButton icon="copy" label="Copy" variant="secondary" />
            <IconButton icon="bell" label="Notifications, 3 unread" badge={3} />
            <IconButton icon="star" label="Pinned" pressed />
            <IconButton icon="trash" label="Delete" disabledReason="You can't delete the Team space" />
            <IconButton icon="x" label="Close" size="sm" />
          </Demo>
          <Demo title="Toggle and split buttons">
            <ToggleButton pressed={fav} onPressedChange={(v) => setFav(v)} icon="star" label="Favourite" pressedLabel="Favourited" tooltip="Add to favourites (shown in the sidebar)" />
            <ToggleButton pressed={false} onPressedChange={() => undefined} icon="eye" label="Watch" loading />
            <ToggleButton
              pressed={false}
              onPressedChange={async () => {
                await wait(400);
                throw new Error("The server said no");
              }}
              icon="bell"
              label="Fails and reverts"
            />
            <SplitButton
              label="New article"
              icon="doc"
              onClick={() => toast.info("New article")}
              menuLabel="More ways to create"
              menu={[
                { id: "f", label: "New finding", icon: "bolt", onSelect: () => undefined },
                { id: "p", label: "Draft from pasted text", icon: "clipboard", onSelect: () => undefined },
                { id: "i", label: "Import documents", icon: "upload", onSelect: () => undefined },
              ]}
            />
            <button type="button" className="link-btn">
              Link button
            </button>
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Forms */}
      {show("forms") && (
        <>
      <Section id="kit-forms" title="Fields and inputs" description="Visible labels, hints and errors linked to the control. Validate on submit.">
        <div className="kit-gallery-grid">
          <Demo title="Text, hint, error, counter">
            <form
              className="kit-gallery-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setNameError(name.trim() ? null : "Give the token a name, so you can tell it apart later.");
              }}
            >
              <Field label="Token name" hint="Expires in 90 days. Revoke it any time in Account." error={nameError}>
                <TextInput value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Summary of changes" optional counter={{ value: summary.length, max: 60 }}>
                <Textarea autoGrow minRows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Raised the retry limit to five" />
              </Field>
              <Button type="submit" variant="primary">
                Create token
              </Button>
            </form>
          </Demo>
          <Demo title="Select and project picker">
            <Field label="Type">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                options={[
                  { value: "runbook", label: "Runbook" },
                  { value: "decision", label: "Decision record" },
                  { value: "contract", label: "API contract" },
                ]}
              />
            </Field>
            <Field label="Where" hint="Projects show their full path.">
              <ProjectPicker value={where} onChange={setWhere} scopes={scopes} currentLabel="(where it is now)" />
            </Field>
          </Demo>
          <Demo title="Checkbox and switch">
            <Checkbox label="Add the starter pack" description="Six empty outlines: overview, runbook, architecture…" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <Checkbox label="Disabled option" disabled />
            <Switch
              label="Email me about reviews"
              description="Applies at once."
              checked={emails}
              status={emailStatus}
              onChange={(v) => {
                setEmails(v);
                setEmailStatus("saving");
              }}
            />
            <Switch label="Weekly summary email" checked={false} onChange={() => undefined} disabled />
          </Demo>
          <Demo title="Choice cards" wide>
            <ChoiceCards
              name="visibility"
              legend="Who can see it"
              columns={2}
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "members", label: "Members only", icon: "lock", description: "Only the people and teams you add, and people who can see every project." },
                { value: "team", label: "Everyone in Thaliyola", icon: "globe", description: "Everyone signed in can read it.", badge: <Badge>Default</Badge> },
              ]}
            />
            <ChoiceCards
              name="kinds"
              type="checkbox"
              legend="Sources"
              columns={3}
              value={kinds}
              onChange={setKinds}
              options={[
                { value: "rss", label: "Feed" },
                { value: "slack", label: "Slack" },
                { value: "notion", label: "Notion", disabledReason: "An Administrator has to connect Notion first." },
              ]}
            />
          </Demo>
          <Demo title="Search, password, person">
            <SearchInput value={query} onChange={setQuery} label="Search proposals" placeholder="Search proposals" resultCount={query ? 3 : 12} />
            <Field label="New password">
              <PasswordInput autoComplete="new-password" defaultValue="correct horse" />
            </Field>
            <Field label="Person">
              <PersonInput value={person} onChange={setPerson} label="Person" />
            </Field>
          </Demo>
          <Demo title="File drop">
            <FileDrop label="Markdown or HTML export" accept=".md,.html,.zip" file={file} onFile={setFile} hint="Up to 20 MB." />
          </Demo>
          <Demo title="Form section, actions and save bar" wide>
            <FormSection title="General" description="The name and description people see in lists.">
              <Field label="Name">
                <TextInput defaultValue="Order service v2" onChange={() => setDirty((d) => d || 1)} />
              </Field>
            </FormSection>
            <FormActions status="Draft saved 2 min ago" hint="A Reviewer or Project admin there reviews it before it's published." extra={<Field label="Summary of changes" labelHidden><TextInput placeholder="Summary of changes" /></Field>}>
              <Button variant="ghost">Cancel</Button>
              <Button variant="primary">Submit for review</Button>
            </FormActions>
            <Button size="sm" onClick={() => setDirty((d) => d + 1)}>
              Make a change ({dirty})
            </Button>
            <SaveBar dirtyCount={dirty} onDiscard={() => setDirty(0)} onSave={() => (setDirty(0), toast.success("Settings saved"))} />
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Navigation */}
      {show("navigation") && (
        <>
      <Section id="kit-navigation" title="Tabs, segments and chips">
        <div className="kit-gallery-grid">
          <Demo title="In-page tabs (arrow keys)" wide>
            <Tabs
              label="Project"
              idPrefix="kg"
              value={tab}
              onChange={setTab}
              items={[
                { id: "overview", label: "Overview", icon: "home" },
                { id: "pages", label: "Pages", count: 42 },
                { id: "sub", label: "Sub-projects", count: 3 },
                { id: "review", label: "Waiting for review", count: 120, countTone: "accent" },
                { id: "alerts", label: "Vulnerabilities", count: 2, countTone: "danger" },
              ]}
            />
            <div role="tabpanel" id={`kg-panel-${tab}`} aria-labelledby={`kg-tab-${tab}`} className="kit-gallery-panel">
              Panel for <strong>{tab}</strong>.
            </div>
          </Demo>
          <Demo title="Segmented control">
            <SegmentedControl
              label="Period"
              labelVisible
              value={period}
              onChange={setPeriod}
              options={[
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
              ]}
            />
            <SegmentedControl
              label="View"
              size="sm"
              value="graph"
              onChange={() => undefined}
              options={[
                { value: "graph", label: "Graph", icon: "graph" },
                { value: "list", label: "List", icon: "list" },
                { value: "off", label: "Off", disabled: true },
              ]}
            />
          </Demo>
          <Demo title="Chip groups">
            <ChipGroup
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "All" },
                { value: "pending", label: "Waiting", count: 12 },
                { value: "approved", label: "Approved", count: 40 },
                { value: "rejected", label: "Rejected", count: 3, dotColor: "var(--danger)" },
              ]}
            />
            <ChipGroup
              label="Categories"
              multiple
              value={cats}
              onChange={setCats}
              options={(Object.keys(CATEGORY) as Category[]).map((c) => ({ value: c, label: CATEGORY[c].label, hint: CATEGORY[c].hint }))}
            />
            <div className="kit-gallery-row">
              <Chip onRemove={() => undefined}>Project: Order API</Chip>
              <Chip onRemove={() => undefined}>Type: Runbook</Chip>
            </div>
          </Demo>
          <Demo title="Filter bar" wide>
            <FilterBar
              search={{ value: query, onChange: setQuery, label: "Search proposals", placeholder: "Search proposals" }}
              segments={
                <SegmentedControl
                  label="State"
                  size="sm"
                  value="open"
                  onChange={() => undefined}
                  options={[
                    { value: "open", label: "Open" },
                    { value: "done", label: "Done" },
                  ]}
                />
              }
              filters={
                <Select
                  aria-label="Project"
                  value=""
                  onChange={() => undefined}
                  options={[
                    { value: "", label: "All projects" },
                    { value: "o", label: "Order service v2" },
                  ]}
                />
              }
              more={{ count: 1, content: <Checkbox label="Only mine" defaultChecked /> }}
              view={[
                { type: "group", label: "Sort" },
                { id: "new", label: "Newest first", checked: true, onSelect: () => undefined },
                { id: "old", label: "Oldest first", checked: false, onSelect: () => undefined },
              ]}
              active={[{ id: "p", label: "Project: Order API", onRemove: () => undefined }]}
              onClearAll={() => undefined}
              result="12 proposals"
            />
          </Demo>
          <Demo title="Breadcrumbs and stepper">
            <Breadcrumbs
              items={[
                { label: "Projects", href: "#/dev/kit" },
                { label: "Order service v2", href: "#/dev/kit" },
                { label: "Contracts", href: "#/dev/kit" },
              ]}
            />
            <Stepper
              steps={[
                { id: "a", title: "Create a token", status: "done" },
                { id: "b", title: "Add Thaliyola to Claude", status: "current", content: <p className="muted">Run the command below in a terminal.</p> },
                { id: "c", title: "Ask your first question", status: "todo" },
              ]}
            />
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Structure */}
      {show("structure") && (
        <>
      <Section id="kit-structure" title="Cards and sections" count={4} actions={<Button size="sm">Section action</Button>}>
        <div className="kit-gallery-grid">
          <Card title="Plain card" description="A hairline, no shadow." actions={<IconButton icon="more" label="More actions" size="sm" />} footer="Updated 2 days ago">
            <p>Cards hold related content.</p>
          </Card>
          <Card title="Linked card" description="The whole card is a link, with a chevron." href="#/dev/kit">
            <p className="muted">Hover and focus show it's clickable.</p>
          </Card>
          <Card title="Danger zone" tone="danger" description="Move this project and everything in it to the trash.">
            <Button variant="danger-solid">Move to trash</Button>
          </Card>
          <Demo title="Disclosure">
            <Disclosure summary="Technical details" storageKey="kit-gallery">
              <p>Remembered per browser.</p>
            </Disclosure>
            <Disclosure summary="Closed by default">
              <p>Content.</p>
            </Disclosure>
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Data */}
      {show("data") && (
        <>
      <Section id="kit-data" title="Tables and lists" description="Tables turn into cards at 760px and below.">
        <DataTable
          caption="Projects"
          rows={sorted}
          getRowId={(r) => r.id}
          sort={sort}
          onSortChange={setSort}
          rowHref={() => "#/dev/kit"}
          rowTone={(r) => (r.archived ? "muted" : undefined)}
          indent={(r) => r.depth}
          selection={{ selected, onChange: setSelected, label: (r) => `Select ${r.name}` }}
          rowAction={() => (
            <Button size="sm" variant="ghost">
              Settings
            </Button>
          )}
          rowMenu={() => MENU}
          columns={[
            { key: "name", header: "Project", sortable: true, primary: true, cell: (r) => r.name },
            { key: "admins", header: "Project admins", cell: (r) => r.admins, hideBelow: 1100 },
            { key: "visibility", header: "Who can see it", cell: (r) => <StatusBadge domain="visibility" value={r.visibility} /> },
            { key: "items", header: "Items", sortable: true, numeric: true, cell: (r) => r.items.toLocaleString("en-GB") },
          ]}
          empty={<EmptyState variant="search" title="No projects match" />}
        />
        <div className="kit-gallery-grid">
          <Demo title="Loading and empty tables">
            <DataTable caption="Loading" rows={[]} loading getRowId={(r: Row) => r.id} columns={[{ key: "n", header: "Name", cell: (r: Row) => r.name }, { key: "i", header: "Items", numeric: true, cell: (r: Row) => r.items }]} empty={null} />
            <DataTable
              caption="Empty"
              rows={[]}
              getRowId={(r: Row) => r.id}
              columns={[{ key: "n", header: "Name", cell: (r: Row) => r.name }]}
              empty={<EmptyState variant="compact" title="No repositories yet" description="Add one so Claude can find this project from its code." primary={<Button size="sm">Add a repository</Button>} />}
            />
          </Demo>
          <Demo title="Group header, rows, bulk bar" wide>
            <BulkBar count={listSel.size} noun={["proposal", "proposals"]} onClear={() => setListSel(new Set())}>
              <Button size="sm" variant="primary">
                Approve
              </Button>
              <Button size="sm" variant="danger">
                Reject
              </Button>
            </BulkBar>
            <div className="kit-gallery-group">
              <GroupHeader
                label="New"
                count={3}
                hint="New articles and findings"
                tone="success"
                open={groupOpen}
                onToggle={() => setGroupOpen((o) => !o)}
                controls="kg-group"
                selectAll={{ checked: listSel.size === 0 ? false : listSel.size === 3 ? true : "mixed", onChange: (b) => setListSel(b ? new Set(["a", "b", "c"]) : new Set()), label: "Select all new" }}
                action={<button className="link-btn">Show only</button>}
              />
              {groupOpen && (
                <RowList label="New proposals">
                  {[
                    { id: "a", title: "Refund flow", meta: "Rita Shah · Order service v2", cursor: true },
                    { id: "b", title: "Payments outage on 3 Nov", meta: "AI agent · Payments", unread: true },
                    { id: "c", title: "Kafka consumer lag", meta: "Wes Ng · Order workers", error: "Couldn't approve: someone changed this while you were working." },
                  ].map((r) => (
                    <ListRow
                      key={r.id}
                      title={r.title}
                      href="#/dev/kit"
                      cursor={r.cursor}
                      unread={r.unread}
                      selected={listSel.has(r.id)}
                      error={r.error}
                      selectable={{ checked: listSel.has(r.id), onChange: (b) => setListSel((s) => { const n = new Set(s); b ? n.add(r.id) : n.delete(r.id); return n; }), label: `Select ${r.title}` }}
                      meta={r.meta}
                      badges={<CategoryBadge category="new" />}
                      trailing={<RelativeTime date={new Date(Date.now() - 50 * 60_000).toISOString()} />}
                      actions={<OverflowMenu items={MENU} size="sm" />}
                    />
                  ))}
                  <ListRow title="Archived project" tone="muted" description="Muted rows use a badge and muted text, never opacity." badges={<Badge>Archived</Badge>} />
                </RowList>
              )}
            </div>
            <LoadMore shown={100} total={240} noun={["proposal", "proposals"]} onMore={() => undefined} />
          </Demo>
          <Demo title="Item rows" wide>
            <RowList label="Search results">
              <ItemRow
                item={{
                  kind: "article",
                  id: "x",
                  title: "Refund flow",
                  section: "Retries",
                  type: "runbook",
                  status: "possibly_stale",
                  scope: { slug: firstProject, kind: "project" },
                  updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
                  snippet: "The worker **retries** failed refunds three times, then raises an alert. Use `refund_id` as the key.",
                  warning: "Not verified recently",
                  match: "semantic",
                }}
              />
              <ItemRow
                item={{ kind: "finding", id: "y", title: "Payments outage on 3 Nov", type: "incident", status: "published", scope: "library", updated_at: new Date(Date.now() - 20 * 86_400_000).toISOString(), via_uses_link: true }}
              />
              <ItemRow density="compact" item={{ kind: "article", id: "z", title: "Compact row", type: "decision", status: "draft", scope: "team" }} />
            </RowList>
          </Demo>
          <Demo title="Facts and meta line">
            <Facts
              columns={2}
              items={[
                { term: "Owner", value: <PersonChip name="Rita Shah" email="rita@example.com" size="sm" /> },
                { term: "Type", value: <TypeLabel type="runbook" withIcon /> },
                { term: "Where", value: <LocationLabel scope={firstProject} path="Contracts" link /> },
                { term: "Verified", value: <RelativeTime date={new Date(Date.now() - 3 * 86_400_000).toISOString()} />, hint: "Confirmed still accurate" },
              ]}
            />
            <MetaLine items={[<LocationLabel key="l" scope={firstProject} />, <TypeLabel key="t" type="rca" />, <RelativeTime key="r" date={new Date().toISOString()} prefix="Updated" />]} />
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Display */}
      {show("display") && (
        <>
      <Section id="kit-display" title="Badges, people and time">
        <div className="kit-gallery-grid">
          <Demo title="Badges">
            <div className="kit-gallery-row">
              <Badge>Neutral</Badge>
              <Badge tone="accent">Accent</Badge>
              <Badge tone="success" icon="check">
                Success
              </Badge>
              <Badge tone="warning" dot>
                Warning
              </Badge>
              <Badge tone="danger">Danger</Badge>
              <Badge tone="danger" variant="outline">
                Outline
              </Badge>
            </div>
            <div className="kit-gallery-row">
              {(Object.keys(CATEGORY) as Category[]).map((c) => (
                <CategoryBadge key={c} category={c} />
              ))}
            </div>
          </Demo>
          <Demo title="Status badges (label maps)" wide>
            {(["item", "proposal", "vulnerability", "run", "user"] as StatusDomain[]).map((d) => (
              <div key={d} className="kit-gallery-row">
                <span className="kit-gallery-label">{d}</span>
                {Object.keys(STATUS[d]).map((v) => (
                  <StatusBadge key={v} domain={d} value={v} />
                ))}
              </div>
            ))}
          </Demo>
          <Demo title="Type, location, counts">
            <div className="kit-gallery-row">
              <TypeLabel type="rca" kind="finding" withIcon />
              <TypeLabel type="runbook" />
              <TypeLabel type="something_new" />
            </div>
            <div className="kit-gallery-row">
              <LocationLabel scope={firstProject} link />
              <LocationLabel scope="library" />
              <LocationLabel scope={{ slug: "unknown-project", kind: "project" }} path="Folder" />
            </div>
            <div className="kit-gallery-row">
              <CountBadge value={3} label="3 unread" />
              <CountBadge value={12} tone="accent" label="12 pending proposals" />
              <CountBadge value={240} tone="danger" label="240 critical" />
            </div>
          </Demo>
          <Demo title="People">
            <div className="kit-gallery-row">
              <Avatar name="Rita Shah" email="rita@example.com" size={20} />
              <Avatar name="Wes Ng" email="wes@example.com" size={24} />
              <Avatar email="ana@example.com" size={32} />
              <Avatar name="Claude" kind="service" size={40} label="Claude (AI agent)" />
            </div>
            <AvatarStack people={[{ name: "Rita Shah", email: "rita@x" }, { name: "Wes Ng", email: "wes@x" }, { name: "Ana Lima", email: "ana@x" }, { name: "Joe Bloggs", email: "joe@x" }, { name: "Kim Park", email: "kim@x" }]} max={3} />
            <PersonChip name="Rita Shah" email="rita@example.com" you showEmail />
            <PersonChip name="Claude Code" email="bot@example.com" kind="service" />
            <PersonChip name="Wes Ng" email="wes@example.com" href="#/dev/kit" size="sm" />
          </Demo>
          <Demo title="Time and keys">
            <p>
              <RelativeTime date={new Date(Date.now() - 20_000).toISOString()} /> · <RelativeTime date={new Date(Date.now() - 12 * 60_000).toISOString()} /> ·{" "}
              <RelativeTime date={new Date(Date.now() - 26 * 3600_000).toISOString()} /> · <RelativeTime date={new Date(Date.now() - 40 * 86_400_000).toISOString()} /> ·{" "}
              <RelativeTime date={null} prefix="Verified" />
            </p>
            <p>
              <Kbd keys="mod+k" /> <Kbd keys="shift+a" /> <Kbd keys="?" /> <Kbd keys="Escape" />
            </p>
            <KeyHint
              items={[
                { keys: "j k", label: "move" },
                { keys: "x", label: "select" },
                { keys: "o", label: "open" },
                { keys: "mod+enter", label: "approve" },
              ]}
            />
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Code */}
      {show("code") && (
        <>
      <Section id="kit-code" title="Code, copy and secrets">
        <div className="kit-gallery-grid">
          <Demo title="Code blocks" wide>
            <CodeBlock
              language="shell"
              code={'claude mcp add --transport http thaliyola https://thaliyola.example.com/mcp --header "Authorization: Bearer <your token>"'}
              placeholder={{ token: "<your token>", hint: "Needs a token.", action: <Button size="sm" variant="ghost">Create a token first</Button> }}
            />
            <CodeBlock language="markdown" label="AGENTS.md block" code={"## Knowledge base\nBefore changing code here, call get_project_context with project order-service. Capture what you learn with propose_finding."} />
            <CodeBlock language="yaml" code={"jobs:\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx thaliyola docs --project order-service"} maxHeight={120} />
            <CopyButton text="order-service" label="Copy short name" />
          </Demo>
          <Demo title="Secret reveal and Run with Claude" wide>
            <SecretReveal title="Your new token" value="thl_live_4f7c2b9a8e6d4c1f" onDone={() => toast.success("Token saved")} extra={<p className="muted">Use it in the command on Connect.</p>} />
            <RunWithClaude
              command="/thaliyola:curate"
              description="Claude tidies misfiled entries and reports what it changed."
              variants={[
                { label: "Claude Code", command: "/thaliyola:curate" },
                { label: "Any MCP client", command: "Run the curate prompt from the Thaliyola server." },
              ]}
            />
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Feedback */}
      {show("feedback") && (
        <>
      <Section id="kit-feedback" title="Feedback">
        <div className="kit-gallery-grid">
          <Demo title="Callouts" wide>
            <Callout title="This page needs a check" tone="warning" actions={<Button size="sm">Confirm still accurate</Button>}>
              <p>Nobody has verified it in 90 days.</p>
            </Callout>
            <Callout tone="info" title="From the inbox" onDismiss={() => undefined}>
              Saving files this item in the inbox.
            </Callout>
            <Callout tone="success">Published.</Callout>
            <Callout tone="danger" title="This is in the trash" live>
              Restore it to edit.
            </Callout>
            <Callout tone="neutral" icon="lock">
              You can read this project, but changing it needs Manage settings.
            </Callout>
          </Demo>
          <Demo title="Toasts">
            <Button onClick={() => toast.success("Approved 3 proposals", { undo: () => wait(300) })}>Success with Undo</Button>
            <Button onClick={() => toast.info("Link copied")}>Info</Button>
            <Button onClick={() => toast.warning("Order API now has no Project admin", { description: "Make someone else Project admin there." })}>Warning</Button>
            <Button onClick={() => toast.error(Object.assign(new Error("conflict"), { status: 409 }), { title: "Couldn't approve", action: { label: "Try again", onClick: () => undefined } })}>Error</Button>
            <Button variant="primary" loading={action.busy} onClick={() => void action.run()}>
              useAsyncAction
            </Button>
          </Demo>
          <Demo title="Error states">
            <ErrorState error={Object.assign(new Error("relation \"proposals\" does not exist"), { status: 500 })} onRetry={() => undefined} title="Proposals didn't load" />
            <ErrorState compact error={Object.assign(new Error("Forbidden: needs review"), { status: 403 })} onRetry={() => undefined} />
          </Demo>
          <Demo title="Empty states" wide>
            <div className="kit-gallery-grid">
              <EmptyState title="No articles yet" description="Write the first one, or import documents." primary={<Button variant="primary">New article</Button>} secondary={<Button>Import documents</Button>} />
              <EmptyState variant="positive" title="All caught up" description="Nothing is waiting for review." />
              <EmptyState variant="search" title="Nothing matches" description="Try other words." primary={<Button>Clear filters</Button>} />
              <EmptyState variant="locked" title="You can't add repositories here" description="Ask a Project admin (Rita, Wes) to add one." />
              <EmptyState variant="compact" title="No comments" />
            </div>
          </Demo>
          <Demo title="Skeletons and spinner">
            <SkeletonText lines={3} />
            <SkeletonRows count={2} />
            <SkeletonCard />
            <SkeletonTiles count={3} />
            <p>
              <Spinner /> <Spinner size={20} label="Saving" /> <Skeleton width={120} radius="full" />
            </p>
          </Demo>
          <Demo title="AsyncBlock and new items">
            <SegmentedControl
              label="State"
              size="sm"
              value={asyncState}
              onChange={setAsyncState}
              options={[
                { value: "loading", label: "Loading" },
                { value: "refreshing", label: "Refreshing" },
                { value: "error", label: "Error" },
                { value: "empty", label: "Empty" },
                { value: "data", label: "Data" },
              ]}
            />
            <AsyncBlock
              label="Loading proposals"
              result={{
                data: asyncState === "loading" || asyncState === "error" ? null : asyncState === "empty" ? [] : ["Refund flow", "Kafka consumer lag"],
                error: asyncState === "error" ? new TypeError("Failed to fetch") : null,
                loading: asyncState === "loading" || asyncState === "refreshing",
                reload: () => setAsyncState("data"),
              }}
              skeleton={<SkeletonRows count={2} />}
              isEmpty={(d) => d.length === 0}
              empty={<EmptyState variant="compact" title="No proposals" />}
            >
              {(d) => (
                <ul className="list">
                  {d.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </AsyncBlock>
            <div className="kit-gallery-pill">
              <NewItemsPill count={3} noun={["proposal", "proposals"]} onShow={() => undefined} />
            </div>
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Overlays */}
      {show("overlays") && (
        <>
      <Section id="kit-overlays" title="Menus, dialogs and popovers" description="Menus become bottom sheets at 640px and below; dialogs too.">
        <div className="kit-gallery-grid">
          <Demo title="Menus">
            <MenuButton label="Actions" items={MENU} />
            <MenuButton label="Sort" icon="sort" variant="ghost" size="sm" items={[{ id: "a", label: "Newest first", checked: true, onSelect: () => undefined }, { id: "b", label: "Oldest first", checked: false, onSelect: () => undefined }]} />
            <OverflowMenu items={MENU} />
          </Demo>
          <Demo title="Tooltip, InfoTip, Popover">
            <Tooltip content="Copies a link to this section">
              <Button size="sm" id="kit-tooltip-demo">
                Hover or focus me
              </Button>
            </Tooltip>
            <span className="kit-gallery-row">
              Severity score <InfoTip label="What is the severity score?">A number from 0 to 10 from the advisory. Higher means more urgent.</InfoTip>
            </span>
            <Button ref={popRef} aria-expanded={pop} onClick={() => setPop((p) => !p)}>
              Open popover
            </Button>
            <Popover anchorRef={popRef} open={pop} onClose={() => setPop(false)} label="Filters" sheetOnMobile>
              <Checkbox label="Only mine" defaultChecked />
              <Checkbox label="Include drafts" />
            </Popover>
          </Demo>
          <Demo title="Dialogs and sheets">
            <Button onClick={() => setDialog("sm")}>Small dialog</Button>
            <Button onClick={() => setDialog("md")}>Form dialog</Button>
            <Button onClick={() => setDialog("lg")}>Large dialog</Button>
            <Button onClick={() => setSheet("bottom")}>Bottom sheet</Button>
            <Button onClick={() => setSheet("left")}>Left sheet</Button>
            <Button onClick={() => setSheet("right")}>Right panel</Button>
          </Demo>
          <Demo title="Confirmations">
            <Button
              variant="danger"
              onClick={async () => {
                const r = await confirm({
                  title: "Delete Order service v2 permanently?",
                  body: <p>Its 142 items and their history are deleted for good. This can't be undone.</p>,
                  confirmLabel: "Delete permanently",
                  tone: "danger",
                  typeToConfirm: { values: ["Order service v2", "order-service"] },
                });
                setLastConfirm(r ? `Confirmed (typed “${r.typed}”).` : "Cancelled.");
              }}
            >
              Type to confirm
            </Button>
            <Button
              onClick={async () => {
                const r = await confirm({
                  title: "Reject this proposal?",
                  confirmLabel: "Reject",
                  tone: "danger",
                  reason: { label: "Reason", required: true, minLength: 10, presets: ["Duplicate", "Not accurate", "Belongs in another project"], hint: "The author sees this." },
                });
                setLastConfirm(r ? `Rejected: ${r.reason}` : "Cancelled.");
              }}
            >
              Reason with presets
            </Button>
            <Button
              onClick={async () => {
                const r = await confirm({ title: "Open this project to everyone?", body: "Everyone signed in can read it.", confirmLabel: "Open to everyone" });
                setLastConfirm(r ? "Opened." : "Cancelled.");
              }}
            >
              Plain confirm
            </Button>
            <p className="muted" aria-live="polite">
              {lastConfirm}
            </p>
          </Demo>
        </div>
        <Dialog
          open={dialog !== null}
          size={dialog ?? "md"}
          onClose={() => setDialog(null)}
          title={dialog === "md" ? "Add a repository" : dialog === "lg" ? "Version 4 compared with version 3" : "Remove Wes from Order service v2?"}
          description={dialog === "md" ? "Claude uses it to find this project from its code." : undefined}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => (setDialog(null), toast.success("Repository added"))}>
                {dialog === "md" ? "Add repository" : "Done"}
              </Button>
            </>
          }
        >
          {dialog === "md" ? (
            <>
              <Field label="Git URL" hint="HTTPS or SSH.">
                <TextInput placeholder="https://github.com/acme/orders" />
              </Field>
              <Field label="Kind">
                <Select options={[{ value: "backend", label: "Backend" }, { value: "frontend", label: "Frontend" }]} />
              </Field>
              <MenuButton label="Inside a dialog" items={MENU} size="sm" />
            </>
          ) : dialog === "lg" ? (
            <DiffView before={BEFORE} after={AFTER} markdown showModeToggle />
          ) : (
            <p>They lose Contributor here. They keep Reviewer through team Platform.</p>
          )}
        </Dialog>
        <Sheet open={sheet !== null} side={sheet ?? "bottom"} onClose={() => setSheet(null)} title={sheet === "left" ? "Menu" : sheet === "right" ? "Add a source" : "Create"} footer={sheet === "right" ? <Button variant="primary">Add source</Button> : undefined}>
          {sheet === "right" ? (
            <Field label="Feed URL">
              <TextInput placeholder="https://status.example.com/feed" />
            </Field>
          ) : (
            <ul className="plain kit-gallery-sheet-list">
              <li>
                <Button variant="ghost" icon="doc" block>
                  New article
                </Button>
              </li>
              <li>
                <Button variant="ghost" icon="bolt" block>
                  New finding
                </Button>
              </li>
            </ul>
          )}
        </Sheet>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Diff */}
      {show("diff") && (
        <>
      <Section id="kit-diff" title="Diff">
        <div className="kit-gallery-grid">
          <Demo title="Rendered with toggle" wide>
            <DiffView before={BEFORE} after={AFTER} markdown showModeToggle mode={diffMode} onModeChange={setDiffMode} context={1} labels={{ before: "Version 3", after: "Version 4" }} />
          </Demo>
          <Demo title="Source (collapsed context)" wide>
            <DiffView before={BEFORE} after={AFTER} context={1} />
          </Demo>
          <Demo title="New entry">
            <DiffView before="" after={"## Kafka consumer lag\n\nThe order workers fall behind when partitions rebalance."} markdown isNew />
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Charts */}
      {show("charts") && (
        <>
      <Section id="kit-charts" title="Stat tiles and charts">
        <div className="tiles">
          <StatTile label="Articles" value={1284} icon="doc" trend={[3, 5, 4, 8, 9, 12, 14]} note="12 weeks" />
          <StatTile label="Waiting for review" value={12} icon="inbox" href="#/dev/kit" note="median 4h to decide" />
          <StatTile label="Needs attention" value={7} icon="alert" tone="warning" note="stale or overdue" info="Items not verified in 90 days, or past their review date." />
          <StatTile label="Critical vulnerabilities" value={2} icon="shield" tone="danger" />
          <StatTile label="Agent searches answered" value={null} icon="plug" emptyNote="No agent searches yet · Connect Claude" />
          <StatTile label="Loading tile" value={0} icon="chart" loading />
        </div>
        <div className="grid-2">
          <ChartCard
            title="Knowledge by type"
            subtitle="Published articles and findings"
            summary="Runbooks are the most common type."
            table={{ columns: ["Type", "Count"], rows: [["Runbook", 40], ["Decision record", 22], ["Incident", 12]] }}
          >
            <HBars data={[{ label: "Runbook", value: 40 }, { label: "Decision record", value: 22 }, { label: "Incident", value: 12 }]} />
          </ChartCard>
          <ChartCard title="Searches this week" table={{ columns: ["Day", "Searches"], rows: [["Mon", 0], ["Tue", 0]] }} empty={<EmptyState variant="compact" title="No searches yet" />}>
            <HBars data={[]} />
          </ChartCard>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Gates */}
      {show("gates") && (
        <>
      <Section id="kit-gates" title="Gates">
        <div className="kit-gallery-gate">
          <GateCard title="Sign in" description="Use your Thaliyola account." footer={<>Forgot your password? Ask an Administrator or User manager to reset it.</>}>
            <Field label="Email">
              <TextInput type="email" autoComplete="email" />
            </Field>
            <Field label="Password">
              <PasswordInput autoComplete="current-password" />
            </Field>
            <Button variant="primary" block>
              Sign in
            </Button>
          </GateCard>
        </div>
        <div className="kit-gallery-grid">
          <Demo title="Splash (shown while Thaliyola starts)">
            <div className="kit-gallery-splash">
              <Splash />
            </div>
          </Demo>
          <Demo title="Admin tabs (as an Administrator, demo data)" wide>
            <BootProvider initial={DEMO_BOOT}>
              <AdminTabs current="roles" />
            </BootProvider>
          </Demo>
        </div>
      </Section>
        </>
      )}

      {/* ---------------------------------------------------------------- Legacy */}
      {show("legacy") && (
        <>
      <Section id="kit-legacy" title="Compatibility wrappers" description="Old exports with their old props, drawn with the kit.">
        <div className="kit-gallery-grid">
          <Demo title="Notice, ErrorBox, WriteOutcome">
            <Notice>Info notice.</Notice>
            <Notice kind="warn">Warning notice.</Notice>
            <Notice kind="ok">Done notice.</Notice>
            <ErrorBox error={Object.assign(new Error("Title is required"), { status: 400 })} onRetry={() => undefined} />
            <WriteOutcome published={false} />
          </Demo>
          <Demo title="Badges and ConfirmButton">
            <div className="kit-gallery-row">
              <LegacyStatusBadge status="possibly_stale" />
              <LegacyStatusBadge status="pending" />
              <TypeBadge type="rca" />
              <ScopeBadge scope={{ slug: firstProject, kind: "project" }} />
            </div>
            <ConfirmButton label="Remove" question="Remove this repository?" onConfirm={() => toast.success("Removed")} />
            <ConfirmButton label="Delete project" question="Delete this project?" typeToConfirm={["Order service v2"]} onConfirm={(t) => toast.success(`Deleted (${t})`)} />
          </Demo>
          <Demo title="Related items and external links">
            <RelatedList
              items={[
                { relation: "uses", direction: "out", kind: "article", id: "a", label: "Payments API contract", type: "contract", status: "published", scope: "library" },
                { relation: "same_root_cause", direction: "in", kind: "finding", id: "b", label: "Outage on 3 Nov", type: "incident", status: "published", scope: firstProject },
              ]}
            />
            <SourceLinks links={[{ url: "https://example.com/pr/12", system: "pr", label: "Raise retry limit" }]} />
          </Demo>
          <Demo title="Markdown and Diff" wide>
            <Markdown text={"See the [runbook](#/dev/kit) and the [vendor docs](https://example.com). Inline `code` too."} />
            <Diff before={"a\nb\nc"} after={"a\nB\nc\nd"} />
          </Demo>
          <Demo title="MoreActions">
            <MoreActions>
              <Button size="sm">Edit</Button>
              <Button size="sm">Move…</Button>
            </MoreActions>
          </Demo>
        </div>
      </Section>
        </>
      )}
    </Page>
  );
}
