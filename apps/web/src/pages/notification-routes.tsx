import { useId, useMemo, useState, type FormEvent } from "react";
import { api, type ScopeInfo } from "../api";
import { I, type IconName } from "../components/icons";
import {
  AdminTabs,
  AsyncBlock,
  Button,
  Callout,
  ChoiceCards,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  humanizeError,
  ListRow,
  MetaLine,
  OverflowMenu,
  Page,
  PageHeader,
  RelativeTime,
  RowList,
  Section,
  Select,
  Sheet,
  SkeletonRows,
  StatusBadge,
  useConfirm,
  useToast,
} from "../components/kit";
import { useBoot } from "../components/boot";
import { DIGEST_FREQUENCY, ROUTE_KIND } from "../components/labels";
import { useApi, useMediaQuery } from "../hooks";
import { href } from "../router";
import { ConnectionsSettings } from "./connections";

/**
 * Where notifications go besides Thaliyola: Slack channels and Trello lists (the place's own Slack and Trello
 * connections), each with the kinds of notifications it gets. A project's routes are set up by its Project admins
 * under Settings › Notifications; team-wide ones by Administrators under Admin › Notifications. A project's Slack
 * route can also post a daily or weekly digest. Secrets never come here: destinations are named, never shown.
 */

type Digest = "off" | "daily" | "weekly";
interface Destination {
  id: string;
  name: string;
  kind: string;
  label: string;
  health: "untested" | "ok" | "failing";
  enabled: boolean;
}
interface Route {
  id: string;
  kinds: string[];
  digest: Digest;
  digest_sent_at: string | null;
  created_at: string;
  created_by: string | null;
  created_by_email?: string | null;
  destination: Destination & { last_error: string | null; last_ok_at: string | null };
}
interface RoutesData {
  scope: { slug: string; name: string; visibility: "team" | "members" } | null;
  enabled: boolean;
  routes: Route[];
  destinations: Destination[];
  kinds: { kind: string; label: string }[];
  digests: { hour: number; day: number } | null;
}

const DEST_ICON: Record<string, IconName> = { slack: "hash", trello: "list" };
const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hourText = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** "Daily digest, 08:00" / "Weekly digest, Mondays 08:00" (server time). */
export function digestWhen(digest: Digest, at: { hour: number; day: number } | null): string {
  if (digest === "off" || !at) return DIGEST_FREQUENCY.off!;
  return digest === "daily" ? `Daily digest, ${hourText(at.hour)}` : `Weekly digest, ${DAYS[at.day] ?? "Mondays"} ${hourText(at.hour)}`;
}

