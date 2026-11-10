# Build stage: compile the server (SQLite is bundled, so a C compiler is needed).
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src ./src
# Default ability tuning, compiled in with `include_str!`.
COPY config ./config
# The browser client is compiled into the binary.
COPY static ./static
RUN cargo build --release --bin blast-arena

# Runtime stage: just the binary (it carries the browser client).
FROM debian:bookworm-slim
RUN useradd --system --home /app blast && mkdir -p /data && chown blast /data
WORKDIR /app
COPY --from=build /src/target/release/blast-arena /app/server
ENV PORT=3000 \
    DB_PATH=/data/blast.db \
    RUST_LOG=info
USER blast
VOLUME /data
EXPOSE 3000
CMD ["/app/server"]
