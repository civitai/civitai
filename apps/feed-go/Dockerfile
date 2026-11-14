# feed-go (apps/feed-go): Go port of `image.getImagesAsPostsInfinite`. A self-contained Go module, so
# unlike the Node apps the build context is the app directory, not the repo root:
#
#   docker build -f apps/feed-go/Dockerfile -t civitai-feed-go apps/feed-go
#
# Runtime needs real env vars (see .env.example); there is no .env loading in the binary.
# Both base images are pinned by digest, as the Node apps' Dockerfiles do.

FROM golang:1.26-alpine@sha256:30b1e546a9c7fa3b747c2bdba3a0c7bdf3a02ebb4c5b8405d2f948d7e8aac4ec AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/feed-go ./cmd/feed-go

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/feed-go /feed-go
USER nonroot:nonroot
# 8080: the public tRPC path (only when FEED_GO_FALLBACK_URL is set). 9090: /metrics, /healthz and
# the internal shadow endpoint — never exposed outside the cluster.
EXPOSE 8080 9090
ENTRYPOINT ["/feed-go"]
