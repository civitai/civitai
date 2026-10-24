FROM postgres:15-bookworm@sha256:cf7f8fb958c63e62875e30645dc4819ff0243a923f3c709e752b99dedd40bfcd
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
