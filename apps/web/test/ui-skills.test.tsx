import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { withSkillCounts } from "../src/components/Layout";
import { PERMISSION_LABELS, SKILL_AUDIENCE, SKILL_FLAG, SKILL_REPORT_SECTION, skillFlagLabel } from "../src/components/labels";
import { CREATE_ACTIONS, navIdForRoute, NAV, visible } from "../src/components/nav";
import { can } from "../src/components/permissions";
import { approveBlockReason, deliveryNotice, fileTree, hasInvisible, parseGlobs, reportCounts, showInvisible, sortFlags, versionLine, type SkillDetail } from "../src/components/skill-utils";
import { FirstReview, FlagList, Overview } from "../src/pages/skill-detail";
import { frontmatterName, ImportReportView, newSkillRequest, SKILL_STARTER, SkillsConnectCard, skillsHeaderActions } from "../src/pages/skills";
import { KitProvider } from "../src/components/kit";
import type { Me } from "../src/api";

/** Skills for Claude in the web app: gates, nav, counts, labels and the reviewer's view of raw text. */

const member = (permissions: string[] = []) => ({ admin: false, permissions });

describe("skills permissions", () => {
  it("gates the catalogue, sources and usage by organisation permission", () => {
    expect(can.manageSkills(member(["manage_skills"]))).toBe(true);
    expect(can.reviewSkills(member(["review_skills"]))).toBe(true);
    expect(can.manageSkills(member(["review_skills"]))).toBe(false);
    expect(can.seeAllSkills(member(["review_skills"]))).toBe(true);
    expect(can.seeAllSkills(member(["read_all_projects", "view_metrics"]))).toBe(true);
    expect(can.seeAllSkills(member(["read_all_projects"]))).toBe(false);
    expect(can.seeAllSkills(member())).toBe(false);
    expect(can.seeSkillUsage(member(["review_skills"]))).toBe(false);
    expect(can.seeSkillUsage(member(["manage_skills"]))).toBe(true);
    expect(can.seeSkillUsage(member(["read_all_projects", "view_metrics"]))).toBe(true);
    expect(can.seeSkillUsage({ admin: true, permissions: [] })).toBe(true);
    expect(PERMISSION_LABELS.manage_skills).toBe("Manage skills");
    expect(PERMISSION_LABELS.review_skills).toBe("Review skills");
  });

  it("shows Skills in the sidebar to everyone and highlights it on skill routes", () => {
    const ctx = { me: { ...member(), auth_mode: "local" }, scopes: [] };
    expect(visible(NAV, ctx).find((n) => n.id === "skills")?.href).toBe("#/skills");
    expect(navIdForRoute("skills")).toBe("skills");
    expect(navIdForRoute("skills/import")).toBe("skills");
    expect(navIdForRoute("skills/0b9c1f8e-1111-4222-8333-444455556666")).toBe("skills");
  });
});

