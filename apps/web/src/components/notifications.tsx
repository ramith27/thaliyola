/**
 * Notifications (SPEC §6.1.4): the top-bar bell and its panel, WatchButton, and NotificationPrefs on Account.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { ToggleButton, IconButton } from "./kit/button";
import { Popover } from "./kit/overlay";
import { SegmentedControl } from "./kit/page";
import { RelativeTime } from "./kit/display";
import { Callout, SkeletonRows, useToast } from "./kit/feedback";
import { Switch } from "./kit/form";
import { I, type IconName } from "./icons";
import { peopleText, summaryText } from "./labels";

interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  created_at: string;
  read_at: string | null;
}

/** One icon per kind, shown in a soft circle. Exported for tests (every server kind has one). */
export const KIND_ICON: Record<string, IconName> = {
  review: "review",
  assigned: "user-plus",
  decided: "check-circle",
  comment: "message",
  change: "pencil",
  watch: "eye",
  stale: "clock",
  invite: "mail",
  security: "shield",
  token: "key",
  connection: "plug",
  access: "user-plus",
  // Thaliyola releases, like the What's new link.
  release: "sparkle",
  skill: "sparkle",
  // A question for the caller or their sessions, like the Sessions link.
  question: "chat",
};

/** "Review: Orders API v1" → "Orders API v1" (the icon already says it's a review). Pure, for tests. */
export const notificationTitle = (title: string) => summaryText(peopleText(title.replace(/^\s*Review:\s*/i, "")));

/** Splits notifications (newest first) into Today and Earlier. Pure, for tests. */
export function groupByDay<T extends { created_at: string }>(items: T[], now: Date = new Date()): { label: "Today" | "Earlier"; items: T[] }[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = items.filter((n) => new Date(n.created_at) >= start);
  const earlier = items.filter((n) => new Date(n.created_at) < start);
  return [
    { label: "Today" as const, items: today },
    { label: "Earlier" as const, items: earlier },
  ].filter((g) => g.items.length);
}

