# content-policy-go (apps/content-policy-go): the SFW/NSFW and region decision service. A self-contained Go
# module, so like apps/feed-go the build context is the app directory, not the repo root:
#
#   docker build -f apps/content-policy-go/Dockerfile -t civitai-content-policy-go apps/content-policy-go
#
# Runtime needs real env vars (see .env.example); there is no .env loading in the binary.
# Both base images are pinned by digest, as feed-go's are.

FROM golang:1.26-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/content-policy-go ./cmd/content-policy-go

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /out/content-policy-go /content-policy-go
USER nonroot:nonroot
# 8080 (CONTENT_POLICY_ADDR): POST /v1/decide, GET /healthz and /readyz.
# 9090 (CONTENT_POLICY_METRICS_ADDR): GET /metrics only.
EXPOSE 8080 9090
ENTRYPOINT ["/content-policy-go"]
