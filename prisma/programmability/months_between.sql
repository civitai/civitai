CREATE OR REPLACE FUNCTION months_between(
  from_date TIMESTAMP,
  to_date TIMESTAMP
) RETURNS INTEGER AS $$
BEGIN
  RETURN CEIL(EXTRACT(YEAR FROM AGE(to_date, from_date)) * 12 + EXTRACT(MONTH FROM AGE(to_date, from_date)));
END;
$$ LANGUAGE plpgsql;