/** Bell with an unread count (polls every minute) and a 400px panel; full width above the tab bar on phones. */
export function NotificationBell() {
  const { data, error, reload } = useApi<{ notifications: Notification[]; unread: number }>("/notifications");
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<"all" | "unread">("all");
  // Read locally at once; the server catches up in the background.
  const [readNow, setReadNow] = useState<Set<string>>(() => new Set());
  const [allRead, setAllRead] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);
  // A fresh server answer replaces the local guesses.
  useEffect(() => {
    setReadNow(new Set());
    setAllRead(false);
  }, [data]);

  const items = useMemo(
    () => (data?.notifications ?? []).map((n) => ({ ...n, unread: !n.read_at && !allRead && !readNow.has(n.id) })),
    [data, allRead, readNow],
  );
  const unread = allRead ? 0 : Math.max(0, (data?.unread ?? 0) - items.filter((n) => !n.read_at && readNow.has(n.id)).length);
  const shown = show === "unread" ? items.filter((n) => n.unread) : items;

  function openItem(n: (typeof items)[number]) {
    setOpen(false);
    // Navigate first; mark read in the background.
    if (n.link) window.location.hash = n.link.replace(/^#/, "");
    if (!n.unread) return;
    setReadNow((s) => new Set(s).add(n.id));
    api("/notifications/read", { method: "POST", body: { ids: [n.id] } })
      .then(reload)
      .catch((e) => {
        toast.error(e, { title: "Couldn't mark the notification as read" });
        reload();
      });
  }

  async function markAll() {
    setAllRead(true);
    try {
      await api("/notifications/read", { method: "POST", body: {} });
      reload();
    } catch (e) {
      setAllRead(false);
      toast.error(e, { title: "Couldn't mark notifications as read", action: { label: "Try again", onClick: () => void markAll() } });
    }
  }

  return (
    <>
      <IconButton
        ref={button}
        icon="bell"
        label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        badge={unread}
        className="bell-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover anchorRef={button} open={open} onClose={() => setOpen(false)} label="Notifications" placement="bottom-end" sheetOnMobile className="notif-panel" autoFocus>
        <div className="notif-head">
          <h2 className="notif-heading">Notifications</h2>
          {unread > 0 && (
            <button type="button" className="link-btn notif-mark" onClick={markAll}>
              Mark all read
            </button>
          )}
          <IconButton icon="settings" label="Notification settings" size="sm" href="#/account?section=notifications" onClick={() => setOpen(false)} />
        </div>
        <div className="notif-filter">
          <SegmentedControl
            label="Show"
            size="sm"
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: "All" },
              { value: "unread", label: "Unread", count: unread || undefined },
            ]}
          />
        </div>
        {!data && !error ? (
          <div className="notif-loading">
            <SkeletonRows count={3} density="compact" />
          </div>
        ) : error && !data ? (
          <p className="notif-empty">
            Couldn't load notifications.{" "}
            <button type="button" className="link-btn" onClick={reload}>
              Try again
            </button>
          </p>
        ) : !shown.length ? (
          <p className="notif-empty">
            {show === "unread" && items.length
              ? "No unread notifications."
              : "Nothing yet. You'll hear about reviews, changes to what you watch, and decisions on your proposals."}
          </p>
        ) : (
          groupByDay(shown).map((g) => (
            <section key={g.label} className="notif-group" aria-label={g.label}>
              <h3 className="notif-group-label">{g.label}</h3>
              <ul className="notif-list">
                {g.items.map((n) => (
                  <li key={n.id}>
                    <button type="button" className="notif-row" data-unread={n.unread || undefined} onClick={() => openItem(n)}>
                      <span className="notif-icon" aria-hidden="true">
                        <I name={KIND_ICON[n.kind] ?? "bell"} size={16} />
                      </span>
                      <span className="notif-text">
                        <span className="notif-title">{notificationTitle(n.title)}</span>
                        {n.body && <span className="notif-body">{peopleText(n.body)}</span>}
                        <span className="notif-time">
                          <RelativeTime date={n.created_at} />
                        </span>
                      </span>
                      {n.unread && (
                        <span className="notif-dot">
                          <span className="sr-only">Unread</span>
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </Popover>
    </>
  );
}

/** Watch / Watching an article, finding or scope. Updates at once; same-size placeholder while it loads. */
export function WatchButton({ id, iconOnly }: { id: string; iconOnly?: boolean | "phone" }) {
  const { data, error, reload } = useApi<{ watching: boolean }>(`/watches/${id}`);
  if (error && !data) return null;
  return (
    <ToggleButton
      pressed={!!data?.watching}
      loading={!data}
      icon="eye"
      label="Watch"
      pressedLabel="Watching"
      iconOnly={iconOnly}
      tooltip="Get notified about changes"
      pressedTooltip="You'll be notified about changes. Click to stop."
      onPressedChange={async (next) => {
        await api(`/watches/${id}`, { method: next ? "PUT" : "DELETE" });
        reload();
      }}
    />
  );
}

/** How the server's notification kinds are grouped on Account. Unknown kinds go under "Other". */
const PREF_GROUPS: { title: string; kinds: string[] }[] = [
  { title: "Reviews", kinds: ["review", "assigned", "decided", "comment"] },
  { title: "Changes", kinds: ["change", "watch", "stale"] },
  { title: "Security", kinds: ["security"] },
  { title: "Connections", kinds: ["connection"] },
  { title: "Access", kinds: ["access"] },
];

type SaveStatus = "saving" | "saved" | "error";

/** Email preferences per notification type: switches that save as you go, grouped, with an inline status. */
export function NotificationPrefs() {
  const { data, error, reload } = useApi<{ prefs: { email?: Record<string, boolean>; digest?: boolean }; kinds: { kind: string; label: string }[]; email_enabled: boolean }>(
    "/account/prefs",
  );
  const [email, setEmail] = useState<Record<string, boolean> | null>(null);
  const [digest, setDigest] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Record<string, SaveStatus>>({});
  const toast = useToast();
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  if (!data) {
    return (
      <section className="notif-prefs" aria-busy={!error}>
        <h2>Notifications</h2>
        {error ? (
          <Callout tone="danger" actions={<button type="button" className="link-btn" onClick={reload}>Try again</button>}>
            Couldn't load your notification settings.
          </Callout>
        ) : (
          <SkeletonRows count={4} density="compact" />
        )}
      </section>
    );
  }

  const current = email ?? data.prefs.email ?? {};
  const digestOn = digest ?? data.prefs.digest !== false;

  async function save(key: string, patch: object, undo: () => void) {
    clearTimeout(timers.current[key]);
    setStatus((s) => ({ ...s, [key]: "saving" }));
    try {
      await api("/account/prefs", { method: "PUT", body: patch });
      setStatus((s) => ({ ...s, [key]: "saved" }));
      timers.current[key] = setTimeout(() => setStatus((s) => {
        const { [key]: _, ...rest } = s;
        return rest;
      }), 2500);
    } catch (e) {
      undo();
      setStatus((s) => ({ ...s, [key]: "error" }));
      toast.error(e, { title: "Couldn't save that setting" });
    }
  }

  const toggleKind = (kind: string, on: boolean) => {
    const before = current;
    const next = { ...current, [kind]: on };
    setEmail(next);
    void save(kind, { email: next }, () => setEmail(before));
  };

  const known = new Set(PREF_GROUPS.flatMap((g) => g.kinds));
  const groups = [
    ...PREF_GROUPS.map((g) => ({ title: g.title, kinds: data.kinds.filter((k) => g.kinds.includes(k.kind)) })),
    { title: "Other", kinds: data.kinds.filter((k) => !known.has(k.kind)) },
  ].filter((g) => g.kinds.length);

  return (
    <section className="notif-prefs" id="notifications">
      <h2>Notifications</h2>
      <p className="muted">Everything appears under the bell. {data.email_enabled ? "Choose what is also emailed to you." : null}</p>
      {!data.email_enabled && (
        <Callout tone="warning">Email delivery isn't set up on this server, so these choices apply once an Administrator configures it.</Callout>
      )}
      {groups.map((g) => (
        <fieldset key={g.title} className="notif-prefs-group">
          <legend className="notif-prefs-legend">{g.title}</legend>
          {g.kinds.map((k) => (
            <Switch key={k.kind} label={k.label} checked={current[k.kind] !== false} status={status[k.kind]} onChange={(on) => toggleKind(k.kind, on)} />
          ))}
        </fieldset>
      ))}
      <fieldset className="notif-prefs-group">
        <legend className="notif-prefs-legend">Weekly summary email</legend>
        <Switch
          label="Weekly digest of what's new in my projects"
          checked={digestOn}
          status={status.digest}
          onChange={(on) => {
            setDigest(on);
            void save("digest", { digest: on }, () => setDigest(!on));
          }}
        />
      </fieldset>
    </section>
  );
}
