import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../core/context.js";
import { assertSkillRight, createRights, skillById, skillByName, skillRights, type SkillRow } from "../core/skills/access.js";
import {
  addAssignment,
  AUDIENCES,
  collectionBySlug,
  findAssignment,
  listAssignments,
  listCollectionAssignments,
  mapCollection,
  previewCollectionMappings,
  previewSkillAssignments,
  removeAssignment,
  type AssignmentInput,
  type Audience,
} from "../core/skills/assignments.js";
import { createSkill, proposeSkillVersion, selfApprovalOn, type EditorFile } from "../core/skills/catalog.js";
import { renameInFrontmatter } from "../core/skills/delivery.js";
import { parseFrontmatter } from "../core/skills/frontmatter.js";
import { peopleWith } from "../core/skills/notify.js";
import { SKILL_LIMITS, syncDirOf } from "../core/skills/types.js";
import type { SkillToolRun } from "./skills.js";

/**
 * Pushing skills from Claude: propose_skill (a new skill whose first version waits for review), propose_skill_edit
 * (a new version of one), assign_skill and unassign_skill. They call the web's core functions, so the same people may
 * do the same things with the same limits, checks and audit rows. Nothing here publishes: a second person approves
 * skill versions, in the web app or by asking Claude (skill-review.ts), never the one who proposed them.
 */

const MB = 1024 * 1024;

const fileArg = z.object({
  path: z.string().min(1).max(SKILL_LIMITS.pathChars + 2).describe("Path inside the skill folder, e.g. references/tables.md or scripts/check.py"),
  content: z.string().max(4 * MB).optional().describe("The file's text (UTF-8)"),
  content_base64: z.string().max(6 * MB).optional().describe("A binary file's bytes, base64-encoded (instead of content)"),
});
const filesArg = z
  .array(fileArg)
  .max(SKILL_LIMITS.files + 100)
  .optional()
  .describe("Every other file of the skill folder (references/, scripts/, assets/, files at its root…), with paths relative to the folder; SKILL.md goes in skill_md");

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Claude's files as editor files: text or bytes, never both; SKILL.md travels as skill_md. */
function editorFiles(files: z.infer<typeof fileArg>[] | undefined): EditorFile[] {
  const out: EditorFile[] = [];
  for (const f of files ?? []) {
    // "./references/a.md" is how a folder listing names it; anything else unusual is left for the path checks.
    const path = f.path.replace(/^(\.\/)+/, "");
    if (path === "SKILL.md") throw new ValidationError("send SKILL.md as skill_md, not in files");
    if ((f.content === undefined) === (f.content_base64 === undefined)) throw new ValidationError(`${path}: pass content (text) or content_base64 (binary), one of the two`);
    if (f.content_base64 !== undefined) {
      const b64 = f.content_base64.replace(/\s+/g, "");
      if (!BASE64_RE.test(b64) || b64.length % 4 === 1) throw new ValidationError(`${path}: content_base64 isn't valid base64`);
      out.push({ path, data: new Uint8Array(Buffer.from(b64, "base64")) });
    } else out.push({ path, text: f.content });
  }
  return out;
}

function requireFrontmatter(md: string) {
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(md)) {
    throw new ValidationError(
      "SKILL.md must start with front matter, e.g.\n---\nname: my-skill\ndescription: What the skill does and when Claude should use it.\n---\nThe name (lowercase letters, digits and single hyphens) becomes the skill's name.",
    );
  }
}

/** The marker file the Claude Code sync writes into each thaliyola-<name> folder it installs. */
const SYNC_MARKER = ".thaliyola-skill.json";

/** Leaves out the sync's marker file, which isn't part of the skill; says whether there was one. */
function withoutSyncMarker(files: EditorFile[]): { files: EditorFile[]; marker: boolean } {
  const kept = files.filter((f) => f.path !== SYNC_MARKER);
  return { files: kept, marker: kept.length !== files.length };
}

/** SKILL.md's front-matter name, or null (validation reports a missing or bad one with the other problems). */
function nameIn(md: string): string | null {
  const [meta] = parseFrontmatter(md);
  return meta && typeof meta.name === "string" ? meta.name.trim() : null;
}