/** "Reviews, Comments and 2 more" for the row description. */
export function kindsText(kinds: string[]): string {
  if (!kinds.length) return "No notifications, digest only";
  const names = kinds.map((k) => ROUTE_KIND[k] ?? k);
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

export function NotificationRoutes({ scope }: { scope: ScopeInfo | null }) {
  const path = scope ? `/projects/${scope.slug}/notification-routes` : "/notification-routes";
  const result = useApi<RoutesData>(path);
  const { data, reload } = result;
  const toast = useToast();
  const confirm = useConfirm();
  const [sheet, setSheet] = useState<{ route: Route | null } | null>(null);
  const [busy, setBusy] = useState<Record<string, "digest" | "remove" | undefined>>({});
  const [rowError, setRowError] = useState<Record<string, string | undefined>>({});
  const team = !scope;

  async function sendDigest(r: Route) {
    setBusy((b) => ({ ...b, [r.id]: "digest" }));
    setRowError((e) => ({ ...e, [r.id]: undefined }));
    try {
      const out = await api<{ ok: true; sent: boolean; detail: string } | { ok: false; error: string }>(`/notification-routes/${r.id}/digest`, { method: "POST" });
      if (!out.ok) toast.error(out.error, { title: `${r.destination.name} didn't take the digest` });
      else if (out.sent) toast.success(out.detail);
      else toast.info(out.detail);
      reload();
    } catch (e) {
      setRowError((x) => ({ ...x, [r.id]: `Couldn't send it: ${humanizeError(e).title}` }));
    } finally {
      setBusy((b) => ({ ...b, [r.id]: undefined }));
    }
  }

  async function remove(r: Route) {
    const ok = await confirm({
      title: `Stop sending to ${r.destination.name}?`,
      body: `${scope ? scope.name : "Team-wide"} notifications${r.digest !== "off" ? " and digests" : ""} stop going there. The connection itself stays.`,
      confirmLabel: "Remove route",
      tone: "danger",
    });
    if (!ok) return;
    setBusy((b) => ({ ...b, [r.id]: "remove" }));
    try {
      await api(`/notification-routes/${r.id}`, { method: "DELETE" });
      toast.success(`Notifications no longer go to ${r.destination.name}`);
      reload();
    } catch (e) {
      setRowError((x) => ({ ...x, [r.id]: `Couldn't remove it: ${humanizeError(e).title}` }));
    } finally {
      setBusy((b) => ({ ...b, [r.id]: undefined }));
    }
  }

  const free = data ? data.destinations.filter((d) => !data.routes.some((r) => r.destination.id === d.id)) : [];
  const add = (
    <Button icon="plus" onClick={() => setSheet({ route: null })} disabledReason={!data ? "Wait for the page to load" : free.length ? undefined : "Every channel and list already has a route; edit one instead"}>
      Add route
    </Button>
  );
  const addChannel = scope ? (
    <Button icon="plug" href={href(`/scope/${scope.slug}/settings`, { tab: "connections" })}>
      Add a Slack channel or Trello list
    </Button>
  ) : undefined;

  return (
    <Section
      title={team ? "Team-wide routes" : "Where notifications go"}
      count={data?.routes.length}
      description={
        team
          ? "Notifications from every team-visible project and space, and access requests, also go to these channels and lists, once per event. Members-only projects' notifications only go to their own routes (a request for one arrives without its name); security alerts arrive as their title alone."
          : `${scope.name}'s notifications, and its sub-projects', also go to these Slack channels and Trello lists, once per event, whoever they tell in Thaliyola. A Slack channel can also get a daily or weekly digest of the project.`
      }
      actions={data && data.routes.length > 0 && add}
    >
      {data && !data.enabled && (
        <Callout tone="warning" title="Nothing is being sent right now.">
          Connections are turned off on this server, so routes are kept but no notification or digest goes out until an Administrator turns them back on.
        </Callout>
      )}
      {scope && data?.scope?.visibility === "members" && data.routes.length > 0 && (
        <Callout tone="neutral" icon="lock">
          {scope.name} is members-only, but anyone in these channels and on these boards sees its notifications (and its sub-projects'). Pick the kinds with that in mind.
        </Callout>
      )}
      <AsyncBlock result={result} label="Loading notification routes" skeleton={<SkeletonRows count={2} />} errorTitle="Couldn't load notification routes">
        {(d) =>
          !d.routes.length ? (
            d.destinations.length ? (
              <EmptyState icon="bell" title="No routes yet" description="Choose a Slack channel or Trello list and which notifications it gets." primary={add} />
            ) : (
              <EmptyState
                icon="bell"
                title="No Slack channel or Trello list yet"
                description={
                  team
                    ? "Add a Slack channel or Trello list under Notification channels above, then choose what goes there."
                    : `Add a Slack channel or Trello list under Connections, then come back to choose which of ${scope?.name ?? "the project"}'s notifications go there.`
                }
                primary={addChannel}
              />
            )
          ) : (
            <RowList label={team ? "Team-wide notification routes" : `Notification routes of ${scope?.name}`} refreshing={result.loading}>
              {d.routes.map((r) => {
                const dest = r.destination;
                return (
                  <ListRow
                    key={r.id}
                    leading={<I name={DEST_ICON[dest.kind] ?? "bell"} size={20} />}
                    title={dest.name}
                    badges={<StatusBadge domain="connection" value={dest.enabled ? dest.health : "paused"} />}
                    description={kindsText(r.kinds)}
                    meta={
                      // One line when there's room; on a phone, one fact per line (no line starts or ends with a separator).
                      <span className="cn-route-meta">
                        <MetaLine
                          items={[
                            dest.label,
                            r.digest !== "off" ? digestWhen(r.digest, d.digests) : null,
                            r.digest !== "off" && r.digest_sent_at ? <RelativeTime key="dg" prefix="Last digest " date={r.digest_sent_at} /> : null,
                            dest.last_ok_at ? <RelativeTime key="ok" prefix="Last delivered " date={dest.last_ok_at} /> : null,
                          ]}
                        />
                      </span>
                    }
                    extra={
                      dest.health === "failing" && dest.last_error ? (
                        <Disclosure summary={<span className="cn-error-text">Why deliveries fail</span>}>
                          <p className="cn-error-detail">{dest.last_error}</p>
                        </Disclosure>
                      ) : undefined
                    }
                    error={rowError[r.id]}
                    actions={
                      <>
                        <Button size="sm" icon="pencil" onClick={() => setSheet({ route: r })} disabledReason={busy[r.id] ? "Wait for the current action to finish" : undefined}>
                          Edit
                        </Button>
                        <OverflowMenu
                          label={`More actions for ${dest.name}`}
                          size="sm"
                          items={[
                            ...(r.digest !== "off"
                              ? [
                                  {
                                    id: "digest",
                                    label: "Send the digest now",
                                    icon: "mail" as IconName,
                                    onSelect: () => void sendDigest(r),
                                    disabledReason: !d.enabled ? "Connections are turned off on this server" : busy[r.id] ? "Wait for the current action to finish" : undefined,
                                  },
                                ]
                              : []),
                            ...(scope ? [{ id: "conn", label: "Open its connection", icon: "plug" as IconName, href: href(`/scope/${scope.slug}/settings`, { tab: "connections" }) }] : []),
                            { type: "separator" as const },
                            { id: "remove", label: "Remove…", icon: "trash", tone: "danger" as const, onSelect: () => void remove(r), disabledReason: busy[r.id] ? "Wait for the current action to finish" : undefined },
                          ]}
                        />
                      </>
                    }
                  />
                );
              })}
            </RowList>
          )
        }
      </AsyncBlock>
      {sheet && data && (
        <RouteSheet
          scope={scope}
          data={data}
          route={sheet.route}
          free={free}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            reload();
          }}
        />
      )}
    </Section>
  );
}

