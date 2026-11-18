/// <reference types="vite/client" />
import { ServiceAccountsPage } from "./pages/service-accounts";
import { AuditLogPage } from "./pages/audit";
import { can } from "./components/permissions";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, authApi, getToken, may, setToken, type Me, type ScopeInfo } from "./api";
import { AccountPage, ForcedPasswordChange, LoginPage, PersonAccessPage, UsersPage } from "./pages/account";
import { RolesPage } from "./components/roles";
import { ProjectsPage } from "./pages/projects";
import { SystemSettingsPage } from "./pages/system";
import { NotificationsAdminPage } from "./pages/notification-routes";
import { ScopeSettingsPage } from "./pages/settings";
import { ConnectPage } from "./pages/connect";
import { Dashboard } from "./pages/dashboard";
import { EntityPage } from "./pages/entity";
import { GraphPage } from "./pages/graph";
import { TrashPage } from "./pages/trash";
import { WhatsNewPage } from "./pages/whats-new";
import { TeamPage, TeamsPage } from "./pages/teams";
import { MetricsPage } from "./pages/metrics";
import { InviteAcceptPage } from "./pages/invite";
import { ImportPage, NewProjectPage } from "./pages/setup";
import { PasteDraftPage } from "./pages/paste";
import { InboxPage, SourcesPage } from "./pages/sources";
import { SecurityPage, VulnerabilityPage } from "./pages/security";
import { SessionsPage } from "./pages/sessions";
import { DesignPage } from "./pages/design";
import { HistoryPage } from "./pages/history";
import { Layout } from "./components/Layout";
import { ProjectPage, ScopePage, SearchPage } from "./pages/browse";
import { ArticlePage, FindingPage, NewArticlePage, NewFindingPage } from "./pages/items";
import { ReviewQueuePage, RevisionPage } from "./pages/review";
import { SkillImportPage, SkillImportReportPage, SkillSourcePage, SkillsPage } from "./pages/skills";
import { SkillDetailPage } from "./pages/skill-detail";
import type { Route } from "./router";
import { openShellPanel, replaceRoute, useAppRoute, useRemountKey } from "./hooks";
import { BootProvider, PageMetaProvider, useBoot, type BootData } from "./components/boot";
import { firstAdminTab } from "./components/nav";
import { humanizeError } from "./components/labels";
import { KitProvider } from "./components/kit/overlay";
import { Button } from "./components/kit/button";
import { EmptyState, SkeletonText } from "./components/kit/feedback";
import { Field, PasswordInput } from "./components/kit/form";
import { Disclosure } from "./components/kit/page";
import { GateCard, Splash } from "./components/kit/gate";

/** The component gallery (#/dev/kit): DEV builds only, loaded on demand (not in production bundles). */
const KitGallery = import.meta.env.DEV ? lazy(() => import("./components/kit/gallery").then((m) => ({ default: m.KitGallery }))) : null;

type SignInMode = "local" | "cloudflare" | "dev";

/** Toasts and confirmations wrap everything, gates included (SPEC §5.16 Providers). */
export function App() {
  return (
    <KitProvider>
      <AppRoutes />
    </KitProvider>
  );
}

/**
 * Boot (SPEC §6.1.5): /me, then /scopes. 401 → the sign-in mode from /config; 403 approval_required → the waiting
 * gate; must_change_password → the forced change. Gates render before the shell.
 */
