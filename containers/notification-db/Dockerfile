FROM postgres:15-bookworm
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
