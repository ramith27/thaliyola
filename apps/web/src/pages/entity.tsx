import { useEffect } from "react";
import { WhoKnows } from "../components/who-knows";
import { recordVisit } from "../components/find";
import { entityKindLabel, plural } from "../components/labels";
import { AsyncBlock, Badge, Button, Card, EmptyState, ItemRow, LinkChip, Page, PageHeader, RowList, Section, SkeletonRows, Skeleton } from "../components/kit";
import { useApi } from "../hooks";
import { href } from "../router";

interface Entity {
  kind: string;
  name: string;
  aliases: string[];
  items: { kind: "article" | "finding"; id: string; title: string; type: string; status: string; scope: string; scope_kind?: string; updated_at: string }[];
  related: { kind: string; name: string; shared: number }[];
}

const entityHref = (kind: string, name: string) => `#/entity/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;

/** Everything the team has written about one topic: a system, table, metric or service. */
export function EntityPage({ kind, name }: { kind: string; name: string }) {
  const result = useApi<Entity>(`/entities/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
  const { data } = result;
  useEffect(() => {
    if (data) recordVisit({ kind: "entity", id: `${data.kind}:${data.name}`, title: data.name, link: entityHref(data.kind, data.name) });
  }, [data]);

  const title = data?.name ?? name;
  const kindLabel = entityKindLabel(data?.kind ?? kind);
  const articles = data?.items.filter((i) => i.kind === "article") ?? [];
  const findings = data?.items.filter((i) => i.kind === "finding") ?? [];

  const rail = (
    <Card title="Often mentioned with" padding="sm">
      {result.error ? (
        <p className="muted small">Couldn't load related topics.</p>
      ) : !data ? (
        <Skeleton width="70%" />
      ) : data.related.length ? (
        <ul className="br-topic-links" aria-label="Often mentioned with">
          {data.related.map((r) => (
            <li key={`${r.kind}:${r.name}`}>
              <LinkChip href={entityHref(r.kind, r.name)} hint={entityKindLabel(r.kind)}>
                {r.name}
              </LinkChip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No other topics yet.</p>
      )}
    </Card>
  );
  const railWithExperts = (
    <>
      {rail}
      <WhoKnows topic={data?.name ?? name} />
    </>
  );

  return (
    <Page width="content" rail={railWithExperts} railLabel="Related topics and who knows them">
      <PageHeader
        title={title}
        crumbs={[{ label: "Topics" }, { label: kindLabel }]}
        eyebrow="Topic"
        status={<Badge>{kindLabel}</Badge>}
        description={data && data.aliases.length > 0 ? `Also called ${data.aliases.join(", ")}` : undefined}
        meta={data && data.items.length ? <span>{[findings.length ? plural(findings.length, "finding") : "", articles.length ? plural(articles.length, "article") : ""].filter(Boolean).join(" · ")}</span> : undefined}
        // The page's one action; in `primary` so phones keep it visible instead of folding it into ⋯.
        primary={
          <Button icon="search" href={href("/search", { q: title })}>
            Search everything<span className="sr-only"> for “{title}”</span>
          </Button>
        }
      />
      <AsyncBlock
        result={result}
        label="Loading the topic"
        skeleton={<SkeletonRows count={4} />}
        errorTitle="This topic didn't load"
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon="hash"
            title={`Nothing you can read mentions ${title} yet`}
            description="Topics come from the articles and findings that mention them. Use Search everything above to look further."
          />
        }
      >
        {() => (
          <>
            {articles.length > 0 && (
              <Section title="Articles" count={articles.length}>
                <RowList label="Articles">
                  {articles.map((i) => (
                    <ItemRow key={i.id} item={{ ...i, scope: { slug: i.scope, kind: i.scope_kind } }} />
                  ))}
                </RowList>
              </Section>
            )}
            {findings.length > 0 && (
              <Section title="Findings" count={findings.length}>
                <RowList label="Findings">
                  {findings.map((i) => (
                    <ItemRow key={i.id} item={{ ...i, scope: { slug: i.scope, kind: i.scope_kind } }} />
                  ))}
                </RowList>
              </Section>
            )}
          </>
        )}
      </AsyncBlock>
    </Page>
  );
}
