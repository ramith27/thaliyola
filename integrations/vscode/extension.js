// Thaliyola for VS Code: a side panel (Explorer › Thaliyola) with what the team knows about the open file, from
// GET /api/files/knowledge. Lines that documented facts cite are marked, with the fact on hover. The token (a
// personal API token from Thaliyola's Account page) is kept in VS Code's secret storage.
const vscode = require("vscode");
const { execFile } = require("node:child_process");
const path = require("node:path");

const git = (cwd, args) =>
  new Promise((resolve) => execFile("git", args, { cwd, timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim())));

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const provider = new KnowledgeProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("thaliyola.file", provider),
    vscode.commands.registerCommand("thaliyola.refresh", () => provider.load(vscode.window.activeTextEditor, true)),
    vscode.commands.registerCommand("thaliyola.setToken", async () => {
      const token = await vscode.window.showInputBox({ prompt: "Thaliyola personal API token (Account › API tokens)", password: true, ignoreFocusOut: true });
      if (token) {
        await context.secrets.store("thaliyola.token", token.trim());
        provider.load(vscode.window.activeTextEditor, true);
      }
    }),
    vscode.commands.registerCommand("thaliyola.open", (url) => vscode.env.openExternal(vscode.Uri.parse(url))),
    vscode.window.onDidChangeActiveTextEditor((e) => provider.load(e)),
    vscode.workspace.onDidSaveTextDocument(() => provider.load(vscode.window.activeTextEditor, true)),
    provider.decoration,
  );
  provider.load(vscode.window.activeTextEditor);
}

class KnowledgeProvider {
  constructor(context) {
    this.context = context;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.state = { message: "Open a file in a repository that's part of a Thaliyola project." };
    this.cache = new Map();
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorInfo.foreground"),
    });
  }

  base() {
    return (vscode.workspace.getConfiguration("thaliyola").get("url") || "").replace(/\/+$/, "");
  }

  async load(editor, force = false) {
    if (!editor || editor.document.uri.scheme !== "file") return;
    const file = editor.document.uri.fsPath;
    const base = this.base();
    const token = await this.context.secrets.get("thaliyola.token");
    if (!base || !token) return this.show({ message: "Set thaliyola.url in Settings and run “Thaliyola: Set access token”." });
    const root = await git(path.dirname(file), ["rev-parse", "--show-toplevel"]);
    const remote = root && (await git(root, ["remote", "get-url", "origin"]));
    if (!root || !remote) return this.show({ message: "This file isn't in a git repository with an origin remote." });
    const rel = path.relative(root, file).split(path.sep).join("/");
    const key = `${remote}#${rel}`;
    if (!force && this.cache.has(key)) return this.show(this.cache.get(key), editor);
    try {
      const res = await fetch(`${base}/api/files/knowledge?${new URLSearchParams({ repo: remote, path: rel })}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return this.show({ message: `Thaliyola answered ${res.status}${res.status === 401 ? ": check the token" : ""}.` });
      const data = await res.json();
      const state = data.known ? { data, base } : { message: data.note };
      this.cache.set(key, state);
      this.show(state, editor);
    } catch (err) {
      this.show({ message: `Couldn't reach Thaliyola: ${err.message}` });
    }
  }

  show(state, editor) {
    this.state = state;
    this.changed.fire();
    if (editor && vscode.workspace.getConfiguration("thaliyola").get("highlightFacts")) {
      const facts = state.data?.facts?.filter((f) => f.start) ?? [];
      editor.setDecorations(
        this.decoration,
        facts.map((f) => ({
          range: new vscode.Range(Math.max(f.start - 1, 0), 0, Math.max((f.end || f.start) - 1, 0), 0),
          hoverMessage: new vscode.MarkdownString(`**Documented** in *${f.article}*${f.status === "stale" ? " (no longer matches the code)" : ""}:\n\n${f.text}`),
        })),
      );
    }
  }

  getTreeItem(item) {
    return item;
  }

  getChildren(parent) {
    if (parent) return parent.children ?? [];
    const s = this.state;
    if (!s.data) return [leaf(s.message, "info")];
    const d = s.data;
    const b = d.briefing;
    const link = (p) => `${s.base}/#${p}`;
    const groups = [
      group("Rules for agents", "law", d.rules.map((r) => leaf(`${r.kind.replace("_", " ")}: ${r.message}`, r.kind === "never_edit" ? "error" : "warning", r.read_first ? link(`/article/${r.read_first.id}`) : null))),
      group("Documented facts", "book", d.facts.map((f) => leaf(`${f.start ? `L${f.start}${f.end && f.end !== f.start ? `-${f.end}` : ""} ` : ""}${f.text}`, f.status === "stale" ? "warning" : "pass", link(`/article/${f.article_id}`), f.article))),
      group("Docs", "file-text", b.docs.map((x) => leaf(x.title, "file", link(`/article/${x.article_id}`)))),
      group("Contracts", "plug", b.contracts.map((x) => leaf(x.title, "plug", link(`/article/${x.article_id}`), x.consumers.map((c) => c.project).join(", ")))),
      group("Known issues", "bug", b.known_issues.map((x) => leaf(x.title, "bug", link(`/finding/${x.finding_id}`)))),
      group("Vulnerabilities", "shield", b.vulnerabilities.map((x) => leaf(`${x.severity}: ${x.title}`, "shield", link(`/security/${x.id}`)))),
      group("Also working here", "person", b.working_here.map((x) => leaf(`${x.session} (${x.owner})`, "person"))),
    ].filter(Boolean);
    return [leaf(`${d.project_name} › ${d.repository}`, "repo", link(`/project/${d.project}`), d.path), ...(groups.length ? groups : [leaf("Nothing recorded about this file yet.", "info")])];
  }
}

function leaf(label, icon, url = null, description) {
  const t = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  t.iconPath = new vscode.ThemeIcon(icon);
  if (description) t.description = description;
  t.tooltip = label;
  if (url) t.command = { command: "thaliyola.open", title: "Open in Thaliyola", arguments: [url] };
  return t;
}

function group(label, icon, children) {
  if (!children.length) return null;
  const t = new vscode.TreeItem(`${label} (${children.length})`, vscode.TreeItemCollapsibleState.Expanded);
  t.iconPath = new vscode.ThemeIcon(icon);
  t.children = children;
  return t;
}

function deactivate() {}

module.exports = { activate, deactivate };
