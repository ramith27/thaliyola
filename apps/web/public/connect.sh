#!/bin/sh
# Connect the coding agents on this machine to Thaliyola.
#
#   curl -fsSL https://thaliyola.example.com/connect.sh | sh
#   curl -fsSL https://thaliyola.example.com/connect.sh | sh -s -- --yes --only claude,codex
#
# Finds Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, VS Code, Cursor, Windsurf, OpenCode
# and Kiro, and adds the Thaliyola MCP server to each one you choose (user level, all projects).
# The token comes from THALIYOLA_TOKEN or is asked for; create one on the Connect page.
# Existing config files are backed up next to themselves (*.thaliyola-backup) before changing.
set -eu

URL="__THALIYOLA_URL__"
MCP_URL="$URL/mcp"
YES=0
ONLY=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --only) shift; ONLY="$1" ;;
    --only=*) ONLY="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --dry-run) DRY=1 ;;
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

if have python3; then PY=python3; elif have python; then PY=python; else PY=""; fi

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

if [ -z "$configured" ]; then
  say "No agents were configured.${skipped:+ Couldn't configure:$skipped.} See $URL/#/connect for manual setup."
  exit 1
fi
say ""
say "Connected:$configured"
[ -n "$skipped" ] && say "Couldn't configure:$skipped (see $URL/#/connect)."
say "Restart running agents to load the server. In a repository, ask: \"what does Thaliyola know about this project?\""
