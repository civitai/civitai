FROM clickhouse/clickhouse-server:24.8.4
COPY ./docker-init/* /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*

