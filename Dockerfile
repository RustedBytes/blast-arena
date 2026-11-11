# Client stage: bundle the TypeScript browser client into one minified
# file per page in static/js.
FROM node:26-alpine AS client
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY scripts ./scripts
COPY client ./client
COPY static ./static
RUN npm run build

# Build stage: compile the server against musl for the Alpine runtime.
# SQLite and mimalloc are compiled from C, hence musl-dev and gcc.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src ./src
# Default ability tuning, compiled in with `include_str!`.
COPY config ./config
# The browser client (with the compiled static/js) is compiled into the binary.
COPY --from=client /src/static ./static
COPY client ./client
RUN cargo build --release --locked --bin blast-arena

# Runtime stage: Alpine and the binary (it carries the browser client).
FROM alpine:3.24
RUN addgroup -S blast && adduser -S -G blast -h /app blast \
    && mkdir -p /data && chown blast:blast /data
WORKDIR /app
COPY --from=build /src/target/release/blast-arena /app/server
ENV PORT=3000 \
    DB_PATH=/data/blast.db \
    RUST_LOG=info
USER blast
VOLUME /data
EXPOSE 3000
CMD ["/app/server"]
