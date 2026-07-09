-- Per-grant buzz spend limit. The OAuth consent (userId + clientId) is the
-- stable identifier across access-token rotations, so the limit lives here
-- rather than on individual ApiKey rows. Civitai resolves the limit at bearer
-- auth time: if the ApiKey carries a clientId (OAuth-issued), we fetch the
-- limit from this column on the matching consent. User-type keys continue to
-- use ApiKey.buzzLimit.
ALTER TABLE "OauthConsent" ADD COLUMN "buzzLimit" JSONB;
