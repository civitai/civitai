# beacon-go (apps/beacon-go): the browser beacons /api/internal/ping and /api/internal/pulse in Go.
# A self-contained Go module, so the build context is the app directory, not the repo root:
#
#   docker build -f apps/beacon-go/Dockerfile -t civitai-beacon-go apps/beacon-go
#
# Runtime needs real env vars (see .env.example); there is no .env loading in the binary.
# Both base images are pinned by digest (the same ones apps/feed-go/Dockerfile uses).

FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/beacon-go ./cmd/beacon-go

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/beacon-go /beacon-go
USER nonroot:nonroot
# 8080: the public beacon routes (BEACON_GO_MODE=serve only). 9090: /metrics, /healthz and the
# internal shadow endpoints — never exposed outside the cluster.
EXPOSE 8080 9090
ENTRYPOINT ["/beacon-go"]
