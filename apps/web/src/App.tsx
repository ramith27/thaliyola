import { useEffect, useState } from "react";
import { api, ApiError, getToken, setToken, type Me, type ScopeInfo } from "./api";
import { Layout } from "./components/Layout";
import { ErrorBox, Loading } from "./components/ui";
import { HomePage, ProjectPage, ScopePage, SearchPage } from "./pages/browse";
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
  const [needsToken, setNeedsToken] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    Promise.all([api<Me>("/me"), api<{ scopes: ScopeInfo[]; article_types: string[]; finding_types: string[] }>("/scopes")])
      .then(([me, s]) => setBoot({ me, scopes: s.scopes, articleTypes: s.article_types, findingTypes: s.finding_types }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
        else setError(e);
      });
  }, [attempt]);

  if (needsToken) {
    return (
      <TokenGate
        hadToken={!!getToken()}
        onSubmit={(t) => {
          setToken(t);
          setNeedsToken(false);
          setAttempt((a) => a + 1);
        }}
      />
    );
  }
  if (error) return <ErrorBox error={error} />;
  if (!boot) return <Loading />;

  const [section, id] = route.path;
  let page;
  switch (section) {
    case undefined:
      page = <HomePage scopes={boot.scopes} />;
      break;
    case "search":
      page = <SearchPage route={route} />;
      break;
    case "scope":
      page = <ScopePage slug={id!} scopes={boot.scopes} />;
      break;
    case "project":
      page = <ProjectPage slug={id!} route={route} />;
      break;
    case "article":
      page = <ArticlePage id={id!} route={route} />;
      break;
    case "finding":
      page = <FindingPage id={id!} route={route} />;
      break;
    case "new":
      page =
        id === "finding" ? (
          <NewFindingPage route={route} scopes={boot.scopes} findingTypes={boot.findingTypes} />
        ) : (
          <NewArticlePage route={route} scopes={boot.scopes} articleTypes={boot.articleTypes} />
        );
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
        <h1>Cairn</h1>
        <p className="muted">{hadToken ? "That token was not accepted." : "Not signed in."} Enter a dev token (DEV_TOKENS on the server).</p>
        <input type="password" value={token} onChange={(e) => setValue(e.target.value)} placeholder="dev token" autoFocus />
        <button className="btn btn-primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
