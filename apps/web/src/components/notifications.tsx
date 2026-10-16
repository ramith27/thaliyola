import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { formatDate } from "./ui";
import { I, type IconName } from "./icons";

interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  created_at: string;
  read_at: string | null;
}

const KIND_ICON: Record<string, IconName> = {
  review: "inbox",
  assigned: "inbox",
  decided: "review",
  comment: "doc",
  change: "bolt",
  watch: "eye",
  stale: "alert",
  invite: "user",
};

/** Bell with unread count and a dropdown; polls every minute. */
export function NotificationBell() {
  const { data, reload } = useApi<{ notifications: Notification[]; unread: number }>("/notifications");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(reload, 60_000);
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => {
      clearInterval(t);
      document.removeEventListener("mousedown", close);
    };
  }, [reload]);

  async function openItem(n: Notification) {
    setOpen(false);
    if (!n.read_at) await api("/notifications/read", { method: "POST", body: { ids: [n.id] } });
    reload();
    if (n.link) window.location.hash = n.link.replace(/^#/, "");
  }

  const unread = data?.unread ?? 0;
  return (
    <div className="user-menu" ref={ref}>
      <button className="icon-btn bell-btn" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
        <I name="bell" size={18} />
        {unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="menu notif-menu" role="menu">
          <div className="notif-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button
                className="link-btn small"
                onClick={async () => {
                  await api("/notifications/read", { method: "POST", body: {} });
                  reload();
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          {!data?.notifications.length ? (
            <p className="muted small notif-empty">Nothing yet. You'll hear about reviews, changes to what you watch, and decisions on your proposals.</p>
          ) : (
            <ul className="notif-list">
              {data.notifications.map((n) => (
                <li key={n.id}>
                  <button className={`notif-item ${n.read_at ? "" : "unread"}`} onClick={() => openItem(n)}>
                    <span className="notif-icon">
                      <I name={KIND_ICON[n.kind] ?? "bell"} size={15} />
                    </span>
                    <span className="notif-text">
                      <span className="notif-title">{n.title}</span>
                      {n.body && <span className="muted small">{n.body}</span>}
                      <span className="muted small">{formatDate(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Watch / unwatch an article, finding or scope. */
export function WatchButton({ id }: { id: string }) {
  const { data, reload } = useApi<{ watching: boolean }>(`/watches/${id}`);
  if (!data) return null;
  return (
    <button
      className={`btn ${data.watching ? "btn-on" : ""}`}
      title={data.watching ? "You'll be notified about changes. Click to stop." : "Get notified about changes"}
      onClick={async () => {
        await api(`/watches/${id}`, { method: data.watching ? "DELETE" : "PUT" });
        reload();
      }}
    >
      <I name="eye" size={16} /> {data.watching ? "Watching" : "Watch"}
    </button>
  );
}

/** Email preferences per notification type. */
export function NotificationPrefs() {
  const { data, reload } = useApi<{ prefs: { email?: Record<string, boolean>; digest?: boolean }; kinds: { kind: string; label: string }[]; email_enabled: boolean }>("/account/prefs");
  if (!data) return null;
  const email = data.prefs.email ?? {};
  async function save(patch: object) {
    await api("/account/prefs", { method: "PUT", body: patch });
    reload();
  }
  return (
    <section>
      <h2>Notifications</h2>
      <p className="muted">
        Everything appears under the bell.{" "}
        {data.email_enabled ? "Choose what is also emailed to you:" : "Email delivery isn't set up on this server, so these choices apply once an admin configures it."}
      </p>
      <div className="prefs">
        {data.kinds.map((k) => (
          <label key={k.kind} className="toggle">
            <input type="checkbox" checked={email[k.kind] !== false} onChange={(e) => save({ email: { ...email, [k.kind]: e.target.checked } })} />
            {k.label}
          </label>
        ))}
        <label className="toggle">
          <input type="checkbox" checked={data.prefs.digest !== false} onChange={(e) => save({ digest: e.target.checked })} />
          Weekly digest of what's new in my projects
        </label>
      </div>
    </section>
  );
}
