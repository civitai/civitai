FROM postgres:15-bookworm@sha256:daeac543477e189e334f159133f4be6dae739b005cec2dfb9d482509fed05465
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
