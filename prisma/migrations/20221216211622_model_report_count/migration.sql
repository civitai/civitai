-- Add ModelReportStat
CREATE OR REPLACE VIEW "ModelReportStat" AS
SELECT
  m.id "modelId",
  SUM(IIF("reason" = 'TOSViolation' AND mr.status = 'Pending', 1, 0)) "tosViolationPending",
	SUM(IIF("reason" = 'TOSViolation' AND mr.status = 'Valid', 1, 0)) "tosViolationValid",
	SUM(IIF("reason" = 'TOSViolation' AND mr.status = 'Invalid', 1, 0)) "tosViolationInvalid",
	SUM(IIF("reason" = 'NSFW' AND mr.status = 'Pending', 1, 0)) "nsfwPending",
	SUM(IIF("reason" = 'NSFW' AND mr.status = 'Valid', 1, 0)) "nsfwValid",
	SUM(IIF("reason" = 'NSFW' AND mr.status = 'Invalid', 1, 0)) "nsfwInvalid",
	SUM(IIF("reason" = 'Ownership' AND mr.status = 'Pending', 1, 0)) "ownershipPending",
	SUM(IIF("reason" = 'Ownership' AND mr.status = 'Valid', 1, 0)) "ownershipValid",
	SUM(IIF("reason" = 'Ownership' AND mr.status = 'Invalid', 1, 0)) "ownershipInvalid",
	SUM(IIF("reason" = 'AdminAttention' AND mr.status = 'Pending', 1, 0)) "adminAttentionPending",
	SUM(IIF("reason" = 'AdminAttention' AND mr.status = 'Valid', 1, 0)) "adminAttentionValid",
	SUM(IIF("reason" = 'AdminAttention' AND mr.status = 'Invalid', 1, 0)) "adminAttentionInvalid",
	SUM(IIF("reason" = 'SecurityConcern' AND mr.status = 'Pending', 1, 0)) "securityConcernPending",
	SUM(IIF("reason" = 'SecurityConcern' AND mr.status = 'Valid', 1, 0)) "securityConcernValid",
	SUM(IIF("reason" = 'SecurityConcern' AND mr.status = 'Invalid', 1, 0)) "securityConcernInvalid"
FROM "Model" m
LEFT JOIN "ModelReport" mr ON mr."modelId" = m.id
GROUP BY m.id