const installedCopyHint = (name: string) =>
  `This is the Claude Code sync's installed copy of the team skill '${name}' (its folder and front-matter name are ${syncDirOf(name)}). ` +
  `To change that skill, call propose_skill_edit with skill '${name}' and the folder's files; the front-matter name may stay ${syncDirOf(name)} (it's set back to ${name}). ` +
  "The sync overwrites edits in that folder, so propose the change before it runs again.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A skill by name or id that the caller can see; anything else is "not found" (owned skills never leak). */
async function findSkill(ctx: RequestContext, ref: string): Promise<SkillRow> {
  const r = ref.trim();
  const skill = UUID_RE.test(r) ? await skillById(ctx.db, r) : await skillByName(ctx.db, r);
  if (!skill || !(await skillRights(ctx, skill)).see) throw new NotFoundError(`skill '${r}'`, `no skill '${r}' that you manage; the Skills page (All skills) lists them`);
  return skill;
}

/** The skill's page: absolute with PUBLIC_URL, else the app's own hash route. */
const appLink = (ctx: RequestContext, id: string) => (ctx.settings.publicUrl ? `${ctx.settings.publicUrl}/#/skills/${id}` : `#/skills/${id}`);

async function projectName(ctx: RequestContext, scopeId: string | null): Promise<{ slug: string; name: string } | null> {
  if (!scopeId) return null;
  return (await ctx.db.query<{ slug: string; name: string }>("SELECT slug, name FROM scopes WHERE id = $1", [scopeId])).rows[0] ?? null;
}

