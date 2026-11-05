# Build context: apps/search-service. Nothing outside this directory is copied in.
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install -r requirements.txt
COPY search_service ./search_service
# Precompiled so a read-only root filesystem never needs a __pycache__ write.
RUN /venv/bin/python -m compileall -q /venv search_service

FROM python:3.12-slim
ENV PATH=/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SPELLING_DIR=/data/spelling
COPY --from=build /venv /venv
COPY --from=build /app /app
WORKDIR /app
RUN groupadd -g 1001 app && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin app
USER 1001:1001
EXPOSE 8000
# The dictionary is mounted at $SPELLING_DIR; startup fails if it is missing.
CMD ["uvicorn", "search_service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--timeout-graceful-shutdown", "10"]
