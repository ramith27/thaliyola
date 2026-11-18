-- One link per issue per item. Jira and Linear issue links are stored in one spelling (core/connections/tickets.ts);
-- links that are already there twice (spellings that differ in case, or two requests at the same moment) are removed
-- here, keeping the first, and refused from now on.
WITH ranked AS (
  SELECT l.id, row_number() OVER (PARTITION BY l.target_id, lower(l.url) ORDER BY t.created_at NULLS LAST, l.id) AS n
    FROM source_links l LEFT JOIN tickets t ON t.source_link_id = l.id
   WHERE l.system IN ('jira', 'linear')
)
DELETE FROM source_links WHERE id IN (SELECT id FROM ranked WHERE n > 1);
CREATE UNIQUE INDEX source_links_one_issue ON source_links (target_id, url) WHERE system IN ('jira', 'linear');