describe("creating skills", () => {
  const scope = (slug: string, perms: string[], status?: string) => ({ slug, kind: "project" as const, can_manage: false, effective_permissions: perms, ...(status ? { status } : {}) });
  const projectAdmin = [scope("orders", ["read", "manage_settings"])];
  const readerOnly = [scope("orders", ["read", "review"])];
  const header = (me: ReturnType<typeof member>, scopes: ReturnType<typeof scope>[]) => {
    const h = skillsHeaderActions(me as unknown as Me, scopes as never, () => {});
    return renderToStaticMarkup(
      <KitProvider>
        {h.primary}
        {h.actions}
        {h.meta}
      </KitProvider>,
    );
  };
  const createIds = (me: ReturnType<typeof member>, scopes: ReturnType<typeof scope>[]) => visible(CREATE_ACTIONS, { me: { ...me, auth_mode: "local" }, scopes }).map((a) => a.id);

  it("lets Skills managers, Administrators and Project admins create, like the server's can.create", () => {
    expect(can.createSkills(member(["manage_skills"]), [])).toBe(true);
    expect(can.createSkills({ admin: true, permissions: [] }, [])).toBe(true);
    expect(can.createSkills(member(), projectAdmin)).toBe(true);
    expect(can.createSkills(member(["review_skills"]), readerOnly)).toBe(false);
    expect(can.createSkills(member(["read_all_projects", "view_metrics"]), [])).toBe(false);
    // An archived project can't own a new skill (the server's createRights wants an active one).
    expect(can.createSkills(member(), [scope("old", ["read", "manage_settings"], "archived")])).toBe(false);
    expect(can.createSkills(member(), [scope("live", ["read", "manage_settings"], "active")])).toBe(true);
  });

  it("puts New skill and Import skills in the Skills page header, on every tab, for the people who may use them", () => {
    const manager = header(member(["manage_skills"]), []);
    expect(manager).toContain("New skill");
    expect(manager).toContain("Import skills");
    expect(manager).toContain('href="#/skills/import"');
    // A Project admin writes their project's own skills here; importing stays with Manage skills.
    const admin = header(member(), projectAdmin);
    expect(admin).toContain("New skill");
    expect(admin).not.toContain("Import skills");
    expect(header(member(["review_skills"]), readerOnly)).toBe(header(member(), []));
    expect(header(member(), [])).not.toMatch(/New skill|Import skills/);
    // Everyone else is told who writes skills, on every tab (the header), not only on an empty My skills.
    expect(header(member(), [])).toContain("Skills managers and Administrators write skills");
    expect(header(member(["manage_skills"]), [])).not.toContain("write skills");
    expect(admin).not.toContain("write skills");
  });

  it("builds the New skill request: a project without Manage skills, clean unique paths, the server's size limits", () => {
    const base = { md: "---\nname: a\n---\n", files: [] as { path: string; text: string }[], collection: "", project: "", summary: "" };
    expect(newSkillRequest({ ...base, orgWide: false })).toEqual({ error: "Choose the project it belongs to", title: "Missing project" });
    expect(newSkillRequest({ ...base, orgWide: true })).toEqual({ body: { skill_md: base.md, files: [], collection: null, project: null, summary: "First version" } });
    const owned = newSkillRequest({ ...base, orgWide: false, project: "orders", collection: "ops", summary: "  v1 ", files: [{ path: " ./references/a.md ", text: "A" }, { path: "scripts/run.sh", text: "#!/bin/sh\n" }] });
    expect(owned).toEqual({
      body: { skill_md: base.md, files: [{ path: "references/a.md", text: "A" }, { path: "scripts/run.sh", text: "#!/bin/sh\n" }], collection: "ops", project: "orders", summary: "v1" },
    });
    const err = (files: { path: string; text: string }[]) => (newSkillRequest({ ...base, orgWide: true, files }) as { title?: string }).title;
    expect(err([{ path: " ", text: "x" }])).toBe("A file has no name");
    expect(err([{ path: "SKILL.md", text: "x" }])).toBe("Two SKILL.md files");
    expect(err([{ path: "a.md", text: "x" }, { path: "./a.md", text: "y" }])).toBe("Duplicate file");
    expect(err([{ path: "big.md", text: "a".repeat(2 * 1024 * 1024 + 1) }])).toBe("File too big");
    expect(err(Array.from({ length: 6 }, (_, i) => ({ path: `r${i}.md`, text: "a".repeat(2 * 1024 * 1024 - 10) })))).toBe("Skill too big");
  });

  it("offers New skill in the Create menu behind the same check, opening the dialog on the Skills page", () => {
    const ctx = { me: { ...member(["manage_skills"]), auth_mode: "local" }, scopes: [] };
    const action = visible(CREATE_ACTIONS, ctx).find((a) => a.id === "skill");
    expect(action?.label(ctx)).toBe("New skill");
    expect(action?.href(ctx)).toBe("#/skills?new=1");
    expect(createIds(member(), projectAdmin)).toContain("skill");
    expect(createIds(member(), readerOnly)).not.toContain("skill");
    expect(createIds(member(["review_skills"]), [])).not.toContain("skill");
  });

  it("reads the name from the front matter, and the starter template is a valid skill", () => {
    expect(frontmatterName("---\nname: weekly-report\ndescription: x\n---\n")).toBe("weekly-report");
    expect(frontmatterName("---\nname: 'quoted-name'\n---\n")).toBe("quoted-name");
    expect(frontmatterName("# no front matter")).toBeNull();
    expect(frontmatterName(SKILL_STARTER)).toBe("my-skill");
    expect(SKILL_STARTER).toMatch(/^---\nname: my-skill\ndescription: .{60,500}\n---\n/);
    expect(SKILL_STARTER).not.toMatch(/<[a-z]/i);
  });
});

describe("the Review badge", () => {
  it("adds skill versions and audience changes for reviewers, and leaves proposals alone otherwise", () => {
    expect(withSkillCounts({ toReview: 2, pending: 5 }, null)).toEqual({ toReview: 2, pending: 5 });
    expect(withSkillCounts({ toReview: 2, pending: 5 }, { to_review: 3, pending: 4, feedback: 1 })).toEqual({ toReview: 5, pending: 10, skills: { toReview: 3, pending: 5 } });
  });
});

