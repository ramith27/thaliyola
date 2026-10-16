import { useEffect } from "react";
import { recordVisit } from "../components/find";
import { I } from "../components/icons";
import { ErrorBox, formatDate, Loading, ScopeBadge, StatusBadge, TypeBadge } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

interface Entity {
  kind: string;
  name: string;
  aliases: string[];
  items: { kind: "article" | "finding"; id: string; title: string; type: string; status: string; scope: string; updated_at: string }[];
  related: { kind: string; name: string; shared: number }[];
}

/** Everything the team has written about one system, table, metric or service. */
export function EntityPage({ kind, name }: { kind: string; name: string }) {
  const { data, error } = useApi<Entity>(`/entities/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
  useEffect(() => {
    if (data) recordVisit({ kind: "entity", id: `${data.kind}:${data.name}`, title: data.name, link: href(`/entity/${data.kind}/${data.name}`) });
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const articles = data.items.filter((i) => i.kind === "article");
  const findings = data.items.filter((i) => i.kind === "finding");
  return (
    <div className="page with-side">
      <article>
        <p className="breadcrumbs muted small">Entities / {data.kind}</p>
        <h1>{data.name}</h1>
        <div className="badges">
          <span className="badge badge-type">{data.kind}</span>
          {data.aliases.length > 0 && <span className="muted small">also called {data.aliases.join(", ")}</span>}
        </div>
        <ItemList title="Articles" icon="doc" items={articles} />
        <ItemList title="Findings" icon="bolt" items={findings} />
        {!data.items.length && <p className="muted">Nothing you can read mentions {data.name} yet.</p>}
      </article>
      <aside className="side">
        <section className="side-block">
          <h3>Often mentioned with</h3>
          {!data.related.length && <p className="muted small">No other entities yet.</p>}
          <ul className="plain">
            {data.related.map((r) => (
              <li key={`${r.kind}:${r.name}`}>
                <a href={href(`/entity/${r.kind}/${r.name}`)}>{r.name}</a> <span className="muted small">{r.kind}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="side-block">
          <h3>Search</h3>
          <p className="small">
            <a href={href("/search", { q: data.name })}>Search everything for “{data.name}”</a>
          </p>
        </section>
      </aside>
    </div>
  );
}

function ItemList({ title, icon, items }: { title: string; icon: "doc" | "bolt"; items: Entity["items"] }) {
  if (!items.length) return null;
  return (
    <section>
      <h2>
        {title} <span className="muted small">{items.length}</span>
      </h2>
      <ul className="hits">
        {items.map((i) => (
          <li key={i.id} className="hit">
            <div className="hit-head">
              <I name={icon} size={16} /> <a href={href(`/${i.kind}/${i.id}`)}>{i.title}</a>
            </div>
            <div className="badges">
              <TypeBadge type={i.type} />
              <ScopeBadge scope={i.scope} />
              {i.status !== "published" && <StatusBadge status={i.status} />}
              <span className="muted small">updated {formatDate(i.updated_at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
