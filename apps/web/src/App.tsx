import { useEffect, useState } from "react";
import { api, ApiError, authApi, getToken, setToken, type Me, type ScopeInfo } from "./api";
import { AccountPage, ForcedPasswordChange, LoginPage, UsersPage } from "./pages/account";
import { ScopeSettingsPage } from "./pages/settings";
import { ConnectPage } from "./pages/connect";
import { Dashboard } from "./pages/dashboard";
import { EntityPage } from "./pages/entity";
import { GraphPage } from "./pages/graph";
import { TrashPage } from "./pages/trash";
import { TeamPage, TeamsPage } from "./pages/teams";
import { MetricsPage } from "./pages/metrics";
import { InviteAcceptPage } from "./pages/invite";
import { ImportPage, NewProjectPage } from "./pages/setup";
import { PasteDraftPage } from "./pages/paste";
import { InboxPage, SourcesPage } from "./pages/sources";
import { SecurityPage, VulnerabilityPage } from "./pages/security";
import { HistoryPage } from "./pages/history";
import { Layout } from "./components/Layout";
import { ErrorBox, Loading } from "./components/ui";
import { ProjectPage, ScopePage, SearchPage } from "./pages/browse";
import { ArticlePage, FindingPage, NewArticlePage, NewFindingPage } from "./pages/items";
import { ReviewQueuePage, RevisionPage } from "./pages/review";
import { useRoute } from "./router";

interface Boot {
  me: Me;
  scopes: ScopeInfo[];
  articleTypes: string[];
  findingTypes: string[];
}

export function App() {
  const route = useRoute();
  const [boot, setBoot] = useState<Boot | null>(null);
  const [signIn, setSignIn] = useState<"local" | "cloudflare" | "dev" | null>(null);
  const [mustChange, setMustChange] = useState<Me | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        const me = await api<Me>("/me");
        if (me.must_change_password) return setMustChange(me);
        const s = await api<{ scopes: ScopeInfo[]; article_types: string[]; finding_types: string[] }>("/scopes");
        setMustChange(null);
        setBoot({ me, scopes: s.scopes, articleTypes: s.article_types, findingTypes: s.finding_types });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          const { mode } = await authApi<{ mode: "local" | "cloudflare" | "dev" }>("/config");
          setSignIn(mode);
        } else setError(e as Error);
      }
    })();
  }, [attempt]);

  const retry = () => {
    setSignIn(null);
    setAttempt((a) => a + 1);
  };

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
      <div className="gate">
        <div>
          <h1>Thaliyola</h1>
          <p className="muted">Your Cloudflare Access session has expired.</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Sign in again
          </button>
        </div>
      </div>
    );
  }
  if (mustChange) return <ForcedPasswordChange me={mustChange} onDone={retry} />;
  if (error) return <ErrorBox error={error} />;
  if (!boot) return <Loading />;

  const [section, id] = route.path;
  let page;
  switch (section) {
    case undefined:
      page = <Dashboard scopes={boot.scopes} me={boot.me} />;
      break;
    case "search":
      page = <SearchPage route={route} />;
      break;
    case "scope":
      page = route.path[2] === "settings" ? <ScopeSettingsPage slug={id!} scopes={boot.scopes} me={boot.me} route={route} /> : <ScopePage slug={id!} scopes={boot.scopes} me={boot.me} />;
      break;
    case "project":
      page = <ProjectPage slug={id!} route={route} me={boot.me} scopes={boot.scopes} />;
      break;
    case "article":
      page = <ArticlePage id={id!} route={route} me={boot.me} scopes={boot.scopes} />;
      break;
    case "finding":
      page = <FindingPage id={id!} route={route} me={boot.me} scopes={boot.scopes} />;
      break;
    case "new":
      page =
        id === "paste" ? (
          <PasteDraftPage />
        ) : id === "project" ? (
          <NewProjectPage />
        ) : id === "finding" ? (
          <NewFindingPage route={route} scopes={boot.scopes} findingTypes={boot.findingTypes} />
        ) : (
          <NewArticlePage route={route} scopes={boot.scopes} articleTypes={boot.articleTypes} />
        );
      break;
    case "graph":
      page = <GraphPage route={route} scopes={boot.scopes} />;
      break;
    case "entity":
      page = <EntityPage kind={id!} name={route.path[2] ?? ""} />;
      break;
    case "trash":
      page = <TrashPage />;
      break;
    case "security":
      page = id ? <VulnerabilityPage id={id} /> : <SecurityPage route={route} scopes={boot.scopes} isAdmin={boot.me.admin} />;
      break;
    case "inbox":
      page = <InboxPage route={route} scopes={boot.scopes} />;
      break;
    case "sources":
      page = <SourcesPage scopes={boot.scopes} me={boot.me} />;
      break;
    case "teams":
      page = id ? <TeamPage slug={id} scopes={boot.scopes} me={boot.me} /> : <TeamsPage me={boot.me} />;
      break;
    case "metrics":
      page = <MetricsPage me={boot.me} route={route} />;
      break;
    case "import":
      page = <ImportPage scopes={boot.scopes} articleTypes={boot.articleTypes} />;
      break;
    case "invite":
      page = <p className="page">You're already signed in as {boot.me.email}. Sign out first to accept an invitation for another address.</p>;
      break;
    case "history":
      page = <HistoryPage id={id!} />;
      break;
    case "connect":
      page = <ConnectPage />;
      break;
    case "account":
      page = <AccountPage me={boot.me} />;
      break;
    case "admin":
      page = <UsersPage me={boot.me} scopes={boot.scopes} />;
      break;
    case "review":
      page = id ? <RevisionPage id={id} /> : <ReviewQueuePage route={route} />;
      break;
    default:
      page = <p>Page not found.</p>;
  }

  return (
    <Layout me={boot.me} scopes={boot.scopes} route={route}>
      {/* Remount pages on navigation so each loads fresh state. */}
      <div key={route.path.join("/") + "?" + route.query.toString()}>{page}</div>
    </Layout>
  );
}

/** Dev mode only: behind Cloudflare Access the browser is already signed in. */
function TokenGate({ hadToken, onSubmit }: { hadToken: boolean; onSubmit: (token: string) => void }) {
  const [token, setValue] = useState("");
  return (
    <div className="gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) onSubmit(token.trim());
        }}
      >
        <h1>Thaliyola</h1>
        <p className="muted">{hadToken ? "That token was not accepted." : "Not signed in."} Enter a dev token (DEV_TOKENS on the server).</p>
        <input type="password" value={token} onChange={(e) => setValue(e.target.value)} placeholder="dev token" autoFocus />
        <button className="btn btn-primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
