FROM postgres:17
COPY ./docker-init/*.sql /docker-entrypoint-initdb.d/
RUN chmod a+r /docker-entrypoint-initdb.d/*
