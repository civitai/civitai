# app-data-go (apps/app-data-go): the shared app-data service, a per-user registry consumer. A self-contained Go
# module, so like apps/feed-go the build context is the app directory, not the repo root:
#
#   docker build -f apps/app-data-go/Dockerfile -t civitai-app-data-go apps/app-data-go
#
# Runtime needs real env vars (see .env.example); there is no .env loading in the binary.
# Both base images are pinned by digest, as feed-go's are.

FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app-data-go ./cmd/app-data-go

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/app-data-go /app-data-go
USER nonroot:nonroot
# 8080 (APP_DATA_ADDR): GET /v1/apps/{slug}/collections/{collection}/records, /healthz, /readyz and /metrics.
EXPOSE 8080
ENTRYPOINT ["/app-data-go"]
