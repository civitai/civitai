FROM postgres:15-bookworm@sha256:0cb925629e7eb35c77276f3165440d1670c35c2ddbe92b346c579299b75a520f
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
