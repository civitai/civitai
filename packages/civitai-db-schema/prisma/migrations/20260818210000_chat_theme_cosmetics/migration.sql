-- The three membership chat themes. `data.slug` names a palette defined in
-- `src/shared/constants/chat-theme.ts`; an unknown slug renders as the default,
-- so a row here can never inject styling of its own.
--
-- `permanentUnlock = true` follows the Civitai precedent that a granted cosmetic
-- is never clawed back. Whether chat themes should instead lapse with the
-- membership is still open (868kk3t0t); flipping it is an UPDATE on these rows.
INSERT INTO "Cosmetic" ("name", "description", "type", "source", "permanentUnlock", "data")
SELECT v.name, v.description, 'ChatTheme'::"CosmeticType", 'Membership'::"CosmeticSource", true, v.data::jsonb
FROM (VALUES
  ('Citron Chat Theme', 'A warm amber reskin of your chat window.', '{"slug":"citron"}'),
  ('Bubblegum Chat Theme', 'A pink reskin of your chat window.', '{"slug":"bubblegum"}'),
  ('Terminal Chat Theme', 'A green-on-black reskin of your chat window.', '{"slug":"terminal"}')
) AS v(name, description, data)
WHERE NOT EXISTS (
  SELECT 1 FROM "Cosmetic" c WHERE c."type" = 'ChatTheme' AND c."data"->>'slug' = v.data::jsonb->>'slug'
);
