# app-index-go (apps/app-index-go): the app search index, a registry consumer. A self-contained Go
# module, so like apps/feed-go the build context is the app directory, not the repo root:
#
#   docker build -f apps/app-index-go/Dockerfile -t civitai-app-index-go apps/app-index-go
#
# Runtime needs real env vars (see .env.example); there is no .env loading in the binary.
# Both base images are pinned by digest, as feed-go's are.

FROM golang:1.26-alpine@sha256:30b1e546a9c7fa3b747c2bdba3a0c7bdf3a02ebb4c5b8405d2f948d7e8aac4ec AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app-index-go ./cmd/app-index-go

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/app-index-go /app-index-go
USER nonroot:nonroot
# 8080 (APP_INDEX_ADDR): GET /search, /healthz, /readyz and /metrics.
EXPOSE 8080
ENTRYPOINT ["/app-index-go"]
