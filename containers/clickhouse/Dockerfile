FROM clickhouse/clickhouse-server:24.12.6@sha256:a65ca89ddbe8e04a05036dd7d7110a203256293b407b9359130ed5e4333f45ff
COPY ./docker-init/* /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*

