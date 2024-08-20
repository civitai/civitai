 SELECT m.id AS "modelId",
    sum(iif(((r.reason = 'TOSViolation'::"ReportReason") AND (r.status = 'Pending'::"ReportStatus")), 1, 0)) AS "tosViolationPending",
    sum(iif(((r.reason = 'TOSViolation'::"ReportReason") AND (r.status = 'Actioned'::"ReportStatus")), 1, 0)) AS "tosViolationActioned",
    sum(iif(((r.reason = 'TOSViolation'::"ReportReason") AND (r.status = 'Unactioned'::"ReportStatus")), 1, 0)) AS "tosViolationUnactioned",
    sum(iif(((r.reason = 'NSFW'::"ReportReason") AND (r.status = 'Pending'::"ReportStatus")), 1, 0)) AS "nsfwPending",
    sum(iif(((r.reason = 'NSFW'::"ReportReason") AND (r.status = 'Actioned'::"ReportStatus")), 1, 0)) AS "nsfwActioned",
    sum(iif(((r.reason = 'NSFW'::"ReportReason") AND (r.status = 'Unactioned'::"ReportStatus")), 1, 0)) AS "nsfwUnactioned",
    sum(iif(((r.reason = 'Ownership'::"ReportReason") AND (r.status = 'Pending'::"ReportStatus")), 1, 0)) AS "ownershipPending",
    sum(iif(((r.reason = 'Ownership'::"ReportReason") AND (r.status = 'Processing'::"ReportStatus")), 1, 0)) AS "ownershipProcessing",
    sum(iif(((r.reason = 'Ownership'::"ReportReason") AND (r.status = 'Actioned'::"ReportStatus")), 1, 0)) AS "ownershipActioned",
    sum(iif(((r.reason = 'Ownership'::"ReportReason") AND (r.status = 'Unactioned'::"ReportStatus")), 1, 0)) AS "ownershipUnactioned",
    sum(iif(((r.reason = 'AdminAttention'::"ReportReason") AND (r.status = 'Pending'::"ReportStatus")), 1, 0)) AS "adminAttentionPending",
    sum(iif(((r.reason = 'AdminAttention'::"ReportReason") AND (r.status = 'Actioned'::"ReportStatus")), 1, 0)) AS "adminAttentionActioned",
    sum(iif(((r.reason = 'AdminAttention'::"ReportReason") AND (r.status = 'Unactioned'::"ReportStatus")), 1, 0)) AS "adminAttentionUnactioned",
    sum(iif(((r.reason = 'Claim'::"ReportReason") AND (r.status = 'Pending'::"ReportStatus")), 1, 0)) AS "claimPending",
    sum(iif(((r.reason = 'Claim'::"ReportReason") AND (r.status = 'Actioned'::"ReportStatus")), 1, 0)) AS "claimActioned",
    sum(iif(((r.reason = 'Claim'::"ReportReason") AND (r.status = 'Unactioned'::"ReportStatus")), 1, 0)) AS "claimUnactioned"
   FROM (("Model" m
     LEFT JOIN "ModelReport" mr ON ((mr."modelId" = m.id)))
     JOIN "Report" r ON ((r.id = mr."reportId")))
  GROUP BY m.id;