-- Drop the PromptAllowlist table. The runtime filter that was meant to read it was never
-- enabled (`promptAuditing` hard-coded an empty set), the moderator mutation that wrote it
-- had no UI, and the table holds 0 rows in production. Apply after the code deploy.

DROP TABLE IF EXISTS "PromptAllowlist";
