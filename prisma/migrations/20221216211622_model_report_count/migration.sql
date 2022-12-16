-- Add ModelReportCount
CREATE OR REPLACE VIEW "ModelReportCount" AS
SELECT
  m.id "modelId",
  SUM(IIF("reason" = 'TOSViolation' AND mr.status = 'Pending', 1, 0)) "TOSViolationPending",
	SUM(IIF("reason" = 'TOSViolation' AND mr.status = 'Valid', 1, 0)) "TOSViolationValid",
	SUM(IIF("reason" = 'TOSViolation' AND mr.status = 'Invalid', 1, 0)) "TOSViolationInvalid",
	SUM(IIF("reason" = 'NSFW' AND mr.status = 'Pending', 1, 0)) "NSFWPending",
	SUM(IIF("reason" = 'NSFW' AND mr.status = 'Valid', 1, 0)) "NSFWValid",
	SUM(IIF("reason" = 'NSFW' AND mr.status = 'Invalid', 1, 0)) "NSFWInvalid",
	SUM(IIF("reason" = 'Ownership' AND mr.status = 'Pending', 1, 0)) "OwnershipPending",
	SUM(IIF("reason" = 'Ownership' AND mr.status = 'Valid', 1, 0)) "OwnershipValid",
	SUM(IIF("reason" = 'Ownership' AND mr.status = 'Invalid', 1, 0)) "OwnershipInvalid",
	SUM(IIF("reason" = 'AdminAttention' AND mr.status = 'Pending', 1, 0)) "AdminAttentionPending",
	SUM(IIF("reason" = 'AdminAttention' AND mr.status = 'Valid', 1, 0)) "AdminAttentionValid",
	SUM(IIF("reason" = 'AdminAttention' AND mr.status = 'Invalid', 1, 0)) "AdminAttentionInvalid",
	SUM(IIF("reason" = 'SecurityConcern' AND mr.status = 'Pending', 1, 0)) "SecurityConcernPending",
	SUM(IIF("reason" = 'SecurityConcern' AND mr.status = 'Valid', 1, 0)) "SecurityConcernValid",
	SUM(IIF("reason" = 'SecurityConcern' AND mr.status = 'Invalid', 1, 0)) "SecurityConcernInvalid"
FROM "Model" m
LEFT JOIN "ModelReport" mr ON mr."modelId" = m.id
GROUP BY m.id