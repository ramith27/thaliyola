-- "publish": a person's own articles, findings and edits publish at once instead of waiting for review, including
-- what their Claude writes through MCP. Project admins get it; admins can add it to any role on the Roles page.
UPDATE roles SET permissions = array_append(permissions, 'publish')
 WHERE key = 'owner' AND NOT ('publish' = ANY (permissions));
UPDATE roles SET description = 'Everything in the project: members, settings, repositories, reviews and content; publishes without review.'
 WHERE key = 'owner' AND description = 'Everything in the project: members, settings, repositories, reviews and content.';
