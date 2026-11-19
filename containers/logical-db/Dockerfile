FROM postgres:15-bookworm@sha256:8180c3e1b9b603d2988f937dfbe51008bad5c4b07c77f35119695c027a7315ab
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
