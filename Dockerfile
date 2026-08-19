# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS webui

WORKDIR /src/crates/agent-gateway/web
RUN npm install -g pnpm@10.32.1

COPY crates/agent-gateway/web/package.json crates/agent-gateway/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY crates/agent-gateway/web ./
RUN pnpm build

FROM golang:1.25.12-bookworm AS gateway-builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src/crates/agent-gateway

COPY crates/agent-gateway/go.mod crates/agent-gateway/go.sum ./
RUN go mod download

COPY crates/agent-gateway ./
COPY --from=webui /src/crates/agent-gateway/web/dist ./web/dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/arcforge-gateway ./cmd/gateway

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin arcforge \
    && install -d -o arcforge -g arcforge -m 0700 /var/lib/arcforge

COPY --from=gateway-builder /out/arcforge-gateway /usr/local/bin/arcforge-gateway

USER arcforge

ENV PORT=8080 \
    ARCFORGE_GATEWAY_STATE_DB=/var/lib/arcforge/gateway-state.sqlite3

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/arcforge-gateway"]
