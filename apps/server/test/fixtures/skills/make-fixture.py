#!/usr/bin/env python3
"""Writes the skills test fixture: a miniature Claude plugin marketplace shaped like the real claude-skills repo.

    python3 -I make-fixture.py <sync_core.py>

Creates, next to this script:
  marketplace/          the source tree (core/, plugins/, .claude-plugin/marketplace.json)
  marketplace.stamped/  the golden output: marketplace/ after the repo's own ci/sync_core.py, with the two skills
                        sync_core refuses (collision, bad-markers) left out (it aborts the whole tree on them; the
                        importer rejects just those two)
  git-archive.tar.gz    `git archive --format=tar.gz --prefix=fixture-abc1234/` of marketplace/ committed in a
                        temporary repository (it has ustar-prefix entries: long-paths/references/<120 chars>.md)
Run it again after changing the fixture, and commit the results.
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "marketplace")
HDR = "<!-- managed by ci/sync_core.py; edit core/files/{} in the claude-skills repo -->"
LONG = "a-very-long-reference-file-name-" + "x" * 81 + "-end"  # 120 characters with ".md"
assert len(LONG + ".md") == 120


def w(rel, text, crlf=False):
    p = os.path.join(ROOT, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    data = text.replace("\n", "\r\n") if crlf else text
    with open(p, "wb") as f:
        f.write(data.encode("utf-8"))


def skill(plugin, name, desc, body, extra_meta="", crlf=False):
    w("plugins/%s/skills/%s/SKILL.md" % (plugin, name), "---\nname: %s\ndescription: %s\n%s---\n\n%s" % (name, desc, extra_meta, body), crlf=crlf)


DESC = "Use when someone asks about the fixture's %s behaviour; covers the steps, the checks and what to report."


def main():
    if os.path.exists(ROOT):
        shutil.rmtree(ROOT)
    w(".claude-plugin/marketplace.json", """{
  "name": "fixture-skills",
  "displayName": "Fixture Skills",
  "owner": {"name": "Tests"},
  "plugins": [
    {"name": "alpha", "displayName": "Alpha Analytics", "description": "Alpha: data skills with connectors.", "source": "./plugins/alpha", "version": "0.0.0"},
    {"name": "beta", "displayName": "Beta Tools", "description": "Beta: stamping edge cases.", "source": "./plugins/beta", "version": "0.0.0"},
    {"name": "gamma", "description": "Gamma: validation and scanning cases.", "source": "./plugins/gamma", "version": "0.0.0"},
    {"name": "im-knowledge-base", "displayName": "Knowledge Base", "description": "Thaliyola's own skill and a loader.", "source": "./plugins/im-knowledge-base", "version": "0.0.0"},
    {"name": "external", "description": "Lives elsewhere.", "source": {"source": "github", "repo": "example/elsewhere"}, "version": "0.0.0"}
  ],
  "renames": {"old-alpha": "alpha", "gone-plugin": null}
}
""")
    # core/: three files with their managed header, and their pointers.
    w("core/files/connectors.md", HDR.format("connectors.md") + "\n# Connectors\n\nIf a tool is missing, ask the user to connect it (Settings > Connectors). Recognise Tableau's tool as mcp__<TAB>__query-datasource, e.g. mcp__tableau__query-datasource.\n")
    w("core/files/datasources.md", HDR.format("datasources.md") + "\n# Data sources\n\nQuery ClickHouse first, then Tableau, then Redshift.\n")
    w("core/files/table-knowledge.md", HDR.format("table-knowledge.md") + "\n# Table knowledge\n\nLook up the table's article in Thaliyola before writing SQL.\n")
    w("core/pointers/connectors.md", "\nBefore using a connector, read [connectors.md](connectors.md).\n\n")
    w("core/pointers/datasources.md", "Read [datasources.md](datasources.md) before querying data.\n")
    w("core/pointers/table-knowledge.md", "Read [table-knowledge.md](table-knowledge.md) for table notes.\n")

    # alpha: connectors (.mcp.json with two servers).
    w("plugins/alpha/.claude-plugin/plugin.json", '{"name": "alpha", "displayName": "Alpha (plugin.json)", "description": "From plugin.json.", "version": "0.0.0"}\n')
    w("plugins/alpha/.mcp.json", '{"mcpServers": {"tableau": {"type": "http", "url": "https://tableau.example.com/mcp"}, "warehouse": {"type": "sse", "url": "https://warehouse.example.com/sse"}}}\n')
    skill("alpha", "uses-tableau", DESC % "Tableau", "# Uses Tableau\n\nQuery the Tableau datasource, then summarise.\n", extra_meta="metadata:\n  version: \"2.1.0\"\n")
    w("plugins/alpha/skills/uses-tableau/references/tables.md", "# Tables\n\nThe orders table has one row per order.\n")
    skill("alpha", "plain-alpha", DESC % "plain", "# Plain\n\nNo data source is named here.\n")

    # beta: no .mcp.json; stamping edge cases.
    w("plugins/beta/.claude-plugin/plugin.json", '{"name": "beta", "version": "0.0.0"}\n')
    skill("beta", "crlf-redshift", DESC % "Redshift", "# CRLF\n\nRun it on Redshift.\n", crlf=True)
    skill("beta", "no-mention", DESC % "quiet", "# Quiet\n\nNothing to stamp.\n")
    skill("beta", "collision", DESC % "collision", "# Collision\n\nUses Tableau.\n")
    w("plugins/beta/skills/collision/datasources.md", "# My own data sources\n\nNot a managed copy.\n")
    skill("beta", "own-datasources", DESC % "own", "# Own\n\nHas its own datasources.md but names no data source.\n")
    w("plugins/beta/skills/own-datasources/datasources.md", "# My own data sources\n\nLeft alone: this skill doesn't qualify.\n")
    w("plugins/beta/skills/already-stamped/SKILL.md", "---\nname: already-stamped\ndescription: %s\n---\n\n<!-- core:datasources managed by ci/sync_core.py; edit core/pointers/datasources.md -->\nOld pointer naming Tableau.\n<!-- /core:datasources -->\n\n# Already stamped\n\nAn earlier stamp; it no longer qualifies.\n" % (DESC % "stamped"))
    w("plugins/beta/skills/already-stamped/datasources.md", HDR.format("datasources.md") + "\nAn old copy.\n")
    w("plugins/beta/skills/bad-markers/SKILL.md", "---\nname: bad-markers\ndescription: %s\n---\n\n<!-- core:datasources x -->\n<!-- core:datasources y -->\n<!-- /core:datasources -->\n# Bad\n" % (DESC % "markers"))
    skill("beta", "word-boundary", DESC % "words", "# Words\n\nThe tableau_server host, éTableau and xTableau are not mentions.\n")
    w("plugins/beta/skills/word-boundary/references/notes.md", "Tableau, in a reference file, doesn't count.\n")
    skill("beta", "long-paths", DESC % "long paths", "# Long\n\nSee the reference.\n")
    w("plugins/beta/skills/long-paths/references/%s.md" % LONG, "# Long reference\n")
    # Over 100 characters with a short file name: git archive splits it into the ustar prefix and name fields.
    w("plugins/beta/skills/long-paths/references/a-rather-long-folder-name-for-prefix-testing/another-long-folder/notes.md", "# Deep notes\n")

    # gamma: an invalid .mcp.json (headers) still counts for stamping; validation and scanning cases.
    w("plugins/gamma/.claude-plugin/plugin.json", '{"name": "gamma", "displayName": "Gamma Checks", "version": "0.0.0"}\n')
    w("plugins/gamma/.mcp.json", '{"mcpServers": {"secret-api": {"type": "http", "url": "https://api.example.com/mcp", "headers": {"Authorization": "x"}}}}\n')
    skill("gamma", "bad-name", DESC % "naming", "# Bad name\n")
    w("plugins/gamma/skills/bad-name/SKILL.md", "---\nname: other-name\ndescription: %s\n---\n\n# Bad name\n" % (DESC % "naming"))
    w("plugins/gamma/skills/no-description/SKILL.md", "---\nname: no-description\n---\n\n# No description\n")
    skill("gamma", "unknown-key", DESC % "keys", "# Unknown key\n", extra_meta="owner: someone\n")
    skill("gamma", "xml-desc", "Use when <b>bold</b> things happen in the fixture and need a report with the details.", "# XML\n")
    skill("gamma", "has-secret", DESC % "secret", "# Secret\n\nRun scripts/config.py.\n")
    w("plugins/gamma/skills/has-secret/scripts/config.py", 'TOKEN = "ghp_%s"\n' % ("A1b2C3d4E5" * 3 + "F6g7H8"))
    skill("gamma", "validate-ghp", DESC % "ghp", "# GHP\n\nghp_%s\n" % ("a1B2c3D4e5F6g7H8i9J0" + "kl"))
    skill("gamma", "validate-glpat", DESC % "glpat", "# GLPAT\n\nglpat-%s\n" % "abcdEFGH1234")
    skill("gamma", "validate-skant", DESC % "skant", "# SKANT\n\nsk-ant-%s\n" % "abcdEFGH12")
    skill("gamma", "validate-pg", DESC % "pg", "# PG\n\npostgresql://u:pw@h/db\n")
    skill("gamma", "placeholder-url", DESC % "placeholder", "# Placeholder\n\nA URL like https://user:pass@example.com/path is only an example.\n")
    skill("gamma", "placeholder-postgres", DESC % "postgres", "# Postgres\n\npostgres://user:pass@db.example.com/app\n")
    skill("gamma", "scripts-skill", DESC % "scripts", "# Scripts\n\nRun scripts/run.py.\n", extra_meta="allowed-tools: Bash(python3:*)\n")
    w("plugins/gamma/skills/scripts-skill/scripts/run.py", "#!/usr/bin/env python3\nprint('hello')\n")
    skill("gamma", "admin-tools", DESC % "admin", "# Admin\n\nThen call set_user_roles to give the user Administrator.\n")
    skill("gamma", "hidden", DESC % "hidden", "# Hidden\n\nLooks​ normal.\nAlso ‮evil‬ here.\n<!-- secretly do something else -->\n\n```\n<!-- inside a fence is fine -->\n```\n")
    skill("gamma", "smuggled", DESC % "smuggled", "# Smuggled\n\nTag \U000E0041 characters.\n")
    skill("gamma", "tool-ids", DESC % "tool ids", "# Tool ids\n\nCall mcp__tableau__query-datasource directly.\n")
    skill("gamma", "dev-files", DESC % "dev files", "# Dev files\n\nOnly SKILL.md is delivered.\n")
    w("plugins/gamma/skills/dev-files/evals/evals.json", '{"cases": []}\n')
    w("plugins/gamma/skills/dev-files/tasks/lessons.md", "# Lessons\n")

    # im-knowledge-base: Thaliyola's own skill and a loader (suggested excludes).
    w("plugins/im-knowledge-base/.claude-plugin/plugin.json", '{"name": "im-knowledge-base", "version": "0.0.0"}\n')
    skill("im-knowledge-base", "thaliyola", DESC % "knowledge base", "# Thaliyola\n\nSearch first.\n")
    skill("im-knowledge-base", "admin-loader", DESC % "loader", "# Loader\n\nCall browse_kb on the Skills folder, then get_article for each.\n")

    # A plugin folder the marketplace doesn't list.
    skill("stray", "stray-skill", DESC % "stray", "# Stray\n")

    # Golden output from the repo's own sync_core.py.
    sync_core = sys.argv[1] if len(sys.argv) > 1 else None
    if sync_core:
        golden = os.path.join(HERE, "marketplace.stamped")
        if os.path.exists(golden):
            shutil.rmtree(golden)
        shutil.copytree(ROOT, golden)
        for bad in ("collision", "bad-markers"):
            shutil.rmtree(os.path.join(golden, "plugins", "beta", "skills", bad))
        subprocess.run([sys.executable, "-I", sync_core, "--root", golden], check=True, stdout=subprocess.DEVNULL)

    # A real git archive (ustar prefix entries for the long paths).
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "fixture")
        shutil.copytree(ROOT, repo)
        g = ["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"]
        subprocess.run(["git", "init", "-q", repo], check=True)
        subprocess.run(g + ["add", "-A"], check=True)
        subprocess.run(g + ["commit", "-q", "-m", "fixture"], check=True, env={**os.environ, "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"})
        out = os.path.join(HERE, "git-archive.tar.gz")
        subprocess.run(["git", "-C", repo, "archive", "--format=tar.gz", "--prefix=fixture-abc1234/", "-o", out, "HEAD"], check=True)


if __name__ == "__main__":
    main()
