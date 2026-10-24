-- Tags as a hub source. Applied manually — see CLAUDE.md.
--
-- Safe to apply BEFORE the deploy that ships the regenerated client, because no
-- currently deployed code can write the new label: the only writers are the hub
-- mutations in the same release. The hazard the expand/contract rule guards against
-- is a row carrying a label the running client cannot deserialize, and nothing here
-- creates one. Applying it AFTER the deploy is also safe — the writes just fail
-- until it lands.

ALTER TYPE "UserHubSourceType" ADD VALUE 'Tag';