describe("skill labels", () => {
  it("marks the high-risk flag kinds and orders the report sections", () => {
    expect(Object.entries(SKILL_FLAG).filter(([, f]) => f.high_risk).map(([k]) => k).sort()).toEqual(["admin_tools", "external_url", "hidden_text"]);
    expect(skillFlagLabel("unknown_kind")).toBe("Unknown kind");
    expect(SKILL_REPORT_SECTION.map((s) => s.key).slice(0, 5)).toEqual(["added", "changed", "moved", "rejected", "rejected_before"]);
    expect(Object.keys(SKILL_AUDIENCE)).toEqual(["everyone", "org_role", "team", "project", "project_role"]);
  });
});

describe("skill helpers", () => {
  it("makes invisible and direction-changing characters visible", () => {
    const text = "run​this ‮evil‬ and \u{E0041}tag";
    expect(hasInvisible(text)).toBe(true);
    expect(showInvisible(text)).toBe("run⟨U+200B⟩this ⟨U+202E⟩evil⟨U+202C⟩ and ⟨U+E0041⟩tag");
    expect(hasInvisible("plain text")).toBe(false);
  });

  it("puts high-risk flags first", () => {
    const sorted = sortFlags([
      { kind: "scripts", path: "b.py", message: "", high_risk: false },
      { kind: "hidden_text", path: "z.md", line: 3, message: "", high_risk: true },
      { kind: "scripts", path: "a.py", message: "", high_risk: false },
    ]);
    expect(sorted.map((f) => f.path)).toEqual(["z.md", "a.py", "b.py"]);
  });

  it("explains each delivery state other than on", () => {
    expect(deliveryNotice("on")).toBeNull();
    expect(deliveryNotice("off")?.title).toBe("Skills are switched off by an Administrator");
    expect(deliveryNotice("off", true)?.action).toBe("system");
    expect(deliveryNotice("opted_out")?.action).toBe("account");
    expect(deliveryNotice("admins_only")?.title).toMatch(/piloted by Administrators/);
  });

  it("formats versions, globs, trees and report counts", () => {
    expect(versionLine(7, "3.11.0")).toBe("v7 · 3.11.0 upstream");
    expect(versionLine(null)).toBe("Not published yet");
    expect(parseGlobs("evals/**\n tasks/** , evals/**\n\n")).toEqual(["evals/**", "tasks/**"]);
    const tree = fileTree([{ path: "scripts/run.py" }, { path: "SKILL.md" }, { path: "references/b.md" }, { path: "README.md" }]);
    expect(tree.map((n) => `${"  ".repeat(n.depth)}${n.name}`)).toEqual(["SKILL.md", "README.md", "references", "  b.md", "scripts", "  run.py"]);
    expect(reportCounts({ added: [{ name: "a", version: 1 }], counts: { changed: 4 } }).slice(0, 2)).toEqual([
      { key: "added", n: 1 },
      { key: "changed", n: 4 },
    ]);
  });

  it("tells the author someone else must approve", () => {
    expect(approveBlockReason({ state: "pending", mine: true, can: { approve: false } })).toBe("Someone else must approve this (you proposed it).");
    expect(approveBlockReason({ state: "pending", mine: true, can: { approve: true } })).toBeNull();
    expect(approveBlockReason({ state: "published", mine: true, can: { approve: false } })).toBeNull();
  });
});

