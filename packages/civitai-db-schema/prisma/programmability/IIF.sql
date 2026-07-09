CREATE OR REPLACE function iif(condition boolean, true_result anyelement, false_result anyelement) returns anyelement
immutable
language sql as
$$
SELECT CASE WHEN condition THEN true_result ELSE false_result END
$$;