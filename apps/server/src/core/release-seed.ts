import type { FeatureArea, FeatureKind } from "./changelog.js";

/**
 * The starting catalog, written once into empty release tables (ensureReleaseCatalog): 0.9.0, everything in
 * production before release notes existed, and 1.0.0 as a draft from CHANGELOG.md's "Unreleased", with Connections
 * and Skills for Claude.
 */

export interface SeedFeature {
  title: string;
  area: FeatureArea;
  kind: FeatureKind;
  description: string;
  how_to: string;
  app_route?: string;
  audience?: "everyone" | "admins" | "project_admins";
  tags?: string[];
}

export interface SeedRelease {
  version: string;
  title: string;
  summary: string;
  released_on: string | null;
  status: "draft" | "published";
  source: "seed" | "changelog";
  /**
   * It still needs a person to read it through and publish it (it had placeholders until the features it describes
   * merged): it stays a draft even when the first server to start is already past its version (other seed releases
   * are history by then, and are published quietly).
   */
  placeholders?: boolean;
  features: SeedFeature[];
}

const V090: SeedRelease = {
  version: "0.9.0",
  title: "Everything before 1.0",
  summary:
    "Everything Thaliyola did before version numbers and release notes, in one place: the knowledge base and search, review, security, the inbox and team sources, projects and sub-projects, roles and access, system settings, publishing without review, service accounts, PDF reading over Claude and the redesigned app.",
  released_on: "2026-11-12",
  status: "published",
  source: "seed",
  features: [
    {
      title: "Articles and findings",
      area: "knowledge",
      kind: "new",
      description:
        "The knowledge base itself. **Articles** are curated pages in templated types: systems, tables, metrics, runbooks, decisions, design docs, tech specs, API contracts, patterns, design tokens, UI components, UX patterns and screen specs. **Findings** are things that happened: incidents, root cause analyses, known issues, data gotchas and query recipes. Both live in the Team space, a project or the Library, link to each other with typed links, and keep every published version.",
      how_to:
        "1. Press **c** anywhere (or **New** at the top of the sidebar) and choose **New article** or **New finding**.\n2. Pick where it goes and its type; the editor starts from that type's template, with a writing guide beside it.\n3. Use `/` for blocks, `@` to link an article or finding and `#` to link a topic. Paste or drop images to attach them.\n4. **Publish** (or **Submit for review**). Older versions are under **History** on the page.",
      app_route: "#/new/article",
      tags: ["articles", "findings", "editor", "templates"],
    },
    {
      title: "Search, the best answer and ⌘K",
      area: "knowledge",
      kind: "new",
      description:
        "Hybrid keyword and semantic search with a local model (no API key). Results show a **Best answer** card quoting the section or finding that answers the question, results appear as you type, and **⌘K** jumps to anything: pages, topics, favourites, recent items and actions.",
      how_to: "- Type in the search box on Home, or press **⌘K** (Ctrl K) or **/** anywhere.\n- Phrase it the way the problem showed up (\"checkout errors spiking\").\n- Open the full results page with **Enter** to filter by project, type and status.",
      app_route: "#/search",
      tags: ["search", "command-palette", "favourites"],
    },
    {
      title: "Knowledge graph and topics",
      area: "knowledge",
      kind: "new",
      description:
        "An interactive map of projects, repositories, articles and findings and how they link, a two-hop **Related items** panel on every article and finding, and topic pages for the systems, tables, metrics and services entries are about.",
      how_to: "Open **Knowledge graph** under Explore in the sidebar. Click a node to focus it, or use **Graph** on a project page to start from that project. Topics are linked from each entry's **About** list.",
      app_route: "#/graph",
      tags: ["graph", "topics", "relations"],
    },
    {
      title: "Import, export and drafts from pasted text",
      area: "knowledge",
      kind: "new",
      description:
        "Bring documents in (Markdown, HTML, zip exports from Notion, Confluence and Google Docs, with a dry-run preview) and take everything out (a Markdown zip in the Open Knowledge Format, or a static site). **Draft from pasted text** turns a Slack thread, email or notes into a draft finding or article.",
      how_to: "- **New › Import documents** to bring files in; check the preview, then import.\n- **New › Draft from pasted text** to start from a thread or email.\n- Exports are on **Account › Your data**.",
      app_route: "#/import",
      tags: ["import", "export", "notion", "confluence"],
    },
    {
      title: "Personal space",
      area: "knowledge",
      kind: "new",
      description:
        "A private space for each person: preferences, how you work, what you're on and things you keep looking up. Only you see it, it's searched from every project, and Claude reads it at the start of a session.",
      how_to: "Open **Personal space** under Spaces in the sidebar. From Claude, ask it to remember something (it calls `save_personal_note`).",
      tags: ["personal", "notes", "claude"],
    },
    {
      title: "Trash and version history",
      area: "knowledge",
      kind: "new",
      description:
        "Deleted articles, findings and whole projects go to the trash: hidden everywhere and restorable. Every published version of an entry is kept; the History page compares versions and restores an old one.",
      how_to: "- **Move to trash…** is in an entry's or project's menu; **Trash** is in the sidebar footer.\n- **History** on an article or finding shows its versions; pick two to compare, or **Restore version**.\n- People with *Delete permanently* can empty the trash.",
      app_route: "#/trash",
      tags: ["trash", "history", "restore"],
    },
    {
      title: "Review",
      area: "review",
      kind: "new",
      description:
        "Agents' and people's writes arrive as proposals. Reviewers see the diff, edit before approving, comment, assign a reviewer, approve or reject several at once, and get a notification (and an email with a one-click approve link) when something waits for them. Secrets and personal data are redacted before anything is stored.",
      how_to: "1. Open **Review** in the sidebar; the count shows what waits for you.\n2. Filter by project, category, author or reviewer, then open a proposal.\n3. **Approve**, edit it first (**e**, then **Approve with my edits**) or **Reject…** with a reason. In the queue, `j`/`k` move and `a` approves.",
      app_route: "#/review",
      tags: ["review", "proposals", "approve"],
    },
    {
      title: "Publish without review",
      area: "review",
      kind: "new",
      audience: "project_admins",
      description:
        "People with **Publish directly** in a project (Project admins, by default) publish their own new entries and edits at once, from the app and from Claude. Anyone can still ask for a review.",
      how_to: "Write as usual: where you may publish, your entry goes live as soon as you save it. From Claude, pass `request_review: true` to have someone check it anyway. *Publish directly* can be switched on for other project roles on **Roles and access**.",
      app_route: "#/roles",
      tags: ["publish", "review", "roles"],
    },
    {
      title: "Notifications and watches",
      area: "review",
      kind: "new",
      description:
        "An in-app bell for reviews, decisions, comments, changes to contracts your project uses, entries you watch and entries that need re-checking, with email per type (SMTP) and an optional team Slack channel. A weekly digest sums things up.",
      how_to: "Click the bell in the top bar. **Watch** an article, finding or project from its menu. Choose which emails you get on **Account › Notifications**.",
      app_route: "#/account?section=notifications",
      tags: ["notifications", "email", "slack", "digest"],
    },
    {
      title: "Security: vulnerabilities and scans",
      area: "security",
      kind: "new",
      description:
        "A vulnerability register per project: lockfiles uploaded by Claude or CI are matched against OSV.dev and re-checked daily, actively exploited ones (CISA KEV) are flagged, and critical ones notify the project. Claude Code scans any repository with the `security-check` prompt and records what it reviewed. The Security page has trends, repositories, packages, coverage and a filterable list.",
      how_to: "- Open **Security** in the sidebar for the dashboard and the list.\n- In Claude Code, run `/mcp__thaliyola__security-check full` in a repository.\n- Details are for the project's Contributors and Project admins, Security leads and Administrators; others see counts.",
      app_route: "#/security",
      tags: ["security", "vulnerabilities", "osv", "scan"],
    },
    {
      title: "Team sources and the inbox",
      area: "inbox",
      kind: "new",
      description:
        "RSS and Atom feeds, watched web pages, Hacker News searches, Slack channel threads, Notion pages and web searches are fetched on a schedule into an inbox. Triage them yourself or let Claude do it: capture what matters as a draft, dismiss the rest.",
      how_to: "1. **Inbox › Sources** (or open `#/sources`) and **Add source**; preview it before saving.\n2. New items show in **Inbox**: **Create draft** (or **Draft a finding now**), file it, or **Dismiss** it.\n3. In Claude, run the `triage-inbox` prompt to go through them.",
      app_route: "#/inbox",
      tags: ["inbox", "sources", "feeds", "slack", "notion"],
    },
    {
      title: "Projects, repositories and teams",
      area: "projects",
      kind: "new",
      description:
        "Projects with any number of repositories (sessions find their project from the git remote), a starter pack, their own settings and members, members-only or open to everyone. Teams are groups of people that get roles on many projects at once; their leads choose the members and can start projects for the team.",
      how_to: "- **New › New project** to create one with its repositories (or request one if you can't create projects).\n- A project's **Settings** has General, Members and access, and Repositories.\n- **Teams** under Explore lists teams and their projects.",
      app_route: "#/new/project",
      tags: ["projects", "repositories", "teams"],
    },
    {
      title: "Sub-projects",
      area: "projects",
      kind: "new",
      description: "Projects nest: a product has a sub-project per service or app. Roles flow down to sub-projects, and searching inside a project covers the projects above and below it.",
      how_to: "On a project page, **New › New sub-project of …**, or choose a parent when creating a project. Move a project under another in its settings (or `set_project_parent` from Claude).",
      app_route: "#/new/project",
      tags: ["projects", "sub-projects", "hierarchy"],
    },
    {
      title: "Roles and access",
      area: "people",
      kind: "new",
      description:
        "Project roles (Viewer, Stakeholder, QA, Contributor, Reviewer, Moderator, Project admin and custom ones) decide what someone can do in a project and the projects under it; organisation roles (Administrator, User manager, Project creator, Team manager, Security lead, Auditor and custom ones) are jobs across Thaliyola. People and teams hold several, permissions add up, and nobody gives away permissions they don't hold. Anyone's access page shows every role and where it comes from.",
      how_to: "- **Roles and access** (account menu) explains every role and who has it.\n- Give project roles in the project's **Settings › Members and access**; organisation roles on **Admin › People**.\n- **Account › Your access** shows your own.",
      app_route: "#/roles",
      tags: ["roles", "permissions", "access", "teams"],
    },
    {
      title: "New people, approval and adding people by email",
      area: "people",
      kind: "new",
      audience: "admins",
      description:
        "New accounts wait until a User manager or an Administrator approves them, each person has one account however they sign in, and people with Manage people add someone by email so they're in from their first sign-in, optionally with project roles. Email invitations with a one-time link work for local sign-in.",
      how_to: "Open **Admin › People**: approve or decline who's waiting, **Add people** by email, and disable or re-enable accounts.",
      app_route: "#/admin/users",
      tags: ["people", "approval", "invitations"],
    },
    {
      title: "Service accounts",
      area: "people",
      kind: "new",
      audience: "admins",
      description: "Identities for CI jobs, bots and other systems: each has its own project roles and API tokens, separate from any person, so nothing breaks when someone leaves.",
      how_to: "1. **Admin › Service accounts › New service account**.\n2. Give it project roles, then **New token** and copy the token (shown once).\n3. Use it as a Bearer token for `/api` and `/mcp`.",
      app_route: "#/admin/service-accounts",
      tags: ["service-accounts", "tokens", "ci"],
    },
    {
      title: "System settings",
      area: "admin",
      kind: "new",
      audience: "admins",
      description:
        "Administrators change settings without a restart: approval of new people, new projects' visibility, session length, duplicate and search thresholds, search history, the Slack webhook, the email sender and the weekly digest time. Every server picks a change up within 30 seconds. The page also shows the installation's fixed setup and counts.",
      how_to: "Open **Admin › System**, change a setting and **Save**. **Reset to default** goes back to the environment's value.",
      app_route: "#/admin/system",
      tags: ["settings", "admin"],
    },
    {
      title: "Metrics and searches with no answer",
      area: "admin",
      kind: "new",
      description:
        "How the knowledge base is used: searches answered, reuse, review time, repeat problems, unowned and stale entries. People with See usage also see what people searched for and found nothing, to write it up.",
      how_to: "Open **Metrics** under Explore. Administrators and Auditors see **Searches with no answer** there and in the weekly digest.",
      app_route: "#/metrics",
      tags: ["metrics", "usage", "gaps"],
    },
    {
      title: "Connect Claude and other agents",
      area: "mcp",
      kind: "new",
      description:
        "Thaliyola is an MCP server. Claude Code, claude.ai (OAuth connector) and other agents (Codex, Gemini CLI, Copilot CLI, VS Code, Cursor, Windsurf, OpenCode, Kiro) search, read and propose through it; every write is reviewed or published by the rules of the project. `connect.sh` installs it for every agent on a machine.",
      how_to: "Open **Connect Claude** in the sidebar footer: create a token and copy the setup for your agent, or run the one-line install shown there.",
      app_route: "#/connect",
      tags: ["mcp", "claude", "connector", "agents"],
    },
    {
      title: "Repository documentation by Claude",
      area: "mcp",
      kind: "new",
      description:
        "Claude documents a repository page by page, every fact backed by the lines it came from. Later commits mark exactly the facts to re-check, CI can keep the docs current on every merge, and a managed AGENTS.md block points agents at the project.",
      how_to: "In Claude Code, run the `document-repo` prompt (first time) or `update-docs` (after changes) in the repository. Project **Settings › Documentation** has instructions, ignore rules and recent runs; the Connect page has CI templates.",
      tags: ["documentation", "claims", "ci"],
    },
    {
      title: "Curation by Claude",
      area: "mcp",
      kind: "new",
      description:
        "Thaliyola hands judgment work to your Claude: misfiled entries, missing repositories, duplicates, recurring problems, empty outlines, stale entries and unanswered searches. Claude proposes the fixes; reviewers decide.",
      how_to: "Ask Claude to tidy the knowledge base (the `curate` prompt). **Review › Suggestions** shows the queue.",
      app_route: "#/review?tab=suggestions",
      tags: ["curation", "tasks", "claude"],
    },
    {
      title: "Reading PDF attachments",
      area: "mcp",
      kind: "new",
      description: "Claude reads attached PDFs (reports, audits, exports) through `get_asset`: text page by page for long ones, and a scanned PDF's pages as images.",
      how_to: "Attach a PDF to an article or finding, then ask Claude about it. Long PDFs arrive in parts; for scans Claude asks for `as: \"images\"`.",
      tags: ["pdf", "assets", "claude"],
    },
    {
      title: "The redesigned app",
      area: "platform",
      kind: "improved",
      description:
        "One component kit for every page, plain words throughout (Help › What the words mean), full dark mode, a sidebar with Explore and footer groups, Admin tabs, and a phone layout with a tab bar, a create sheet and full-screen search. Installable as a web app.",
      how_to: "Switch the theme in the account menu. On a phone, add Thaliyola to your home screen. Press **?** for keyboard shortcuts.",
      tags: ["design", "mobile", "dark-mode"],
    },
  ],
};

