FROM postgres:15-bookworm@sha256:72ccb1ad4dc9d5813ea40a8c1c87af746f16658fb029c17fe570ea9b881f68b3
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