function AppRoutes() {
  const route = useAppRoute();
  const [boot, setBoot] = useState<BootData | null>(null);
  const [signIn, setSignIn] = useState<SignInMode | null>(null);
  const [mustChange, setMustChange] = useState<Me | null>(null);
  // Signed in, but an Administrator or User manager still has to approve this account.
  const [waiting, setWaiting] = useState<{ email: string | null; mode: SignInMode | null; checked: boolean } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let stale = false;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const me = await api<Me>("/me");
        if (stale) return;
        if (me.must_change_password) {
          setWaiting(null);
          setMustChange(me);
          return;
        }
        const s = await api<{ scopes: ScopeInfo[]; article_types: string[]; finding_types: string[] }>("/scopes");
        if (stale) return;
        setMustChange(null);
        setWaiting(null);
        setBoot({ me, scopes: s.scopes, articleTypes: s.article_types, findingTypes: s.finding_types });
      } catch (e) {
        if (stale) return;
        if (e instanceof ApiError && e.status === 401) {
          try {
            const { mode } = await authApi<{ mode: SignInMode }>("/config");
            if (!stale) setSignIn(mode);
          } catch (e2) {
            if (!stale) setError(e2 as Error);
          }
        } else if (e instanceof ApiError && e.status === 403 && e.body?.code === "approval_required") {
          const mode = await authApi<{ mode: SignInMode }>("/config").then((c) => c.mode).catch(() => null);
          if (!stale) setWaiting((w) => ({ email: e.body.email ?? null, mode, checked: w !== null }));
        } else setError(e as Error);
      } finally {
        if (!stale) setBusy(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [attempt]);

  const retry = () => {
    setSignIn(null);
    setAttempt((a) => a + 1);
  };
  /** Sign out without a reload (gates and the signed-in invitation card), then boot again. */
  const signOutAndReboot = async () => {
    await authApi("/logout", {}).catch(() => undefined);
    setBoot(null);
    setWaiting(null);
    retry();
  };

  // DEV: the component gallery works without the API (it brings demo data when nobody is signed in).
  if (KitGallery && !boot && route.path[0] === "dev" && route.path[1] === "kit") {
    return (
      <main className="content">
        <Suspense fallback={<SkeletonText lines={6} />}>
          <KitGallery />
        </Suspense>
      </main>
    );
  }
  // Invitation links work before there is an account.
  if (route.path[0] === "invite" && route.path[1] && !boot) return <InviteAcceptPage token={route.path[1]} onDone={retry} />;
  if (signIn === "local") return <LoginPage onSignedIn={retry} />;
  if (signIn === "dev") {
    return (
      <TokenGate
        hadToken={!!getToken()}
        onSubmit={(t) => {
          setToken(t);
          retry();
        }}
      />
    );
  }
  if (signIn === "cloudflare") {
    return (
      <GateCard
        title="Your session has ended"
        icon="lock"
        description={<p>Sign in again to continue.</p>}
      >
        {/* Allowed reload (SPEC §6.1.2): Cloudflare Access signs the browser in again on the way back. */}
        <Button variant="primary" size="lg" block onClick={() => window.location.reload()}>
          Sign in again
        </Button>
      </GateCard>
    );
  }
  if (waiting) {
    return (
      <GateCard
        title="Waiting for approval"
        icon="clock"
        description={
          <p>
            {waiting.email ? `You're signed in as ${waiting.email}, but` : "You're signed in, but"} an Administrator or User manager has to approve your access before you can use
            Thaliyola. They have been told.
          </p>
        }
        footer={
          waiting.mode === "local" ? (
            <button type="button" className="link-btn" onClick={signOutAndReboot}>
              Sign out
            </button>
          ) : undefined
        }
      >
        <Button variant="primary" size="lg" block loading={busy} loadingText="Checking" onClick={retry}>
          Check again
        </Button>
        {waiting.checked && !busy && (
          <p className="muted small gate-status" role="status">
            Last checked just now
          </p>
        )}
      </GateCard>
    );
  }
  if (mustChange) return <ForcedPasswordChange me={mustChange} onDone={retry} />;
  if (error && !boot) return <BootError error={error} busy={busy} onRetry={retry} />;
  if (!boot) return <Splash />;

  return (
    <BootProvider initial={boot}>
      <PageMetaProvider>
        <SignedInApp route={route} onSignOut={signOutAndReboot} />
      </PageMetaProvider>
    </BootProvider>
  );
}

