#!/usr/bin/env python3
"""Keep your Thaliyola skills in Claude Code up to date.

Downloads the skills Thaliyola assigns to you into ~/.claude/skills/thaliyola-<name>/ (or
$CLAUDE_CONFIG_DIR/skills) and removes the ones you no longer have. It only ever touches folders
named thaliyola-* that carry its own marker file (.thaliyola-skill.json); your own skills, and any
thaliyola-* folder without the marker, are never touched. Its only other file is
~/.config/thaliyola/skills-sync-state.json.

    python3 -I skills-sync.py              sync now
    python3 -I skills-sync.py --quiet      for a SessionStart hook: one line when something changed
    python3 -I skills-sync.py --dry-run    show what would change
    python3 -I skills-sync.py --remove-all remove every skill this script installed

The token comes from THALIYOLA_TOKEN, else ~/.config/thaliyola/token (readable by you only). It is
sent only in the Authorization header. Python 3.8+, standard library only.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "skills-sync/1"
DEFAULT_URL = "__THALIYOLA_URL__"
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DIR_RE = re.compile(r"^thaliyola-[a-z0-9]+(?:-[a-z0-9]+)*$")
MARKER = ".thaliyola-skill.json"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class SyncFailure(Exception):
    """Something to tell the user in one line."""


def dir_of(name: str) -> str:
    """The folder for a skill: the same rule as the server (thaliyola-<name>, hashed when over 64 characters)."""
    d = "thaliyola-" + name
    if len(d) <= 64:
        return d
    return "thaliyola-" + name[:45].rstrip("-") + "-" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:6]


def config_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".config", "thaliyola")


def skills_root() -> str:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "skills")


# ---- state -------------------------------------------------------------------------------------------------------
def state_path() -> str:
    return os.path.join(config_dir(), "skills-sync-state.json")


def load_state() -> dict:
    try:
        with open(state_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    d = config_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = state_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, state_path())


# ---- token and HTTP ------------------------------------------------------------------------------------------------
def read_token() -> str:
    tok = os.environ.get("THALIYOLA_TOKEN", "").strip()
    if tok:
        return tok
    path = os.path.join(config_dir(), "token")
    try:
        st = os.stat(path)
    except OSError:
        raise SyncFailure("no token: set THALIYOLA_TOKEN or save one to ~/.config/thaliyola/token (connect.sh does)")
    if stat.S_IMODE(st.st_mode) & 0o077 or (hasattr(os, "getuid") and st.st_uid != os.getuid()):
        raise SyncFailure("~/.config/thaliyola/token must be yours and readable by you only (chmod 600)")
    with open(path, "r", encoding="utf-8") as f:
        tok = f.read().strip()
    if not tok:
        raise SyncFailure("~/.config/thaliyola/token is empty")
    return tok


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib API
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(base: str, path: str, token: str, etag: str | None = None):
    """(status, headers, body bytes). Redirects are never followed: Cloudflare Access answers with one."""
    url = base.rstrip("/") + path
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json", "X-Thaliyola-Sync": VERSION, "User-Agent": VERSION}
    if etag:
        headers["If-None-Match"] = etag
    req = urllib.request.Request(url, headers=headers)
    host = urllib.parse.urlsplit(base).hostname or base
    try:
        with OPENER.open(req, timeout=20) as res:
            return res.status, dict(res.headers.items()), res.read(64 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read(64 * 1024)
        except OSError:
            pass
        return e.code, dict(e.headers.items()) if e.headers else {}, body
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        if "CERTIFICATE_VERIFY_FAILED" in reason:
            hint = "; on macOS run Install Certificates.command for python.org Python" if sys.platform == "darwin" else ""
            raise SyncFailure("couldn't reach %s (TLS certificate check failed%s)" % (host, hint))
        raise SyncFailure("couldn't reach %s" % host)
    except OSError:
        raise SyncFailure("couldn't reach %s" % host)


def header(headers: dict, name: str) -> str:
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return ""


def check_response(base: str, status: int, headers: dict, body: bytes) -> None:
    loc = header(headers, "location")
    ctype = header(headers, "content-type")
    if (status in (301, 302, 303, 307, 308) and "cloudflareaccess.com" in loc) or ("text/html" in ctype and status != 304):
        raise SyncFailure("blocked by Cloudflare Access: ask your Administrator to let /api/skills/sync through (README › Cloudflare)")
    if status in (301, 302, 303, 307, 308):
        raise SyncFailure("the server redirected the request; check the Thaliyola URL")
    if status == 401:
        raise SyncFailure("token rejected: create a new one at %s/#/connect" % base.rstrip("/"))


# ---- validation (before any filesystem call) ------------------------------------------------------------------
def valid_manifest(m: object) -> dict:
    if not isinstance(m, dict) or not isinstance(m.get("skills"), list):
        raise SyncFailure("the server's answer isn't a skills manifest")
    for s in m["skills"]:
        if not isinstance(s, dict):
            raise SyncFailure("the server's manifest is malformed; nothing changed")
        name, d = s.get("name"), s.get("dir")
        if not isinstance(name, str) or not NAME_RE.match(name) or len(name) > 64:
            raise SyncFailure("the server's manifest has an invalid skill name; nothing changed")
        if not isinstance(d, str) or not DIR_RE.match(d) or d != dir_of(name):
            raise SyncFailure("the server's manifest names a folder that doesn't match its skill; nothing changed")
        if not isinstance(s.get("hash"), str) or not isinstance(s.get("version"), int):
            raise SyncFailure("the server's manifest is malformed; nothing changed")
    return m


def safe_rel(path: object) -> str:
    if not isinstance(path, str) or not path or len(path) > 300 or "\\" in path or "\x00" in path or path.startswith("/"):
        raise SyncFailure("a skill file has an unsafe path; nothing changed")
    if re.match(r"^[A-Za-z]:", path) or any(p in ("", ".", "..") for p in path.split("/")):
        raise SyncFailure("a skill file has an unsafe path; nothing changed")
    if any(ord(c) < 32 for c in path):
        raise SyncFailure("a skill file has an unsafe path; nothing changed")
    return path


def valid_bundle(b: object, want: dict) -> list:
    if not isinstance(b, dict) or b.get("name") != want["name"] or b.get("dir") != want["dir"] or not isinstance(b.get("files"), list):
        raise SyncFailure("the server sent a skill that doesn't match its manifest; nothing changed")
    files = []
    lines = []
    for f in b["files"]:
        rel = safe_rel(f.get("path") if isinstance(f, dict) else None)
        data = base64.b64decode(f.get("b64", ""), validate=True)
        sha = hashlib.sha256(data).hexdigest()
        if sha != f.get("sha256"):
            raise SyncFailure("a skill file didn't arrive intact; nothing changed")
        files.append((rel, data))
        lines.append((rel, sha))
    digest = hashlib.sha256("".join("%s\0%s\n" % (p, s) for p, s in sorted(lines)).encode("utf-8")).hexdigest()
    if digest != b.get("hash") or digest != want["hash"]:
        raise SyncFailure("a skill didn't arrive intact; nothing changed")
    if not any(p == "SKILL.md" for p, _ in files):
        raise SyncFailure("a skill arrived without SKILL.md; nothing changed")
    return files


# ---- the skills folder -----------------------------------------------------------------------------------------
def is_managed(root: str, name: str) -> bool:
    """A folder this script owns: the name, a real directory (never a symlink) and its marker."""
    if not DIR_RE.match(name):
        return False
    p = os.path.join(root, name)
    try:
        st = os.lstat(p)
    except OSError:
        return False
    if not stat.S_ISDIR(st.st_mode):
        return False
    try:
        mst = os.lstat(os.path.join(p, MARKER))
    except OSError:
        return False
    return stat.S_ISREG(mst.st_mode)


def managed(root: str) -> dict:
    out = {}
    try:
        names = os.listdir(root)
    except OSError:
        return out
    for n in names:
        if is_managed(root, n):
            try:
                with open(os.path.join(root, n, MARKER), "r", encoding="utf-8") as f:
                    out[n] = json.load(f)
            except (OSError, ValueError):
                out[n] = {}
    return out


def remove_dir(root: str, name: str) -> None:
    # Re-check right before removing: a directory, the marker, the name.
    if is_managed(root, name):
        shutil.rmtree(os.path.join(root, name))


def clean_leftovers(root: str) -> None:
    try:
        names = os.listdir(root)
    except OSError:
        return
    for n in names:
        if re.match(r"^\.thaliyola-(staging|old)-\d+$", n):
            p = os.path.join(root, n)
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode):
                shutil.rmtree(p)


def install(root: str, want: dict, files: list, server: str) -> None:
    staging = os.path.join(root, ".thaliyola-staging-%d" % os.getpid())
    if os.path.lexists(staging):
        shutil.rmtree(staging)
    os.mkdir(staging, 0o755)
    real = os.path.realpath(staging)
    ordered = sorted((f for f in files if f[0] != "SKILL.md"), key=lambda f: f[0]) + [f for f in files if f[0] == "SKILL.md"]
    for rel, data in ordered:  # SKILL.md last, then the marker
        target = os.path.join(staging, *rel.split("/"))
        if not os.path.realpath(target).startswith(real + os.sep):
            raise SyncFailure("a skill file has an unsafe path; nothing changed")
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(target, 0o644)
    with open(os.path.join(staging, MARKER), "w", encoding="utf-8") as f:
        json.dump({"name": want["name"], "version": want["version"], "hash": want["hash"], "server": server}, f)
    final = os.path.join(root, want["dir"])
    old = os.path.join(root, ".thaliyola-old-%d" % os.getpid())
    if is_managed(root, want["dir"]):
        os.rename(final, old)
    elif os.path.lexists(final):
        shutil.rmtree(staging)
        raise SyncFailure("%s exists and isn't managed by this script; leaving it alone" % want["dir"])
    os.rename(staging, final)
    if os.path.lexists(old):
        shutil.rmtree(old)


# ---- main ------------------------------------------------------------------------------------------------------
def sync(args, state: dict) -> list:
    base = args.url.rstrip("/")
    parts = urllib.parse.urlsplit(base)
    if parts.scheme != "https" and not (parts.scheme == "http" and (parts.hostname or "") in LOCAL_HOSTS):
        raise SyncFailure("the Thaliyola URL must use https")
    root = skills_root()
    if args.remove_all:
        names = sorted(managed(root))
        if not args.dry_run:
            for n in names:
                remove_dir(root, n)
        return ["removed " + n for n in names]
    token = read_token()
    # The stored ETag only stands for what's on disk while the managed folders still match the last sync: a folder
    # someone deleted (or edited) makes this a full check, so it's put back.
    on_disk = {n: m.get("hash") for n, m in managed(root).items()}
    etag = state.get("etag") if not args.dry_run and on_disk == (state.get("installed") or {}) else None
    status, headers, body = request(base, "/api/skills/sync", token, etag)
    check_response(base, status, headers, body)
    if status == 304:
        return []
    if status == 403:
        try:
            code = json.loads(body.decode("utf-8")).get("code")
        except (ValueError, UnicodeDecodeError, AttributeError):
            code = None
        if code == "account_disabled":
            names = sorted(managed(root))
            if not args.dry_run:
                for n in names:
                    remove_dir(root, n)
            return ["removed " + n for n in names]
        raise SyncFailure("the server refused the request (HTTP 403)")
    if status != 200:
        raise SyncFailure("the server answered HTTP %d" % status)
    try:
        manifest = valid_manifest(json.loads(body.decode("utf-8")))
    except (ValueError, UnicodeDecodeError):
        raise SyncFailure("the server's answer isn't a skills manifest")
    manifest_etag = header(headers, "etag")
    want = {s["dir"]: s for s in ([] if manifest.get("remove_all") else manifest["skills"])}
    if args.dry_run:
        have = managed(root)
        out = ["would remove " + n for n in sorted(have) if n not in want]
        out += ["would %s %s" % ("update" if d in have else "add", d) for d, s in sorted(want.items()) if have.get(d, {}).get("hash") != s["hash"]]
        return out
    if not os.path.isdir(root):
        os.makedirs(root, mode=0o755, exist_ok=True)
    clean_leftovers(root)
    have = managed(root)
    changes = []
    for n in sorted(have):
        if n not in want:
            remove_dir(root, n)
            changes.append("removed " + n[len("thaliyola-"):])
    failed = []
    started = time.time()
    unfinished = False
    for d, s in sorted(want.items()):
        if have.get(d, {}).get("hash") == s["hash"]:
            continue
        if args.budget and time.time() - started > args.budget:
            unfinished = True  # no ETag is kept, so the next run carries on
            break
        # One skill that can't be installed (a download error, a file the disk refuses) doesn't stop the others.
        try:
            status, headers, body = request(base, "/api/skills/sync/" + urllib.parse.quote(s["name"]), token)
            check_response(base, status, headers, body)
            if status != 200:
                raise SyncFailure("couldn't download it (HTTP %d)" % status)
            try:
                files = valid_bundle(json.loads(body.decode("utf-8")), s)
            except (ValueError, UnicodeDecodeError):
                raise SyncFailure("the server sent a malformed skill")
            install(root, s, files, base)
            changes.append(("updated " if d in have else "added ") + s["name"])
        except (SyncFailure, OSError) as e:
            failed.append("%s (%s)" % (s["name"], e.strerror if isinstance(e, OSError) and e.strerror else e))
            staging = os.path.join(root, ".thaliyola-staging-%d" % os.getpid())
            if os.path.isdir(staging) and not os.path.islink(staging):
                shutil.rmtree(staging, ignore_errors=True)
    state["installed"] = {n: m.get("hash") for n, m in managed(root).items()}
    if failed:
        if changes:
            print("Thaliyola skills: " + ", ".join(changes))
        raise SyncFailure("couldn't install " + "; ".join(failed))
    state["etag"] = None if unfinished else (manifest_etag or None)
    return changes


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("THALIYOLA_URL") or DEFAULT_URL)
    ap.add_argument("--quiet", action="store_true", help="print one line only when something changed; never fail")
    ap.add_argument("--max-age", type=int, default=0, metavar="SECONDS", help="skip the check if the last one is newer than this")
    ap.add_argument("--budget", type=int, default=0, metavar="SECONDS", help="start no new download after this long (the rest follow next run)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--remove-all", action="store_true", help="remove every skill this script installed")
    args = ap.parse_args(argv)
    if args.url.startswith("__"):
        print("Thaliyola skills: no server URL; pass --url", file=sys.stderr)
        return 0 if args.quiet else 2
    state = load_state()
    now = time.time()
    if args.max_age and not args.remove_all and now - float(state.get("last_check") or 0) < args.max_age:
        return 0
    try:
        changes = sync(args, state)
        state["last_check"] = now
        state.pop("last_error", None)
        if not args.dry_run:
            save_state(state)
        if changes:
            print("Thaliyola skills: " + ", ".join(changes))
        return 0
    except SyncFailure as e:
        msg = str(e)
        state["last_check"] = now
        state["last_error"] = msg
        state.pop("etag", None)
        shown = state.get("last_error_shown") or {}
        today = time.strftime("%Y-%m-%d")
        should_print = not args.quiet or shown.get("error") != msg or shown.get("day") != today
        if should_print:
            print("Thaliyola skills not updated: " + msg, file=sys.stderr if not args.quiet else sys.stdout)
            state["last_error_shown"] = {"error": msg, "day": today}
        if not args.dry_run:
            try:
                save_state(state)
            except OSError:
                pass
        return 0 if args.quiet else 1
    except Exception as e:  # a hook must never break a session
        if args.quiet:
            return 0
        raise


if __name__ == "__main__":
    sys.exit(main())
