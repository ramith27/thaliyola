import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchSource, validateConfig, type ConnectorEnv } from "../src/core/connectors.js";

const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Confluence", () => {
  it("imports a space's pages as Markdown, never pages with view restrictions, and remembers where it got to", async () => {
    const calls: string[] = [];
    const env: ConnectorEnv = {
      confluence: { url: "https://acme.atlassian.net", email: "bot@acme.com", token: "t" },
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        calls.push(String(u));
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("bot@acme.com:t").toString("base64")}`);
        return reply({
          results: [
            { id: "1", title: "Deploy runbook", body: { storage: { value: "<h2>Steps</h2><p>Run <code>make deploy</code>.</p>" } }, version: { when: "2026-11-20T10:00:00.000Z", by: { displayName: "Ana" } }, _links: { webui: "/spaces/ENG/pages/1" } },
            { id: "2", title: "Salaries", body: { storage: { value: "<p>secret</p>" } }, version: { when: "2026-11-21T10:00:00.000Z" }, restrictions: { read: { restrictions: { user: { results: [{}] } } } } },
          ],
        });
      }) as typeof fetch,
    };
    const r = await fetchSource("confluence", validateConfig("confluence", { space: "ENG", label: "runbook" }, env), {}, env);
    expect(r.items.map((i) => i.title)).toEqual(["Deploy runbook"]);
    expect(r.items[0]).toMatchObject({ url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1", author: "Ana", body: expect.stringMatching(/## Steps[\s\S]*make deploy/) });
    expect(r.state).toEqual({ since: "2026-11-21T10:00:00.000Z" });
    expect(new URL(calls[0]!).searchParams.get("cql")).toMatch(/space = "ENG" AND type = page AND label = "runbook"/);
    expect(() => validateConfig("confluence", { space: "ENG" }, {})).toThrow(/CONFLUENCE_URL/);
  });
});

describe("Linear", () => {
  const env = (team: Record<string, unknown>): ConnectorEnv => ({ linearKey: "lin_x", fetch: (async () => reply({ data: { teams: { nodes: [team] } } })) as typeof fetch });
  const issue = (id: string, labels: string[]) => ({
    id,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    description: "What happened",
    url: `https://linear.app/acme/issue/ENG-${id}`,
    completedAt: `2026-11-2${id}T00:00:00.000Z`,
    creator: { name: "Bo" },
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: [{ body: "Fixed by retrying", user: { name: "Cy" } }] },
  });
  it("imports completed issues with comments, by label, and refuses private teams", async () => {
    const r = await fetchSource("linear", { team: "ENG", label: "postmortem" }, {}, env({ key: "ENG", private: false, issues: { nodes: [issue("1", ["Postmortem"]), issue("2", ["bug"])] } }));
    expect(r.items.map((i) => i.title)).toEqual(["ENG-1: Issue 1"]);
    expect(r.items[0]!.body).toMatch(/What happened[\s\S]*\*\*Cy:\*\* Fixed by retrying/);
    expect(r.state).toEqual({ since: "2026-11-22T00:00:00.000Z" });
    await expect(fetchSource("linear", { team: "HR" }, {}, env({ key: "HR", private: true, issues: { nodes: [] } }))).rejects.toThrow(/private/);
  });
});

describe("Google Drive", () => {
  it("signs in as the service account and imports the folder's Docs as Markdown", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: "kb@acme.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token" });
    const seen: string[] = [];
    const env: ConnectorEnv = {
      googleServiceAccount: key,
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        const url = String(u);
        seen.push(url);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          expect(String(init?.body)).toMatch(/grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=ey/);
          return reply({ access_token: "ya29.x" });
        }
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ya29.x");
        if (url.includes("/files?")) return reply({ files: [{ id: "doc1", name: "Onboarding", webViewLink: "https://docs.google.com/document/d/doc1", modifiedTime: "2026-11-24T08:00:00.000Z" }] });
        return new Response("# Onboarding\n\nAsk for VPN access first.", { status: 200 });
      }) as typeof fetch,
    };
    const cfg = validateConfig("gdrive", { folder_id: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing" }, env);
    expect(cfg.folder_id).toBe("1AbCdEfGhIjKlMnOp");
    const r = await fetchSource("gdrive", cfg, {}, env);
    expect(r.items).toEqual([expect.objectContaining({ title: "Onboarding", body: expect.stringMatching(/VPN access/) })]);
    expect(new URL(seen[1]!).searchParams.get("q")).toMatch(/'1AbCdEfGhIjKlMnOp' in parents/);
    expect(r.state).toEqual({ since: "2026-11-24T08:00:00.000Z" });
  });
});

describe("Slack, marked threads only", () => {
  it("keeps only threads someone reacted to", async () => {
    const env: ConnectorEnv = {
      slackToken: "xoxb",
      fetch: (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.includes("conversations.history"))
          return reply({ ok: true, messages: [
            { ts: "1.1", text: "Why did checkout fail?", user: "U1", reply_count: 3, reactions: [{ name: "pushpin", count: 1 }] },
            { ts: "2.2", text: "lunch?", user: "U2", reply_count: 5 },
          ] });
        if (url.includes("conversations.replies")) return reply({ ok: true, messages: [{ ts: "1.1", text: "Why did checkout fail?", user: "U1" }, { ts: "1.2", text: "Provider timeout", user: "U2" }] });
        if (url.includes("users.info")) return reply({ ok: true, user: { name: "u" } });
        return reply({ ok: true, permalink: "https://acme.slack.com/archives/C1/p11" });
      }) as typeof fetch,
    };
    const cfg = validateConfig("slack", { channel: "C0123ABCD", reaction: ":pushpin:" }, env);
    expect(cfg.reaction).toBe("pushpin");
    const r = await fetchSource("slack", cfg, {}, env);
    expect(r.items.map((i) => i.title)).toEqual(["Why did checkout fail?"]);
  });
});
