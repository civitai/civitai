CREATE USER pganalyze WITH PASSWORD 'pganalyze' CONNECTION LIMIT 5;
GRANT pg_monitor TO pganalyze;

CREATE SCHEMA pganalyze;
GRANT USAGE ON SCHEMA pganalyze TO pganalyze;
GRANT USAGE ON SCHEMA public TO pganalyze;