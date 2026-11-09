# Build stage: compile the server (SQLite is bundled, so a C compiler is needed).
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin bomberman-multiplayer

# Runtime stage: just the binary and the browser client.
FROM debian:bookworm-slim
RUN useradd --system --home /app blast && mkdir -p /data && chown blast /data
WORKDIR /app
COPY --from=build /src/target/release/bomberman-multiplayer /app/server
COPY static /app/static
ENV PORT=3000 \
    STATIC_DIR=/app/static \
    DB_PATH=/data/blast.db \
    RUST_LOG=info
USER blast
VOLUME /data
EXPOSE 3000
CMD ["/app/server"]
