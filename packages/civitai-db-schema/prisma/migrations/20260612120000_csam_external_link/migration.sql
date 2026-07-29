-- Add the ExternalLink value to the CsamReportType enum so moderators can file
-- CSAM reports for content hosted on external sites (not on Civitai).
--
-- NOTE: In PostgreSQL a newly added enum value cannot be used in the same
-- transaction that adds it. Apply this statement on its own (it is not wrapped
-- in BEGIN/COMMIT here). Per repo convention, migrations are applied manually.
ALTER TYPE "CsamReportType" ADD VALUE IF NOT EXISTS 'ExternalLink';