/** Add a route, or change one: which destination, which kinds, and (a project's Slack channel) a digest. */
function RouteSheet({
  scope,
  data,
  route,
  free,
  onClose,
  onSaved,
}: {
  scope: ScopeInfo | null;
  data: RoutesData;
  route: Route | null;
  free: Destination[];
  onClose(): void;
  onSaved(): void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const formId = useId();
  const phone = useMediaQuery("(max-width: 640px)");
  const initial = useMemo(
    () => ({ destination: route?.destination.id ?? free[0]?.id ?? "", kinds: route?.kinds ?? data.kinds.map((k) => k.kind).filter((k) => k !== "decided" && k !== "comment"), digest: route?.digest ?? ("off" as Digest) }),
    [route, free, data.kinds],
  );
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dest = route?.destination ?? data.destinations.find((d) => d.id === form.destination);
  const digestable = !!scope && dest?.kind === "slack";
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const digest = digestable ? form.digest : "off";
    if (!form.kinds.length && digest === "off") {
      setError(digestable ? "Choose at least one kind of notification, or a digest." : "Choose at least one kind of notification.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      if (route) {
        await api(`/notification-routes/${route.id}`, { method: "PATCH", body: { kinds: form.kinds, digest } });
        toast.success(`Saved what goes to ${route.destination.name}`);
      } else {
        await api("/notification-routes", { method: "POST", body: { project: scope?.slug ?? null, connection_id: form.destination, kinds: form.kinds, digest } });
        toast.success(`Notifications now go to ${dest?.name ?? "the channel"}`);
      }
      onSaved();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (busy) return;
    if (dirty && !(await confirm({ title: "Discard your changes?", body: "What you chose here is lost.", confirmLabel: "Discard", cancelLabel: "Keep editing", tone: "danger" }))) return;
    onClose();
  }

  const at = data.digests;
  return (
    <Sheet
      open
      side={phone ? "bottom" : "right"}
      onClose={() => void close()}
      dismissible={!busy}
      title={route ? `What goes to ${route.destination.name}` : "Add a route"}
      description={scope ? `For ${scope.name}'s notifications.` : "For notifications from every team-visible project."}
      footer={
        <>
          <Button variant="ghost" onClick={() => void close()} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving…" disabledReason={!route && !form.destination ? "Choose a channel or list" : undefined}>
            {route ? "Save changes" : "Add route"}
          </Button>
        </>
      }
    >
      <form id={formId} className="cn-form" onSubmit={submit} noValidate>
        {route ? (
          <p className="cn-kind-fixed">
            <I name={DEST_ICON[route.destination.kind] ?? "bell"} size={16} /> {route.destination.label}: {route.destination.name}
          </p>
        ) : (
          <Field label="Send to" hint="The Slack channels and Trello lists added under Connections.">
            <Select
              value={form.destination}
              onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))}
              options={free.map((d) => ({ value: d.id, label: `${d.name} (${d.label})` }))}
            />
          </Field>
        )}
        <ChoiceCards
          name={`${formId}-kinds`}
          legend="Which notifications"
          type="checkbox"
          value={form.kinds}
          onChange={(v) => {
            setForm((f) => ({ ...f, kinds: v as string[] }));
            setError(null);
          }}
          options={data.kinds.map((k) => ({ value: k.kind, label: ROUTE_KIND[k.kind] ?? k.kind, description: k.label }))}
        />
        {digestable && (
          <ChoiceCards
            name={`${formId}-digest`}
            legend="Digest"
            value={form.digest}
            onChange={(v) => {
              setForm((f) => ({ ...f, digest: v as Digest }));
              setError(null);
            }}
            options={(["off", "daily", "weekly"] as const).map((v) => ({
              value: v,
              label: DIGEST_FREQUENCY[v] ?? v,
              description: v === "off" ? "Only the notifications chosen above." : v === "daily" ? `Every day at ${hourText(at?.hour ?? 8)} (server time).` : `${DAYS[at?.day ?? 1]} at ${hourText(at?.hour ?? 8)} (server time).`,
            }))}
          />
        )}
        {digestable && (
          <p className="cn-kind-note cn-digest-note">
            A digest lists what was published, what waits for review and for how long, and what needs re-verifying, with links. Nothing is posted when there&apos;s nothing to say.
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            <I name="alert" size={14} />
            {error}
          </p>
        )}
        {saveError != null && <ErrorState compact error={saveError} title={route ? "Couldn't save your changes" : "Couldn't add the route"} />}
      </form>
    </Sheet>
  );
}

/**
 * Admin › Notifications: the Team space's Slack channels and Trello lists, the team-wide routes to them, and the
 * Team space's issue trackers (Jira, Linear), which every project can open tickets with.
 */
export function NotificationsAdminPage() {
  const { scopes } = useBoot();
  const team = scopes.find((s) => s.kind === "team") ?? null;
  return (
    <Page width="content">
      <PageHeader
        title="Notifications"
        crumbs={[{ label: "Admin", href: href("/admin") }]}
        nav="admin"
        tabs={<AdminTabs current="notifications" />}
        description="Send notifications to Slack and Trello for the whole team, and connect Jira or Linear for tickets. Projects choose their own routes (and digests) and trackers in their settings."
      />
      {team ? (
        <ConnectionsSettings scope={team} groups={["notify"]} />
      ) : (
        <Callout tone="neutral">The Team space isn't set up yet.</Callout>
      )}
      <NotificationRoutes scope={null} />
      {team && <ConnectionsSettings scope={team} groups={["tracker"]} />}
    </Page>
  );
}
