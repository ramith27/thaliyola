#!/bin/sh
# Connect the coding agents on this machine to Thaliyola.
#
#   curl -fsSL https://thaliyola.example.com/connect.sh | sh
#   curl -fsSL https://thaliyola.example.com/connect.sh | sh -s -- --yes --only claude,codex
#   curl -fsSL https://thaliyola.example.com/connect.sh | sh -s -- --skills         (Claude Code skills sync only)
#   curl -fsSL https://thaliyola.example.com/connect.sh | sh -s -- --remove-skills  (undo it)
#
# Finds Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, VS Code, Cursor, Windsurf, OpenCode
# and Kiro, and adds the Thaliyola MCP server to each one you choose (user level, all projects).
# The token comes from THALIYOLA_TOKEN or is asked for; create one on the Connect page.
# Existing config files are backed up next to themselves (*.thaliyola-backup) before changing.
#
# Skills: when Claude Code is here (or with --skills), it offers to keep the Claude skills Thaliyola assigns
# to you in ~/.claude/skills/thaliyola-<name>/: it saves the token to ~/.config/thaliyola/token (yours
# only), downloads skills-sync.py next to it, runs it once and can add a SessionStart hook that runs it at
# every Claude Code session start. The sync only ever touches its own thaliyola-* folders.
set -eu

URL="__THALIYOLA_URL__"
MCP_URL="$URL/mcp"
YES=0
ONLY=""
DRY=0
SKILLS=ask

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --only) shift; ONLY="$1" ;;
    --only=*) ONLY="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --dry-run) DRY=1 ;;
    --skills) SKILLS=only ;;
    --no-skills) SKILLS=no ;;
    --remove-skills) SKILLS=remove ;;
    --url) shift; URL="$1"; MCP_URL="$URL/mcp" ;;
    -h|--help) sed -n '2,10p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
tty_ok() { [ -r /dev/tty ] && [ -w /dev/tty ]; }

ask() { # ask "question" -> 0 for yes
  [ "$YES" = 1 ] && return 0
  tty_ok || return 0
  printf '%s [Y/n] ' "$1" > /dev/tty
  read -r reply < /dev/tty || reply=""
  case "$reply" in n|N|no|No) return 1 ;; *) return 0 ;; esac
}