describe("skill detail for reviewers", () => {
  const detail = (view: "manager" | "assignee"): SkillDetail => ({
    id: "s1",
    name: "demo",
    status: "active",
    view,
    collection: null,
    requires_connectors: [],
    current: {
      version: 2,
      upstream_version: null,
      description: "Demo",
      frontmatter: { name: "demo" },
      has_scripts: true,
      allowed_tools: "Bash(git:*)",
      source_commit: null,
      published_at: null,
      skill_md: "---\nname: demo\n---\nDo this​ quietly.\n",
      files: [],
      flags: view === "manager" ? [{ kind: "hidden_text", path: "SKILL.md", line: 4, message: "a zero-width space", high_risk: true }] : undefined,
    },
    delivery: { mode: "on", state: "on", message: null },
    assigned: false,
    why: [],
    can: { manage: true, review: true, approve: false, usage: true, report: true },
  });

  it("opens SKILL.md as source for managers, with invisible characters shown and the flag listed", () => {
    const html = renderToStaticMarkup(<Overview s={detail("manager")} />);
    expect(html).toContain("⟨U+200B⟩");
    expect(html).toContain("invisible characters");
    expect(html).toContain("Hidden or invisible text");
    expect(html).toContain("SKILL.md:4");
    expect(html).toContain("Bash(git:*)");
  });

  it("renders the body for assignees", () => {
    const html = renderToStaticMarkup(<Overview s={detail("assignee")} />);
    expect(html).not.toContain("Hidden or invisible text");
    expect(html).toContain("Do this");
  });

  it("shows a new skill's next steps: ask a reviewer (not its author), then give it to people", () => {
    const fresh: SkillDetail = {
      ...detail("manager"),
      current: null,
      owner_project: null,
      versions: [{ version: 1, state: "pending", author: "Maya", mine: true, high_risk_flags: 1 } as never],
      can: { manage: true, review: true, approve: false, approve_hint: "Someone else must approve this (you proposed it)", usage: true, report: true },
    };
    const html = renderToStaticMarkup(
      <KitProvider>
        <Overview s={fresh} />
      </KitProvider>,
    );
    expect(html).toContain("Version 1 waits for review");
    expect(html).toContain("Ask a reviewer");
    expect(html).toContain("Someone with Review skills (Skills managers and Administrators), other than you, approves it");
    expect(html).toContain("1 high-risk flag for the reviewer");
    expect(html).toContain("#/skills/s1?tab=versions&amp;v=1");
    expect(html).toContain("Choose who gets it");
    expect(html).toContain("Copy the link");
    // A reviewer who may approve it is sent straight to it; a project's own skill names its project.
    const reviewer = renderToStaticMarkup(
      <KitProvider>
        <FirstReview s={{ ...fresh, owner_project: { slug: "orders", name: "Orders" }, versions: [{ version: 1, state: "pending", author: "Maya", mine: false, high_risk_flags: 0 } as never], can: { ...fresh.can, approve: true } }} />
      </KitProvider>,
    );
    expect(reviewer).toContain("Review version 1");
    expect(reviewer).toContain("(inside Orders)");
    expect(reviewer).not.toContain("Copy the link");
  });

  it("lists every flag behind a fold after the first ten", () => {
    const flags = Array.from({ length: 12 }, (_, i) => ({ kind: "external_url", path: `f${i}.md`, line: i + 1, message: "links to x.example", high_risk: true }));
    const html = renderToStaticMarkup(<FlagList flags={flags} />);
    expect(html).toContain("12 high-risk flags for reviewers");
    expect(html).toContain("2 more");
  });
});

describe("the Connect page's skills card", () => {
  const me = { admin: false, permissions: [] } as unknown as Me;
  const info = (state: "on" | "off" | "opted_out") => ({
    delivery: state === "off" ? ("off" as const) : ("on" as const),
    state,
    message: null,
    send_to_claude: state !== "opted_out",
    script_url: "https://kb.example/skills-sync.py",
    sync_command: "curl -fsSL https://kb.example/connect.sh | sh -s -- --skills",
    run_command: "python3 ~/.config/thaliyola/skills-sync.py",
    hook_snippet: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "python3 ~/.config/thaliyola/skills-sync.py --quiet" }] }] } },
    folder_example: "~/.claude/skills/thaliyola-jobs-monitor/",
    last_sync_at: null,
  });

  it("shows the three routes, the install command, the hook and the last sync check", () => {
    const html = renderToStaticMarkup(<SkillsConnectCard skills={info("on")} me={me} />);
    expect(html).toContain("list_skills");
    expect(html).toContain("Add to my Claude");
    expect(html).toContain("connect.sh | sh -s -- --skills");
    expect(html).toContain("SessionStart");
    expect(html).toContain("thaliyola-*");
    expect(html).toMatch(/Last sync check: .*never/);
    expect(html).not.toContain("switched off");
  });

  it("says when an Administrator switched skills off, or the person opted out", () => {
    expect(renderToStaticMarkup(<SkillsConnectCard skills={info("off")} me={me} />)).toContain("switched off by an Administrator");
    expect(renderToStaticMarkup(<SkillsConnectCard skills={info("opted_out")} me={me} />)).toContain("Change in Account");
  });
});

describe("the import report", () => {
  it("shows counts, collections with a one-step assignment, and rejections with reasons", () => {
    const html = renderToStaticMarkup(
      <KitProvider>
        <ImportReportView
          manage
          scopes={[]}
          report={{
            source: null,
            commit: "c454aa0deadbeef",
            layout: "marketplace",
            collections: [{ slug: "im-analytics", name: "IM Analytics", created: true, skills: 23, connectors: [{ name: "tableau", type: "http", url: "https://tableau.example/mcp" }] }],
            added: [{ name: "jobs-monitor", collection: "im-analytics", version: 1, high_risk_flags: 1 }],
            unchanged: [{ name: "site-config", version: 1 }],
            rejected: [{ path: "plugins/x/skills/bad", name: "bad", reasons: ["name 'Bad' must equal the folder name 'bad'"] }],
          }}
        />
      </KitProvider>,
    );
    expect(html).toContain("IM Analytics");
    expect(html).toContain("Give all IM Analytics skills to");
    expect(html).toContain("jobs-monitor");
    expect(html).toContain("1 high-risk flag");
    expect(html).toContain("must equal the folder name");
    expect(html).toContain("Rejected");
  });
});
