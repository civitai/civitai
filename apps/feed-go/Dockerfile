# feed-go (apps/feed-go): Go port of `image.getImagesAsPostsInfinite`. A self-contained Go module, so
# unlike the Node apps the build context is the app directory, not the repo root:
#
#   docker build -f apps/feed-go/Dockerfile -t civitai-feed-go apps/feed-go
#
# Runtime needs real env vars (see .env.example); there is no .env loading in the binary.
# TODO(release): pin both base images by digest, as the Node apps' Dockerfiles do, when the
# tag-webhook build is wired (DESIGN.md "Deploy prerequisites").

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/feed-go ./cmd/feed-go

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=build /out/feed-go /feed-go
USER nonroot:nonroot
# 8080: the public tRPC path (only when FEED_GO_FALLBACK_URL is set). 9090: /metrics, /healthz and
# the internal shadow endpoint — never exposed outside the cluster.
EXPOSE 8080 9090
ENTRYPOINT ["/feed-go"]