wanted() { # wanted <id>: honour --only
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

if [ "$URL" = "__THALIYOLA_""URL__" ]; then
  say "Download this script from your Thaliyola server (https://<server>/connect.sh), or pass --url https://<server>." >&2
  exit 2
fi

if have python3; then PY=python3; elif have python; then PY=python; else PY=""; fi

CONF_DIR="$HOME/.config/thaliyola"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SYNC_SCRIPT="$CONF_DIR/skills-sync.py"
# The hook runs the interpreter found here (python3, or python where that's all there is), and stops starting new
# downloads after 20 seconds so a first sync of many skills finishes inside the hook's 30 (the rest follow next time).
HOOK_COMMAND="${PY:-python3}"' -I "$HOME/.config/thaliyola/skills-sync.py" --quiet --max-age 300 --budget 20'
export HOOK_COMMAND

# hook_json add|remove: the SessionStart hook in Claude Code's settings.json, keeping everything else.
hook_json() {
  FILE="$CLAUDE_DIR/settings.json" ACTION="$1" "$PY" -I - <<'PYEOF'
import json, os, shutil, sys
f, action, cmd = os.environ["FILE"], os.environ["ACTION"], os.environ["HOOK_COMMAND"]
data = {}
if os.path.exists(f):
    try:
        with open(f, encoding="utf-8") as fh:
            text = fh.read()
        data = json.loads(text) if text.strip() else {}
    except ValueError:
        print("  %s isn't plain JSON; left it unchanged. Add the hook by hand (see the Connect page)." % f)
        sys.exit(1)
    if not isinstance(data, dict):
        print("  %s isn't a JSON object; left it unchanged." % f)
        sys.exit(1)
hooks = data.get("hooks") if isinstance(data.get("hooks"), dict) else {}
starts = hooks.get("SessionStart") if isinstance(hooks.get("SessionStart"), list) else []
ours = lambda h: isinstance(h, dict) and "thaliyola/skills-sync.py" in str(h.get("command", ""))
present = any(ours(h) for e in starts if isinstance(e, dict) for h in (e.get("hooks") or []))
if action == "add":
    if present:
        print("  The SessionStart hook is already in %s." % f)
        sys.exit(0)
    starts.append({"matcher": "startup", "hooks": [{"type": "command", "command": cmd, "timeout": 30}]})
else:
    if not present:
        sys.exit(0)
    kept = []
    for e in starts:
        if isinstance(e, dict) and isinstance(e.get("hooks"), list):
            e = dict(e, hooks=[h for h in e["hooks"] if not ours(h)])
            if not e["hooks"]:
                continue
        kept.append(e)
    starts = kept
if starts:
    hooks["SessionStart"] = starts
else:
    hooks.pop("SessionStart", None)
if hooks:
    data["hooks"] = hooks
else:
    data.pop("hooks", None)
os.makedirs(os.path.dirname(f), exist_ok=True)
if os.path.exists(f):
    shutil.copy2(f, f + ".thaliyola-backup")
tmp = f + ".thaliyola-tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
os.replace(tmp, f)
print("  %s the SessionStart hook %s %s%s." % ("Added" if action == "add" else "Removed", "to" if action == "add" else "from", f, " (backup: settings.json.thaliyola-backup)" if os.path.exists(f + ".thaliyola-backup") else ""))
PYEOF
}

remove_skills() {
  if [ "$DRY" = 1 ]; then say "  would remove the thaliyola-* skills the sync installed, its SessionStart hook and the token and script in $CONF_DIR"; return 0; fi
  if [ -z "$PY" ]; then say "Python 3 is needed to remove the synced skills." >&2; return 1; fi
  if [ -f "$SYNC_SCRIPT" ]; then "$PY" -I "$SYNC_SCRIPT" --remove-all --url "$URL" || true; fi
  if [ -f "$CLAUDE_DIR/settings.json" ]; then hook_json remove || true; fi
  rm -f "$SYNC_SCRIPT" "$CONF_DIR/token" "$CONF_DIR/skills-sync-state.json"
  say "Removed the Thaliyola skills sync. Your own skills in $CLAUDE_DIR/skills weren't touched."
}

if [ "$SKILLS" = remove ]; then
  remove_skills
  exit $?
fi

TOKEN="${THALIYOLA_TOKEN:-}"
if [ -z "$TOKEN" ] && [ "$DRY" = 0 ]; then
  if ! tty_ok; then say "Set THALIYOLA_TOKEN (create a token at $URL/#/connect)." >&2; exit 2; fi
  printf 'Thaliyola token (from %s/#/connect): ' "$URL" > /dev/tty
  stty -echo < /dev/tty 2>/dev/null || true
  read -r TOKEN < /dev/tty || TOKEN=""
  stty echo < /dev/tty 2>/dev/null || true
  printf '\n' > /dev/tty
fi
[ -n "$TOKEN" ] || [ "$DRY" = 1 ] || { say "No token given." >&2; exit 2; }
[ -n "$TOKEN" ] || TOKEN="<token>"
export TOKEN MCP_URL

# merge_json <file> <host>: put the thaliyola server into a JSON config file, keeping everything else.
merge_json() {
  file="$1"; host="$2"
  if [ "$DRY" = 1 ]; then say "  would update $file"; return 0; fi
  if [ -z "$PY" ]; then say "  python3 is needed to edit $file; add the server by hand (see $URL/#/connect)."; return 1; fi
  mkdir -p "$(dirname "$file")"
  backup=""
  if [ -f "$file" ]; then backup="$file.thaliyola-backup"; cp "$file" "$backup"; fi
  if (umask 077; HOST="$host" FILE="$file" "$PY" - <<'PY'
import json, os, sys
f, host, url, tok = os.environ["FILE"], os.environ["HOST"], os.environ["MCP_URL"], os.environ["TOKEN"]
auth = {"Authorization": "Bearer " + tok}
try:
    with open(f) as fh:
        text = fh.read()
    cfg = json.loads(text) if text.strip() else {}
except FileNotFoundError:
    cfg = {}
except ValueError:
    sys.stderr.write("  %s has comments or isn't plain JSON; left unchanged. Add the server by hand.\n" % f)
    sys.exit(1)
if host == "opencode":
    cfg.setdefault("$schema", "https://opencode.ai/config.json")
    cfg.setdefault("mcp", {})["thaliyola"] = {"type": "remote", "url": url, "headers": auth, "enabled": True}
else:
    entry = {
        "gemini": {"httpUrl": url, "headers": auth},
        "windsurf": {"serverUrl": url, "headers": auth},
        "copilot": {"type": "http", "url": url, "headers": auth, "tools": ["*"]},
        "cursor": {"url": url, "headers": auth},
        "kiro": {"url": url, "headers": auth},
    }[host]
    cfg.setdefault("mcpServers", {})["thaliyola"] = entry
with open(f, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
PY
  ); then return 0; fi
  [ -n "$backup" ] && rm -f "$backup"
  return 1
}

# Codex keeps its servers in TOML; replace our table and leave the rest alone.
merge_codex() {
  file="$HOME/.codex/config.toml"
  if [ "$DRY" = 1 ]; then say "  would update $file"; return 0; fi
  mkdir -p "$HOME/.codex"
  [ -f "$file" ] && cp "$file" "$file.thaliyola-backup"
  tmp="$file.tmp.$$"
  (umask 077
   if [ -f "$file" ]; then
     awk 'BEGIN{skip=0} /^\[/{skip=($0 ~ /^\[mcp_servers\.thaliyola(\.|\])/)} !skip' "$file" > "$tmp"
   else
     : > "$tmp"
   fi
   printf '\n[mcp_servers.thaliyola]\nurl = "%s"\nhttp_headers = { "Authorization" = "Bearer %s" }\n' "$MCP_URL" "$TOKEN" >> "$tmp"
   mv "$tmp" "$file")
}

configured=""
skipped=""
done_host() { configured="$configured $1"; }

try_host() { # try_host <id> <label> <detect-command> <install-function>
  id="$1"; label="$2"; detect="$3"; fn="$4"
  wanted "$id" || return 0
  if ! eval "$detect" >/dev/null 2>&1; then return 0; fi
  if ask "Add Thaliyola to $label?"; then
    say "- $label"
    if "$fn"; then done_host "$label"; else skipped="$skipped $label"; fi
  fi
}

install_claude() {
  if [ "$DRY" = 1 ]; then say "  would run: claude mcp add --transport http thaliyola $MCP_URL --scope user"; return 0; fi
  claude mcp remove thaliyola --scope user >/dev/null 2>&1 || true
  claude mcp add --transport http thaliyola "$MCP_URL" --scope user --header "Authorization: Bearer $TOKEN" >/dev/null
}
install_vscode() {
  if [ "$DRY" = 1 ]; then say "  would run: code --add-mcp ..."; return 0; fi
  if [ -z "$PY" ]; then return 1; fi
  json="$("$PY" -c 'import json,os; print(json.dumps({"name":"thaliyola","type":"http","url":os.environ["MCP_URL"],"headers":{"Authorization":"Bearer "+os.environ["TOKEN"]}}))')"
  code --add-mcp "$json" >/dev/null
}
install_codex() { merge_codex; }
install_gemini() { merge_json "$HOME/.gemini/settings.json" gemini; }
install_copilot() { merge_json "$HOME/.copilot/mcp-config.json" copilot; }
install_cursor() { merge_json "$HOME/.cursor/mcp.json" cursor; }
install_windsurf() { merge_json "$HOME/.codeium/windsurf/mcp_config.json" windsurf; }
install_opencode() { merge_json "$HOME/.config/opencode/opencode.json" opencode; }
install_kiro() { merge_json "$HOME/.kiro/settings/mcp.json" kiro; }

# setup_skills: the token file, the sync script, a first run and (if wanted) the SessionStart hook.
setup_skills() {
  if [ -z "$PY" ]; then say "  Python 3 is needed for the skills sync; skipped."; return 1; fi
  if [ "$DRY" = 1 ]; then say "  would save the token to $CONF_DIR/token, download $URL/skills-sync.py and run it"; return 0; fi
  ( umask 077; mkdir -p "$CONF_DIR" )
  chmod 700 "$CONF_DIR"
  ( umask 077; printf '%s\n' "$TOKEN" > "$CONF_DIR/token.tmp" && mv "$CONF_DIR/token.tmp" "$CONF_DIR/token" )
  if have curl; then
    curl -fsSL "$URL/skills-sync.py" -o "$SYNC_SCRIPT.tmp" || { rm -f "$SYNC_SCRIPT.tmp"; say "  Couldn't download $URL/skills-sync.py."; return 1; }
  else
    "$PY" -I -c 'import sys, urllib.request; open(sys.argv[2], "wb").write(urllib.request.urlopen(sys.argv[1] + "/skills-sync.py", timeout=30).read())' "$URL" "$SYNC_SCRIPT.tmp" || { rm -f "$SYNC_SCRIPT.tmp"; say "  Couldn't download the sync script."; return 1; }
  fi
  if ! head -1 "$SYNC_SCRIPT.tmp" | grep -q python; then rm -f "$SYNC_SCRIPT.tmp"; say "  $URL/skills-sync.py isn't the sync script (blocked by a sign-in page?)."; return 1; fi
  chmod 600 "$SYNC_SCRIPT.tmp" && mv "$SYNC_SCRIPT.tmp" "$SYNC_SCRIPT"
  "$PY" -I "$SYNC_SCRIPT" || true
  if ask "Check for skill updates at every Claude Code session start?"; then
    hook_json add || true
  fi
  return 0
}

if [ "$SKILLS" = only ]; then
  say "Thaliyola skills for Claude Code: $URL"
  setup_skills
  exit $?
fi

say "Thaliyola: $MCP_URL"
try_host claude "Claude Code" "have claude" install_claude
try_host codex "Codex" "have codex || test -d \"\$HOME/.codex\"" install_codex
try_host gemini "Gemini CLI" "have gemini || test -d \"\$HOME/.gemini\"" install_gemini
try_host copilot "GitHub Copilot CLI" "have copilot || test -d \"\$HOME/.copilot\"" install_copilot
try_host vscode "VS Code (Copilot agent mode)" "have code" install_vscode
try_host cursor "Cursor" "have cursor || test -d \"\$HOME/.cursor\"" install_cursor
try_host windsurf "Windsurf" "test -d \"\$HOME/.codeium/windsurf\"" install_windsurf
try_host opencode "OpenCode" "have opencode || test -d \"\$HOME/.config/opencode\"" install_opencode
try_host kiro "Kiro" "have kiro || test -d \"\$HOME/.kiro\"" install_kiro

if [ "$SKILLS" = ask ] && have claude && wanted claude; then
  if ask "Keep your Thaliyola skills in Claude Code up to date?"; then
    say "- Skills for Claude Code"
    if setup_skills; then done_host "Skills sync"; fi
  fi
fi

if [ -z "$configured" ]; then
  # Not "${skipped:+ Couldn't …}": macOS /bin/sh (bash 3.2) can't parse an apostrophe inside that expansion.
  couldnt=""
  if [ -n "$skipped" ]; then couldnt=" Couldn't configure:$skipped."; fi
  say "No agents were configured.$couldnt See $URL/#/connect for manual setup."
  exit 1
fi
say ""
say "Connected:$configured"
[ -n "$skipped" ] && say "Couldn't configure:$skipped (see $URL/#/connect)."
say "Restart running agents to load the server. In a repository, ask: \"what does Thaliyola know about this project?\""
