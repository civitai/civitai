FROM postgres:17@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