/** The shell and the page for the route. Reads me and scopes from BootProvider, so reloadScopes() reaches pages. */
function SignedInApp({ route, onSignOut }: { route: Route; onSignOut: () => Promise<void> }) {
  const { me, scopes, articleTypes, findingTypes } = useBoot();
  const remountKey = useRemountKey();
  const [section, id] = route.path;
  const adminTarget = section === "admin" && !id ? firstAdminTab({ me, scopes }) : null;

  // #/admin → the first Admin tab this person may see (replaces the URL); none → NotFound.
  useEffect(() => {
    if (adminTarget) replaceRoute(adminTarget.href.replace(/^#/, ""));
  }, [adminTarget]);

  let page: ReactNode;
  switch (section) {
    case undefined:
      page = <Dashboard scopes={scopes} me={me} />;
      break;
    case "search":
      page = <SearchPage route={route} />;
      break;
    case "scope":
      page =
        route.path[2] === "settings" ? (
          <ScopeSettingsPage slug={id!} scopes={scopes} me={me} route={route} />
        ) : route.path[2] === "design" ? (
          <DesignPage slug={id!} />
        ) : (
          <ScopePage slug={id!} scopes={scopes} me={me} />
        );
      break;
    case "project":
      page = <ProjectPage slug={id!} route={route} me={me} scopes={scopes} />;
      break;
    case "article":
      page = <ArticlePage id={id!} route={route} me={me} scopes={scopes} />;
      break;
    case "finding":
      page = <FindingPage id={id!} route={route} me={me} scopes={scopes} />;
      break;
    case "new":
      page =
        id === "paste" ? (
          <PasteDraftPage />
        ) : id === "project" ? (
          <NewProjectPage me={me} scopes={scopes} parent={route.query.get("parent") ?? undefined} />
        ) : id === "finding" ? (
          <NewFindingPage route={route} scopes={scopes} findingTypes={findingTypes} />
        ) : id === "article" ? (
          <NewArticlePage route={route} scopes={scopes} articleTypes={articleTypes} />
        ) : (
          <NotFound />
        );
      break;
    case "graph":
      page = <GraphPage route={route} scopes={scopes} />;
      break;
    case "entity":
      page = <EntityPage kind={id!} name={route.path[2] ?? ""} />;
      break;
    case "trash":
      page = <TrashPage />;
      break;
    case "sessions":
      page = <SessionsPage route={route} scopes={scopes} />;
      break;
    case "whats-new":
      page = <WhatsNewPage />;
      break;
    case "security":
      page = id ? <VulnerabilityPage id={id} /> : <SecurityPage route={route} scopes={scopes} isAdmin={may(me, "security_admin")} />;
      break;
    case "inbox":
      page = <InboxPage route={route} scopes={scopes} />;
      break;
    case "sources":
      page = <SourcesPage scopes={scopes} me={me} />;
      break;
    case "teams":
      page = id ? <TeamPage slug={id} scopes={scopes} me={me} /> : <TeamsPage me={me} />;
      break;
    case "metrics":
      page = <MetricsPage me={me} route={route} />;
      break;
    case "import":
      page = <ImportPage scopes={scopes} articleTypes={articleTypes} />;
      break;
    case "invite":
      page = <SignedInInvite me={me} onSignOut={onSignOut} />;
      break;
    case "history":
      page = <HistoryPage id={id!} />;
      break;
    case "skills":
      page =
        id === undefined ? (
          <SkillsPage route={route} me={me} scopes={scopes} />
        ) : id === "import" ? (
          <SkillImportPage me={me} scopes={scopes} />
        ) : id === "imports" && route.path[2] ? (
          <SkillImportReportPage id={route.path[2]} me={me} scopes={scopes} />
        ) : id === "sources" && route.path[2] ? (
          <SkillSourcePage id={route.path[2]} me={me} scopes={scopes} />
        ) : (
          <SkillDetailPage id={id} route={route} me={me} scopes={scopes} />
        );
      break;
    case "connect":
      page = <ConnectPage />;
      break;
    case "account":
      page = <AccountPage me={me} />;
      break;
    case "roles":
      // Everyone signed in: what each role allows and who has it (ADDENDUM-roles §1.1).
      page = <RolesPage me={me} />;
      break;
    case "admin":
      page = !id ? (
        adminTarget ? null : <NotFound />
      ) : id === "users" && route.path[2] ? (
        // Someone's access page; matched before the one-segment fallback below.
        <PersonAccessPage id={route.path[2]} me={me} />
      ) : id === "roles" ? (
        <RolesPage me={me} />
      ) : id === "projects" ? (
        <ProjectsPage />
      ) : id === "system" ? (
        <SystemSettingsPage />
      ) : id === "notifications" ? (
        <NotificationsAdminPage />
      ) : id === "service-accounts" ? (
        <ServiceAccountsPage />
      ) : id === "audit" ? (
        can.seeAuditLog(me) ? <AuditLogPage me={me} /> : <NotFound />
      ) : (
        // #/admin/users and any unknown one-segment admin route.
        <UsersPage me={me} scopes={scopes} />
      );
      break;
    case "review":
      page = id ? <RevisionPage id={id} /> : <ReviewQueuePage route={route} />;
      break;
    case "dev":
      page =
        KitGallery && id === "kit" ? (
          <Suspense fallback={<SkeletonText lines={6} />}>
            <KitGallery />
          </Suspense>
        ) : (
          <NotFound />
        );
      break;
    default:
      page = <NotFound />;
  }

  // Pages remount on navigation so each loads fresh state. A page that reads every URL value through
  // useQueryState or route.query may set `Page.keepMountedOnQuery = true`: it is then keyed on the path only,
  // so filter and tab changes re-render it instead of remounting (typing keeps focus).
  const type = (page as { type?: unknown } | null)?.type;
  const stay = !!type && typeof type === "function" && (type as { keepMountedOnQuery?: boolean }).keepMountedOnQuery === true;
  const key = route.path.join("/") + (stay ? "" : "?" + route.query.toString()) + "#" + remountKey;

  return (
    <Layout me={me} scopes={scopes} route={route}>
      <div key={key} className="page-root">
        {page}
      </div>
    </Layout>
  );
}

/** Unknown routes, inside the shell (SPEC §2.11). */
function NotFound() {
  useEffect(() => {
    document.title = "Page not found · Thaliyola";
  }, []);
  return (
    <div className="page not-found">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon="search"
        title="Page not found"
        description="This page doesn't exist or was moved."
        primary={
          <Button variant="primary" href="#/">
            Go to Home
          </Button>
        }
        secondary={
          <Button icon="search" onClick={() => openShellPanel("search")}>
            Search
          </Button>
        }
      />
    </div>
  );
}

/** A signed-in person opened an invitation link (SPEC §6.1.5). */
function SignedInInvite({ me, onSignOut }: { me: Me; onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = "Invitation · Thaliyola";
  }, []);
  return (
    <GateCard
      inline
      title="You're already signed in"
      icon="mail"
      description={<p>You're already signed in as {me.email ?? "a service account"}. Sign out first to accept an invitation for another address.</p>}
      footer={<a href="#/">Go to Home</a>}
    >
      {me.auth_mode === "local" && (
        <Button
          variant="primary"
          size="lg"
          block
          loading={busy}
          loadingText="Signing out"
          onClick={async () => {
            setBusy(true);
            await onSignOut();
          }}
        >
          Sign out and accept
        </Button>
      )}
    </GateCard>
  );
}

/** Boot failed for another reason than signing in: the humanized message, the raw text, and Try again. */
function BootError({ error, busy, onRetry }: { error: Error; busy: boolean; onRetry: () => void }) {
  const { title } = humanizeError(error);
  const raw = error instanceof ApiError ? `HTTP ${error.status}: ${error.message}` : error.message || String(error);
  return (
    <GateCard title="Can't reach Thaliyola" icon="alert" description={<p role="alert">{title}</p>}>
      <Disclosure summary="Technical details">
        <pre className="gate-technical">{raw}</pre>
      </Disclosure>
      <Button variant="primary" size="lg" block icon="refresh" loading={busy} loadingText="Trying again" onClick={onRetry}>
        Try again
      </Button>
    </GateCard>
  );
}

/** Dev mode only: behind Cloudflare Access the browser is already signed in. */
function TokenGate({ hadToken, onSubmit }: { hadToken: boolean; onSubmit: (token: string) => void }) {
  const [token, setValue] = useState("");
  // The error shows after a submit, or when a stored token was refused.
  const [submitted, setSubmitted] = useState(false);
  const [empty, setEmpty] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refused = hadToken || submitted;
  return (
    <GateCard
      title="Sign in"
      icon="key"
      description={<p>Enter your access token to use Thaliyola.</p>}
      footer={<span className="muted">Developer setup: tokens come from DEV_TOKENS on the server.</span>}
    >
      <form
        className="gate-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!token.trim()) {
            setEmpty(true);
            input.current?.focus();
            return;
          }
          setSubmitted(true);
          onSubmit(token.trim());
        }}
      >
        <Field label="Access token" hint="Ask an Administrator for an access token." error={empty ? "Enter your access token." : refused ? "That token wasn't accepted." : undefined}>
          <PasswordInput
            ref={input}
            value={token}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => {
              setValue(e.target.value);
              setEmpty(false);
            }}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block>
          Sign in
        </Button>
      </form>
    </GateCard>
  );
}