/** Who must approve a version the caller proposed: the rule, and the people who can (other than the caller). */
async function reviewInfo(ctx: RequestContext, ownerScopeId: string | null) {
  const owner = await projectName(ctx, ownerScopeId);
  const selfOk = await selfApprovalOn(ctx);
  const ids = (await peopleWith(ctx.db, ctx.settings, "review_skills", ownerScopeId)).filter((id) => selfOk || id !== ctx.actor.id);
  const { rows } = await ctx.db.query<{ name: string; email: string }>(
    `SELECT coalesce(nullif(display_name, ''), email) AS name, email FROM users WHERE id = ANY ($1::uuid[]) AND kind = 'human' AND disabled_at IS NULL
      ORDER BY lower(coalesce(nullif(display_name, ''), email)) LIMIT 10`,
    [ids],
  );
  const who = owner
    ? `someone${selfOk ? "" : " other than you"} with Review skills (Skills managers and Administrators) who can read ${owner.name}, or a Project admin of ${owner.name}`
    : `someone${selfOk ? "" : " other than you"} with Review skills (Skills managers and Administrators)`;
  return {
    who_reviews: who,
    reviewers: rows.map((r) => (r.name === r.email ? r.email : `${r.name} (${r.email})`)),
    more_reviewers: Math.max(0, ids.length - rows.length),
    how: "Another person approves it: in the Thaliyola web app (Review › Skills, or the link), or by asking their Claude (review_skill_version). The person who proposed it can't approve it.",
    ...(ids.length ? {} : { warning: "Nobody else can review it yet: ask an Administrator to give someone Review skills (or, for a very small team, to let people approve their own skill versions in Admin › System)." }),
  };
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

const flagsOf = (flags: { kind: string; path: string; line?: number; message: string; high_risk: boolean }[]) =>
  flags.slice(0, 50).map((f) => ({ kind: f.kind, where: f.line ? `${f.path}:${f.line}` : f.path, message: f.message, high_risk: f.high_risk }));

const toArg = z
  .enum(AUDIENCES as [Audience, ...Audience[]])
  .describe("everyone; org_role (organisation roles); team; project (that project and the projects under it); project_role (project roles, in project or in any project)");
const targetArgs = {
  skill: z.string().min(1).max(200).optional().describe("The skill's name or id"),
  collection: z.string().min(1).max(64).optional().describe("A collection's slug instead: every skill in it, including ones added later"),
  to: toArg,
  roles: z.array(z.string().min(1).max(100)).max(20).optional().describe("Role names or keys for org_role / project_role (one assignment each), e.g. ['Contributor']"),
  team: z.string().min(1).max(100).optional().describe("Team name or slug, for team"),
  project: z.string().min(1).max(200).optional().describe("Project slug: for project (required), or project_role in that project (omit for any project)"),
};

type TargetArgs = { skill?: string; collection?: string; to: Audience; roles?: string[]; team?: string; project?: string };

/** One assignment input per role, like the web's dialog. */
function inputsOf(a: TargetArgs, owner: { slug: string } | null): AssignmentInput[] {
  const project = a.project?.trim() || (owner && (a.to === "project" || a.to === "project_role") ? owner.slug : undefined);
  if (a.to === "org_role" || a.to === "project_role") {
    if (!a.roles?.length) throw new ValidationError(`to ${a.to} needs roles`);
    return a.roles.map((role) => ({ audience: a.to, role, project: a.to === "project_role" ? (project ?? null) : null }));
  }
  if (a.roles?.length) throw new ValidationError(`roles go with to: org_role or project_role, not ${a.to}`);
  return [{ audience: a.to, team: a.to === "team" ? (a.team ?? null) : null, project: a.to === "project" ? (project ?? null) : null }];
}

async function target(ctx: RequestContext, a: { skill?: string; collection?: string }) {
  if (!!a.skill === !!a.collection) throw new ValidationError("pass skill (a name or id) or collection (a slug), one of the two");
  if (a.skill) {
    const skill = await findSkill(ctx, a.skill);
    return { kind: "skill" as const, skill, owner: await projectName(ctx, skill.owner_scope_id) };
  }
  const c = await collectionBySlug(ctx, a.collection!.trim(), "manage");
  return { kind: "collection" as const, collection: c, owner: await projectName(ctx, c.owner_scope_id) };
}

/** What a skill or collection is given to now, labelled for the caller. */
async function currentAssignments(ctx: RequestContext, t: Awaited<ReturnType<typeof target>>) {
  const list = t.kind === "skill" ? (await listAssignments(ctx, t.skill.id)).assignments : await listCollectionAssignments(ctx, t.collection.id);
  return list.map((a) => ({ id: a.id, label: a.label }));
}

function reachNote(t: Awaited<ReturnType<typeof target>>): string | undefined {
  if (t.kind !== "skill") return undefined;
  if (!t.skill.current_version_id) return "Nobody gets it until a reviewer publishes its first version in the web app.";
  if (t.skill.status !== "active") return `It's ${t.skill.status}, so nobody gets it until it's active again.`;
  return undefined;
}

/** The version waiting for review on a skill, if any, with who proposed it. */
async function waitingVersion(ctx: RequestContext, skillId: string) {
  const { rows } = await ctx.db.query<{ version: number; author_id: string | null; author: string | null; summary: string | null }>(
    `SELECT v.version, v.author_id, coalesce(nullif(u.display_name, ''), u.email) AS author, v.summary
       FROM skill_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.skill_id = $1 AND v.state = 'pending' ORDER BY v.version DESC LIMIT 1`,
    [skillId],
  );
  return rows[0];
}

export function registerSkillAuthoring(server: McpServer, ctx: RequestContext, run: SkillToolRun) {
  server.registerTool(
    "propose_skill",
    {
      title: "Propose a new team skill",
      description:
        "Push a new Claude skill to Thaliyola. It's saved as version 1, waiting for a second person to approve it (in the web app or through their Claude); the user can't approve their own. " +
        "Exception: a Project admin's own skill in their project (pass project) is published at once, like their articles, unless it has high-risk content (hidden text, new scripts, admin tools, new hosts, pre-approved tools) or you pass request_review: true; the result says state \"published\" or why it waits. " +
        "For people who may create skills: Manage skills (Skills managers, Administrators), or Manage settings in a project (Project admins) for that project's own skills (pass project). Only when the user asks. " +
        "To push a local skill folder (Claude Code): read its SKILL.md into skill_md, and every other file in the folder, at its root or in any subfolder, into files with paths relative to the folder (references/tables.md, forms.md, LICENSE.txt); text as content, binary files as content_base64. Leave out dotfiles, .git, node_modules and the sync's .thaliyola-skill.json. " +
        "A thaliyola-<name> folder is the Claude Code sync's installed copy of the team skill <name>: change that skill with propose_skill_edit (skill <name>) instead of creating a new one. " +
        "The name comes from SKILL.md's front matter (name: lowercase letters, digits and single hyphens, new; description: what it does and when to use it). " +
        "Limits: 300 files, 2 MB a file, 10 MB in all (binary files count at their real size, before base64), 200 KB of SKILL.md; no absolute paths, '..' or backslashes. A secret (API key, token, private key, password in a URL) rejects the skill: remove it and send again. " +
        "The result says who must review it and links to it.",
      inputSchema: {
        skill_md: z.string().min(1).max(SKILL_LIMITS.skillMdBytes + 1024).describe("The full SKILL.md, front matter included"),
        files: filesArg,
        collection: z.string().min(1).max(64).optional().describe("A collection (slug) to put it in; a new one is made if needed"),
        project: z.string().min(1).max(200).optional().describe("Make it this project's own skill (only that project's readers see it)"),
        summary: z.string().max(2000).optional().describe("What this version is, for the reviewer (default 'New skill')"),
        request_review: z.boolean().optional().describe("Send it for review even if you may publish your own skills in this project (Project admins publish directly)"),
      },
    },
    (args) =>
      run("propose_skill", async (w) => {
        requireFrontmatter(args.skill_md);
        const { files, marker } = withoutSyncMarker(editorFiles(args.files));
        // An installed sync copy (thaliyola-<name>, with the sync's marker) pushed back is an edit of <name>, not a new skill.
        const name = nameIn(args.skill_md);
        const installed = name?.startsWith("thaliyola-") ? await skillByName(ctx.db, name.slice("thaliyola-".length)) : undefined;
        if (installed && (await skillRights(ctx, installed)).see) throw new ValidationError(installedCopyHint(installed.name));
        if (marker) throw new ValidationError(`This folder is an installed copy made by the Claude Code sync (it has ${SYNC_MARKER}), not a new skill. Change the team skill it came from with propose_skill_edit.`);
        if (!args.project) {
          const cr = await createRights(ctx);
          if (!cr.org) {
            throw new ForbiddenError(
              cr.projects
                ? "organisation-wide skills need Manage skills (Skills managers and Administrators); pass project to make it the own skill of a project you manage"
                : "creating skills needs Manage skills (Skills managers and Administrators), or Manage settings in a project for that project's own skills. Ask one of them to add it, or share the folder with them",
            );
          }
        }
        const r = await createSkill(ctx, { skill_md: args.skill_md, files, collection: args.collection ?? null, project: args.project ?? null, summary: args.summary, request_review: args.request_review });
        w.target = r.id;
        return json({
          id: r.id,
          name: r.name,
          version: r.version,
          state: r.published ? "published" : "waiting for review",
          published: r.published,
          ...(r.message ? { message: r.message } : {}),
          owner_project: await projectName(ctx, r.owner_scope_id),
          collection: r.collection,
          files: r.files.map((f) => f.path),
          flags: flagsOf(r.flags),
          warnings: r.warnings,
          ...(r.published ? {} : { review: await reviewInfo(ctx, r.owner_scope_id) }),
          web_url: appLink(ctx, r.id),
          next_steps: r.published
            ? ["Give it to people: assign_skill (dry_run first), or the skill's Who gets it tab. They get version 1 at once."]
            : [
                "A reviewer opens the link and approves version 1 (they see its files, flags and any scripts).",
                "Give it to people: assign_skill (dry_run first), or the skill's Who gets it tab. They get it once it's published.",
              ],
        });
      }),
  );

  server.registerTool(
    "propose_skill_edit",
    {
      title: "Propose a new version of a team skill",
      description:
        "Propose a new version of an existing skill (by name or id), waiting for a second person to approve it; a Project admin's version of their project's own skill is published at once unless it has high-risk content or request_review is true. Pass the new SKILL.md as skill_md and/or new or changed files (same shape as propose_skill), " +
        "remove_files for paths to delete, and summary (what changed). The edit applies to the published version (before the first is published, to the waiting one): files you don't mention stay as they are there. " +
        "It replaces a version already waiting for review, dropping that version's changes; when someone else proposed it, the call is refused unless replace_waiting is true (say whose work it drops, and ask the user first). " +
        "To push back an installed Claude Code copy (a thaliyola-<name> folder), pass skill <name> and the folder's files; its front-matter name thaliyola-<name> is set back to <name>, and .thaliyola-skill.json is left out. " +
        "A skill imported from a repository is changed there (or detached in the web app first). Needs the same rights as creating it. Only when the user asks.",
      inputSchema: {
        skill: z.string().min(1).max(200).describe("The skill's name or id"),
        skill_md: z.string().min(1).max(SKILL_LIMITS.skillMdBytes + 1024).optional().describe("The full new SKILL.md (front matter included); omit to keep it"),
        files: filesArg,
        remove_files: z.array(z.string().min(1).max(SKILL_LIMITS.pathChars)).max(SKILL_LIMITS.files).optional().describe("Paths to delete, e.g. ['references/old.md']"),
        summary: z.string().min(1).max(2000).describe("What changed, for the reviewer"),
        replace_waiting: z.boolean().optional().describe("Replace a version someone else proposed that's waiting for review (its changes are dropped)"),
        request_review: z.boolean().optional().describe("Send it for review even if you may publish your own skills in this project"),
      },
    },
    (args) =>
      run("propose_skill_edit", async (w) => {
        if (args.skill_md !== undefined) requireFrontmatter(args.skill_md);
        const { files } = withoutSyncMarker(editorFiles(args.files));
        if (args.skill_md === undefined && !files.length && !args.remove_files?.length) throw new ValidationError("nothing to change: pass skill_md, files or remove_files");
        const skill = await findSkill(ctx, args.skill);
        w.target = skill.id;
        // The sync names installed copies thaliyola-<name>; the skill itself is <name>.
        let skillMd = args.skill_md;
        const renamed = skillMd !== undefined && nameIn(skillMd) === syncDirOf(skill.name);
        if (renamed) skillMd = renameInFrontmatter(skillMd!, skill.name);
        // Rights first, so whose version waits is told only to people who may change the skill.
        await assertSkillRight(ctx, skill.id, "manage");
        const waiting = await waitingVersion(ctx, skill.id);
        // Before the first version is published the edit builds on the waiting one, so nothing is dropped.
        if (waiting && skill.current_version_id && waiting.author_id !== ctx.actor.id && !args.replace_waiting) {
          throw new ValidationError(
            `version ${waiting.version} of ${skill.name}, proposed by ${waiting.author ?? "someone else"}${waiting.summary ? ` ("${waiting.summary}")` : ""}, is waiting for review. ` +
              "Your edit applies to the published version and would replace it, dropping its changes. Ask them or a reviewer first; to replace it anyway, pass replace_waiting: true.",
          );
        }
        const r = await proposeSkillVersion(ctx, skill.id, { skill_md: skillMd, files, remove_files: args.remove_files, summary: args.summary, request_review: args.request_review });
        return json({
          id: r.id,
          name: r.name,
          version: r.version,
          state: r.published ? "published" : "waiting for review",
          published: r.published,
          ...(r.message ? { message: r.message } : {}),
          replaced_waiting_version: r.superseded,
          ...(r.superseded && waiting ? { replaced: { version: waiting.version, author: waiting.author, summary: waiting.summary } } : {}),
          ...(renamed ? { note: `The front-matter name ${syncDirOf(skill.name)} (the installed copy's) was set back to ${skill.name}.` } : {}),
          files: r.files.map((f) => f.path),
          flags: flagsOf(r.flags),
          warnings: r.warnings,
          ...(r.published ? {} : { review: await reviewInfo(ctx, r.owner_scope_id) }),
          web_url: `${appLink(ctx, r.id)}?tab=versions&v=${r.version}`,
        });
      }),
  );

  server.registerTool(
    "assign_skill",
    {
      title: "Give a team skill to people",
      description:
        "Give a skill (name or id) or every skill of a collection (slug; skills added later too) to people: to everyone, org_role (roles), team, project (that project and the projects under it) or project_role (roles, in project or in any project). " +
        "Several roles add one assignment each. Pass dry_run: true first: it saves nothing and says how many people would newly get it. " +
        "Needs Manage skills, or Manage settings in the project for a project's own skill, which only goes to that project and the projects under it. " +
        "People get a skill once its first version is published. Moving a skill to another collection is done in the web app (it can need a review). Only when the user asks.",
      inputSchema: { ...targetArgs, dry_run: z.boolean().optional().describe("Show who would gain it, without saving") },
    },
    (args) =>
      run("assign_skill", async (w) => {
        const t = await target(ctx, args);
        const inputs = inputsOf(args, t.owner);
        if (args.dry_run) w.tool = "preview_skill_assignment";
        w.target = t.kind === "skill" ? t.skill.id : t.collection.id;
        const results: { label: string; created?: boolean; already?: boolean; gains: { people: number; audiences: string[] } }[] = [];
        // Every input is checked, and who it newly reaches counted (each person once, across all of them), before
        // anything is saved.
        const preview = t.kind === "skill" ? await previewSkillAssignments(ctx, t.skill.id, inputs) : await previewCollectionMappings(ctx, t.collection.slug, inputs);
        let people = preview.people;
        if (args.dry_run) {
          for (const row of preview.rows) results.push(row);
        } else if (t.kind === "skill") {
          for (const [i, input] of inputs.entries()) {
            const added = await addAssignment(ctx, t.skill.id, input);
            results.push({ label: added.assignment.label, created: added.created, gains: added.created ? preview.rows[i]!.gains : { people: 0, audiences: [] } });
          }
          people = results.reduce((n, r) => n + r.gains.people, 0);
        } else {
          // Each mapping counts who it adds on top of the ones saved before it, so the sum counts everyone once.
          for (const input of inputs) {
            const m = await mapCollection(ctx, t.collection.slug, input);
            if ("assignment" in m && m.assignment) results.push({ label: m.assignment.label, created: m.created, gains: m.gains });
          }
          people = results.reduce((n, r) => n + r.gains.people, 0);
        }
        return json({
          ...(args.dry_run ? { dry_run: true, nothing_saved: true } : {}),
          ...(t.kind === "skill" ? { skill: { id: t.skill.id, name: t.skill.name } } : { collection: { slug: t.collection.slug, name: t.collection.name } }),
          results,
          people_gaining: people,
          ...(inputs.length > 1 ? { people_gaining_note: "Each person counts once: a row counts only the people it adds beyond what they have and the rows above it." } : {}),
          ...(args.dry_run ? {} : { assignments: await currentAssignments(ctx, t) }),
          note: reachNote(t),
          web_url: t.kind === "skill" ? `${appLink(ctx, t.skill.id)}?tab=assignments` : `${ctx.settings.publicUrl ? `${ctx.settings.publicUrl}/` : ""}#/skills?tab=all&collection=${encodeURIComponent(t.collection.slug)}`,
        });
      }),
  );

  server.registerTool(
    "unassign_skill",
    {
      title: "Take a team skill away from people",
      description:
        "Take a skill (name or id) or collection (slug) away from people: pass the same to / roles / team / project it was given with, or assignment_id. " +
        "With neither, lists the current assignments and changes nothing. People keep it while another assignment still gives it to them. Needs the same rights as assign_skill. Only when the user asks.",
      inputSchema: {
        skill: targetArgs.skill,
        collection: targetArgs.collection,
        assignment_id: z.string().uuid().optional().describe("An assignment's id, as assign_skill or this tool lists them"),
        to: toArg.optional(),
        roles: targetArgs.roles,
        team: targetArgs.team,
        project: targetArgs.project,
      },
    },
    (args) =>
      run("unassign_skill", async (w) => {
        const t = await target(ctx, args);
        w.target = t.kind === "skill" ? t.skill.id : t.collection.id;
        const before = await currentAssignments(ctx, t);
        let ids: string[];
        if (args.assignment_id) {
          if (!before.some((a) => a.id === args.assignment_id)) throw new NotFoundError("assignment", `that assignment isn't one of ${t.kind === "skill" ? t.skill.name : t.collection.name}'s; current: ${JSON.stringify(before)}`);
          ids = [args.assignment_id];
        } else if (args.to) {
          const on = t.kind === "skill" ? { skill_id: t.skill.id } : { collection_id: t.collection.id };
          const ownerId = t.kind === "skill" ? t.skill.owner_scope_id : t.collection.owner_scope_id;
          ids = [];
          for (const input of inputsOf({ ...args, to: args.to }, t.owner)) {
            const id = await findAssignment(ctx, on, ownerId, input);
            if (id) ids.push(id);
          }
          if (!ids.length) throw new NotFoundError("assignment", `no such assignment; current: ${JSON.stringify(before)}`);
        } else {
          w.tool = "list_skill_assignments";
          return json({ ...(t.kind === "skill" ? { skill: { id: t.skill.id, name: t.skill.name } } : { collection: { slug: t.collection.slug, name: t.collection.name } }), assignments: before, changed: false });
        }
        const removed: string[] = [];
        for (const id of ids) removed.push((await removeAssignment(ctx, id)).assignment.label);
        return json({
          ...(t.kind === "skill" ? { skill: { id: t.skill.id, name: t.skill.name } } : { collection: { slug: t.collection.slug, name: t.collection.name } }),
          removed,
          assignments: await currentAssignments(ctx, t),
        });
      }),
  );
}
