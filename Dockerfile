# Build stage
FROM rust:1.93.1-bookworm AS builder

WORKDIR /app

# Copy manifests
COPY Cargo.toml Cargo.lock ./

# Create dummy src to cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src target/release/velox target/release/deps/velox*

# Copy actual source
COPY src ./src
COPY templates ./templates

# Build the real binary
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/velox /usr/local/bin/velox

# Set entrypoint
ENTRYPOINT ["velox"]