const V100: SeedRelease = {
  version: "1.0.0",
  title: "Names, the audit log and deploys without downtime",
  summary:
    "The first numbered release: connections to your databases, APIs, repositories, Slack, Trello, Jira and Linear, Claude skills for each role, names everywhere, an audit log, safer tokens, faster review, Claude doing more of the admin work, deploys without downtime, the worldwide security feed, and release notes like these.\n\nDrafted from CHANGELOG.md's *Unreleased* section.",
  released_on: null,
  status: "draft",
  source: "changelog",
  placeholders: true,
  features: [
    {
      title: "Display names",
      area: "people",
      kind: "new",
      description:
        "Everyone has a name, not just an email: in people lists, review, comments, notifications, owners and authors. Set your own; people with Manage people set anyone's. Behind Cloudflare Access a name in the sign-in fills in an empty one. Names can't pass for someone else (lookalike letters and other people's emails are refused), and reviewers see the author's email next to the name.",
      how_to: "Open **Account** and choose **Add your name** (or **Change name**). Administrators and User managers rename someone from **Admin › People** (the row's menu). From Claude: `set_my_name`.",
      app_route: "#/account",
      tags: ["names", "people", "account"],
    },
    {
      title: "Audit log",
      area: "admin",
      kind: "new",
      audience: "admins",
      description:
        "Who did what to what, and when: role and account changes, team membership, approvals, project requests, service accounts and tokens, apps, system settings, purges, content and review, with readable actions, linked targets and details (never secrets).",
      how_to: "Open **Admin › Audit log** (Administrators and Auditors). Filter by person, action, target and dates; the filters stay in the link. **Download CSV** for the filtered list. From Claude: `list_audit_log`.",
      app_route: "#/admin/audit",
      tags: ["audit", "compliance", "admin"],
    },
    {
      title: "Token hygiene",
      area: "people",
      kind: "new",
      description:
        "**Rotate** a personal or service-account token: same name and lifetime, the new one shown once, and the old one keeps working for none, 1 or 7 days. Owners get a notice a week before a token expires (Manage people, for service accounts), and tokens unused for 90 days are flagged.",
      how_to: "**Account › API tokens and apps**: a token's menu has **Rotate…**. Service accounts' tokens are on **Admin › Service accounts**.",
      app_route: "#/account?section=tokens",
      tags: ["tokens", "security", "rotation"],
    },
    {
      title: "Split view and saved views",
      area: "review",
      kind: "new",
      description:
        "On wide screens (1280px and up) Review and the Inbox show the chosen row in a pane beside the list, with its actions. Save the filters you use as a named view on Review, Inbox, Security and Admin › Projects, and make one your default.",
      how_to: "- Open **Review** or **Inbox** on a wide screen and click a row, or move with `j`/`k`.\n- Set filters, then **Views › Save view**. **Manage views** renames, deletes or sets the default.",
      app_route: "#/review",
      tags: ["review", "inbox", "views", "filters"],
    },
    {
      title: "Project switcher and searchable project pickers",
      area: "projects",
      kind: "improved",
      description: "The project name in a page's crumbs switches to another project and keeps you in the same section. Wherever you choose a project, the picker is searchable and shows where each sits.",
      how_to: "On any project page, click the project in the crumbs and type to find another.",
      tags: ["projects", "navigation"],
    },
    {
      title: "Writing guide beside the editors",
      area: "knowledge",
      kind: "new",
      description: "The article and finding editors show what each section of the type is for and a checklist, so entries come out complete. Claude gets the same guidance from `get_article_template`.",
      how_to: "Start a **New article** or **New finding**; the guide is beside the editor. **Writing guide** in the editor's header shows or hides it.",
      app_route: "#/new/article",
      tags: ["editor", "templates", "writing"],
    },
    {
      title: "Confirming an overdue article clears its review date",
      area: "review",
      kind: "improved",
      description: "When someone with Review in the project confirms an overdue article is still accurate in the app, its review date moves 180 days on, so the *Review overdue* flag goes away too.",
      how_to: "On an article flagged **Review overdue**, choose **Confirm still accurate**.",
      tags: ["freshness", "review"],
    },
    {
      title: "System presets",
      area: "admin",
      kind: "new",
      audience: "admins",
      description: "Set a whole policy in one go: **Looser**, **Default** or **Stricter**. Each lists exactly which settings it changes, from what to what, before you apply it; settings outside the preset are never touched.",
      how_to: "Open **Admin › System**: the presets are at the top. Read what each would change, then **Apply…**.",
      app_route: "#/admin/system",
      tags: ["settings", "presets", "admin"],
    },
    {
      title: "Admin work from Claude",
      area: "mcp",
      kind: "new",
      description:
        "Jobs that were only in the web app now work from Claude: start a project for a team (`create_project` with `team`), disable or re-enable an account (`set_account_status`), and list and decide project requests (`list_project_requests`, `decide_project_request`). Results name people, teams and roles.",
      how_to: "Ask Claude, e.g. \"create a project for the Payments team\" or \"approve the request for quilleaf\". It uses your permissions; nobody gets more through Claude.",
      tags: ["mcp", "admin", "projects", "people"],
    },
    {
      title: "Latest critical vulnerabilities worldwide",
      area: "security",
      kind: "new",
      description:
        "NVD, GitHub advisories and CISA's actively exploited list every 6 hours, merged by CVE and matched to your projects by technology and package. Affected projects are notified and record a response; Security leads publish named alerts that fold matching CVEs under them. The feed opens on **Major**: critical issues in widely used technologies, actively exploited ones, and anything affecting your projects.",
      how_to: "Open **Security › Advisories**. Record your project's response on an advisory; Security leads use **Publish an advisory**. From Claude: `latest_advisories`, `set_advisory_response`.",
      app_route: "#/security?view=advisories",
      tags: ["security", "advisories", "cve"],
    },
    {
      title: "Each repository's stack, detected",
      area: "security",
      kind: "improved",
      description: "Repositories' languages are read daily from GitHub or GitLab, and GitHub's dependency graph feeds the OSV matching, so projects are matched to advisories without tagging them by hand.",
      how_to: "Nothing to do for public repositories. For private ones, an Administrator sets `GITHUB_TOKEN` or `GITLAB_TOKEN` on the server. A project's technologies are in its settings.",
      tags: ["security", "stack", "github", "gitlab"],
    },
    {
      title: "Several replicas and zero-downtime deploys",
      area: "platform",
      kind: "new",
      audience: "admins",
      description:
        "Thaliyola runs as several replicas behind a load balancer: graceful shutdown on SIGTERM, `/readyz` and `/livez` probes, live refresh across replicas, migrations and jobs one replica at a time, and sign-in throttling shared through Postgres.",
      how_to: "See `deploy/k8s/README.md` for the Kubernetes example (probes, `preStop`, grace period, PodDisruptionBudget). Set `ASSET_STORE=s3` and `TRUST_PROXY=1` behind one load balancer.",
      tags: ["deploy", "kubernetes", "replicas"],
    },
    {
      title: "Version numbers and What's new",
      area: "platform",
      kind: "new",
      description:
        "Thaliyola has a version (1.0.0 is the first), shown in **Help › About Thaliyola** and on Admin › System. This page lists every release and every feature with how to use it; publishing a release tells everyone and puts a dot on Help until they've looked. Claude answers \"what changed?\" and \"how do I use X?\" from it (`whats_new`, `list_features`, `get_version`).",
      how_to: "Open **What's new** in the sidebar footer or the Help menu. Administrators and people with *Manage releases* add releases and features here and publish them.",
      app_route: "#/whats-new",
      tags: ["releases", "version", "whats-new"],
    },
    {
      title: "Connections",
      area: "connections",
      kind: "new",
      audience: "project_admins",
      description:
        "Each project connects the systems it runs on: **databases** (PostgreSQL, Amazon Redshift, MySQL, ClickHouse, Snowflake and BigQuery), **HTTP APIs** (with an OpenAPI or Swagger spec), a **GitHub or GitLab token** for its repositories, **Jira and Linear** for tickets, and **Slack channels and Trello lists** for notifications. Secrets are encrypted and never shown again; each connection is tested, synced on a schedule and watched, and its admins hear when it stops working.",
      how_to:
        "1. Open the project, then **Settings › Connections** (Project admins and Administrators).\n2. Choose **Add connection**, pick the kind and fill in the form. Use a read-only database user.\n3. **Test** checks it without changing anything (Slack and Trello post a test message or card), and **Sync now** reads its tables, endpoints or repositories.\n\nThe Team space's Slack and Trello connections are under **Admin › Notifications**. Every change is on the Audit log.",
      tags: ["connections", "databases", "apis", "git", "secrets"],
    },
    {
      title: "Data view, schema changes and lineage",
      area: "connections",
      kind: "new",
      description:
        "A database connection's tables and views become `table` articles, kept in step on every sync. The project's **Data** view lists connections, schemas and tables with columns, keys, what each column means, which hold personal data, schema history and the repositories that **read** or **write** each table. A removed column or a changed type raises an impact notice for the project and for those repositories.",
      how_to:
        "Open a project and choose **Data**. Pick a table to see its columns and history; **Describe** a column to record what it means or that it holds personal data. Under **Used by**, **Add a repository** that reads or writes it. From Claude: `get_table_schema`, `describe_columns`, and `link_entries` with `reads` or `writes`.",
      tags: ["data", "tables", "schema", "lineage", "impact"],
    },
    {
      title: "Read-only queries, API calls and repository files",
      area: "connections",
      kind: "new",
      description:
        "Contributors and their agents run one read-only query at a time on a connection that allows it, with a timeout, a row cap and columns marked as personal data masked; call a connected API through its connection, which adds the credentials (GET by default); and read a file of the project's repositories. Every query, call and read is logged for the project's admins and on the Audit log.",
      how_to:
        "A Project admin turns on **Allow read-only queries** on a database connection. Then ask Claude about the data: it reads the table with `get_table_schema` and runs `query_database`. For APIs it uses `list_api_endpoints` and `call_api`; for code, `read_repo_file`. The `explore-data` prompt walks through it.",
      tags: ["queries", "sql", "apis", "masking", "claude"],
    },
    {
      title: "Tickets in Jira and Linear",
      area: "connections",
      kind: "new",
      description:
        "A finding or article opens an issue in **Jira** (Cloud) or **Linear** with a link back to it, or links an existing issue by its URL. Linked tickets show on the item with the tracker's own status, refreshed in the background, and each issue is linked once per item.",
      how_to:
        "A Project admin adds a Jira or Linear connection under **Settings › Connections**. On a finding or article, choose **Create ticket** in the ⋯ menu, or paste an issue's URL in the **Tickets** card. From Claude: `create_ticket` and `link_ticket`.",
      tags: ["tickets", "jira", "linear"],
    },
    {
      title: "Slack and Trello notifications",
      area: "connections",
      kind: "new",
      audience: "project_admins",
      description:
        "Notification **routes** send chosen kinds of notifications (proposals waiting for review, decisions, comments, stale entries, security alerts and more) to a Slack channel or a Trello list, once per event, with a link back. A project's Slack route can also post a daily or weekly digest.",
      how_to:
        "Add a Slack or Trello connection, then open the project's **Settings › Notifications** and add a route with the kinds it gets. Administrators set up team-wide routes under **Admin › Notifications**.",
      app_route: "#/admin/notifications",
      tags: ["notifications", "slack", "trello", "digest"],
    },
    {
      title: "Skills by role in Claude",
      area: "skills",
      kind: "new",
      description:
        "Administrators and Skills managers publish [Claude skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) (a `SKILL.md` with its references, scripts and assets) in Thaliyola, and give them to everyone, an organisation role, a team, a project (flowing down to the projects under it) or a project role, one skill at a time or a whole collection. Each person gets the skills their roles, teams and projects are given, in Claude Desktop, claude.ai and Claude Code, on Pro plans too. Through the Thaliyola connector, `list_skills` lists yours and `get_skill` loads one when a task matches (`get_skill_file` for the files it mentions); most skills are also slash commands (`skill-<name>` prompts). Project-owned skills stay inside their project.",
      how_to:
        "1. Open **Skills** in the sidebar: **My skills** lists what you have and why.\n2. With the Thaliyola connector added, just ask Claude: it checks `list_skills` before a task and loads the matching skill with `get_skill`.\n3. Skills managers give a skill to people from its page, or a whole collection from an import report.\n4. Something wrong in a skill? Report a problem on its page, or Claude calls `report_skill_problem`.",
      app_route: "#/skills",
      tags: ["skills", "claude", "mcp", "roles"],
    },
    {
      title: "Import skills from git or an archive",
      area: "skills",
      kind: "new",
      audience: "admins",
      description:
        "Import skills from a GitLab or GitHub repository (a branch, tag or commit, through a git connection or a stored token, with **Sync now** and an optional schedule) or from an uploaded `.zip` or `.tar.gz`. Plugin marketplaces, plugins, `skills/<name>` folders and single skills are all read; each plugin becomes a collection with the connectors it needs. Shared guidance in `core/files` and `core/pointers` is stamped into each qualifying skill exactly as the repository's CI does, and front matter and secrets are checked like `validate.py`. Nothing in a skill runs on the server; a skill with a secret, hidden text, a symlink or a path outside it is rejected with the reason. Every import records its commit and has a report: added, changed, rejected, removed and more.",
      how_to:
        "1. Open **Skills › Import skills** (Skills managers and Administrators).\n2. Upload an archive (for example from `git archive`) and preview it, or add a git source with its repository, ref and path.\n3. Choose exclude patterns and which files are for reviewers only (`evals/**`, `tasks/**`), then import.\n4. Read the report; **Give all <plugin> skills to…** assigns a collection in one step. Re-imports only propose versions for skills that changed.",
      app_route: "#/skills/import",
      tags: ["skills", "import", "git", "gitlab", "github", "stamping"],
    },
    {
      title: "Skill review and versions",
      area: "skills",
      kind: "new",
      audience: "admins",
      description:
        "Every change to a skill is a new version that waits for review and is published by a second person: its author, or whoever started the import that proposed it, can't approve it. Reviewers see flags for scripts, pre-approved tools, Thaliyola admin tools, new external addresses and hidden text, with invisible characters made visible, and tick \"I checked\" for the risky ones. **Review this import** approves an import's low-risk versions in one step. Roll back to any earlier published version: that holds the skill so imports don't propose new ones until a reviewer releases it. Usage shows who loaded which version, and every change is on the Audit log.",
      how_to:
        "Open **Review › Skills** for new versions, audience and collection changes and problem reports. On a skill's page, its versions can be compared and rolled back, and **Usage** shows who is on which version. Reviewing needs the *Review skills* permission (Skills managers and Administrators have it).",
      app_route: "#/review?tab=skills",
      tags: ["skills", "review", "versions", "rollback"],
    },
    {
      title: "The Skills for Claude setting and your own switch",
      area: "skills",
      kind: "new",
      description:
        "Administrators choose whether skills reach Claude: **On**, **Administrators only** (a pilot) or **Off**. Off, the skill tools say skills are switched off, skill prompts and downloads go away, the Claude Code sync removes what it installed and Claude's instructions drop the skills guidance; skills can still be written, imported and reviewed. Each person can also switch off **Send my skills to Claude** for themselves. Both take effect at once and are on the Audit log.",
      how_to:
        "Administrators: **Admin › System › Skills for Claude** (or `SKILLS_ENABLED` on the server). Everyone: **Account › Skills for Claude**, then **Send my skills to Claude**.",
      app_route: "#/account?section=skills",
      tags: ["skills", "settings", "opt-out"],
    },
    {
      title: "Add to my Claude and the Claude Code sync",
      area: "skills",
      kind: "new",
      description:
        "Besides the connector, skills reach Claude two more ways. **Add to my Claude** downloads a skill as a zip to upload in Claude's settings, and My skills says when a newer version is published. The **Claude Code sync** writes your skills to `~/.claude/skills/thaliyola-<name>/` and removes the ones you no longer have; it only touches its own `thaliyola-*` folders, checks every path and hash, and can run at the start of every Claude Code session.",
      how_to:
        "**Add to my Claude:** on **Skills › My skills**, choose **Add to my Claude** and upload the zip in Claude's **Settings › Capabilities › Skills**.\n\n**Claude Code:** the **Connect** page gives the one-line install (`connect.sh` with `--skills`), which installs the sync script and offers a SessionStart hook; `--remove-skills` undoes it.",
      app_route: "#/connect",
      tags: ["skills", "download", "claude-code", "sync"],
    },
  ],
};

export const SEED_RELEASES: SeedRelease[] = [V090, V100];

/**
 * Placeholders an earlier starting catalog wrote, and the seed features that replace them. A database seeded before
 * they were written still holds the placeholder; fillSeedPlaceholders swaps it for these features (once: it acts only
 * while the placeholder is there, and never adds a feature the release already has by title). An admin who deleted
 * or rewrote the placeholder is left alone.
 */
export interface SeedPlaceholder {
  version: string;
  /** The placeholder feature as it was seeded: this title and area, tagged "placeholder". */
  title: string;
  area: FeatureArea;
  /** The features of SEED_RELEASES' release for `version` that take its place, in order. */
  replacedBy: string[];
  /** A sentence of the release summary that asked for the placeholder to be filled in; removed with it. */
  summaryNote: string;
}

export const SEED_PLACEHOLDERS: SeedPlaceholder[] = [
  {
    version: "1.0.0",
    title: "Skills",
    area: "skills",
    replacedBy: V100.features.filter((f) => f.area === "skills").map((f) => f.title),
    summaryNote: " **Before publishing:** fill in Skills when its branch merges.",
  },
];
