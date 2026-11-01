-- First-party app hosts that sign in through their own /api/auth/authorize and /api/auth/callback. Exact hosts
-- only (`includeSubdomains` false). Applied MANUALLY, per environment; idempotent, and leaves existing rows alone.
INSERT INTO "TrustedSpokeDomain" ("domain", "includeSubdomains", "label") VALUES
  ('moderator.civitai.com', false, 'moderator'),
  ('creator-studio.civitai.com', false, 'creator studio'),
  ('training.civitai.com', false, 'training studio')
ON CONFLICT ("domain") DO NOTHING;
