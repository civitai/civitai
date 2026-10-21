FROM postgres:15-bookworm@sha256:22c6356b2897cb0b4be6ad550b44ff97a0f29df7dbe327c01bc3c84bd457694d
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
