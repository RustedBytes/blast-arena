# Client stage: bundle the TypeScript browser client into one minified
# file per page in static/js.
# Deno runs the build tools; this stage never ships, so it uses the Debian
# image (the tools' native binaries are glibc builds).
FROM denoland/deno:2.9.8 AS client
WORKDIR /src
COPY deno.json deno.lock tsconfig.json .browserslistrc ./
# --frozen: fail if deno.lock doesn't match deno.json.
RUN deno install --frozen
COPY scripts ./scripts
COPY client ./client
COPY static ./static
RUN deno task build

# Build stage: compile the server against musl for the Alpine runtime.
# SQLite and mimalloc are compiled from C, hence musl-dev and gcc.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# Dependencies first, in a layer of their own: built against stand-in
# sources, so it stays cached until Cargo.toml or Cargo.lock change, and a
# code change rebuilds only the server itself.
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && touch src/lib.rs \
    && echo 'fn main() {}' > build.rs \
    && cargo build --release --locked --bin blast-arena \
    && rm -rf src build.rs
COPY build.rs ./
COPY src ./src
# Default ability tuning, compiled in with `include_str!`.
COPY config ./config
# The browser client (with the compiled static/js) is compiled into the binary.
COPY --from=client /src/static ./static
COPY client ./client
# COPY keeps the files' own times, which can be older than the stand-ins:
# touching the crate roots makes Cargo rebuild the crate and rerun build.rs.
RUN touch build.rs src/main.rs src/lib.rs \
    && cargo build --release --locked --bin blast-arena

# Runtime stage: Alpine and the binary (it carries the browser client).
FROM alpine:3.24
# The user keeps ID 999:999, which the earlier Debian image gave it, so
# existing /data volumes stay writable. (Alpine's ping group has GID 999;
# the server doesn't need it.)
RUN delgroup ping \
    && addgroup -S -g 999 blast && adduser -S -u 999 -G blast -h /app blast \
    && mkdir -p /data && chown blast:blast /data
WORKDIR /app
COPY --from=build /src/target/release/blast-arena /app/server
ENV PORT=3000 \
    DB_PATH=/data/blast.db \
    RUST_LOG=info
USER blast
VOLUME /data
# 3000/tcp: HTTP and the WebSocket; 3000/udp: WebTransport (HTTP/3).
EXPOSE 3000/tcp 3000/udp
CMD ["/app/server"]
