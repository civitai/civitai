-- Foreign keys on the label columns of both judgement tables.
--
-- `sample_id` already referenced `sample`; `label` referencing nothing was an oversight rather
-- than a decision. `label_def.name` is the PK and the rater upserts the parent row before any
-- judgement exists, so nothing legitimate is blocked by this.
--
-- RESTRICT, never CASCADE. `label_def.status` exists so a label can be retired without deleting
-- its history, and CASCADE would turn a stray DELETE on a parent row into silent destruction of
-- the ground truth these constraints are meant to protect. Failing loudly is the point.
--
-- Both tables get it together: an AI judgement under a label a human judgement would refuse is a
-- worse inconsistency than having neither constraint.

ALTER TABLE human_judgement
  DROP CONSTRAINT IF EXISTS human_judgement_label_fkey;
ALTER TABLE human_judgement
  ADD CONSTRAINT human_judgement_label_fkey
  FOREIGN KEY (label) REFERENCES label_def(name) ON DELETE RESTRICT;

ALTER TABLE machine_judgement
  DROP CONSTRAINT IF EXISTS machine_judgement_label_fkey;
ALTER TABLE machine_judgement
  ADD CONSTRAINT machine_judgement_label_fkey
  FOREIGN KEY (label) REFERENCES label_def(name) ON DELETE RESTRICT;

-- Not closed here: `reviewed_judgement_id` is still not checked to belong to the same sample. A
-- composite FK would need a redundant unique key on machine_judgement(id, sample_id). A wrong
-- value there degrades provenance rather than corrupting a verdict, so it is guarded in the
-- action instead.
