# Railway deployment: build velox from source on Linux, then serve a Hono app.
#
# This is the live proof that velox's cross-platform port works: Railway runs
# Linux containers, velox links JavaScriptCore's C API via WebKitGTK's
# libjavascriptcoregtk-4.1 (located by build.rs + pkg-config), and Hono runs on
# top unmodified.

# ---------------------------------------------------------------------------
# Stage 1 — build the velox binary
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS build

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjavascriptcoregtk-4.1-dev \
        pkg-config \
        build-essential \
        perl \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH=/root/.cargo/bin:$PATH

# Faster release build for CI/deploy: skip fat LTO, parallelize codegen. Still
# optimized (opt-level 3), just quicker to compile than the distributed binary.
ENV CARGO_PROFILE_RELEASE_LTO=false \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16

WORKDIR /src
COPY . .
RUN cargo build --release

# ---------------------------------------------------------------------------
# Stage 2 — runtime image: velox + the Hono app
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# libjavascriptcoregtk-4.1-dev pulls in the runtime .so velox links against.
# No nodejs/npm needed — velox installs the app's deps with its own built-in
# package manager (`velox install`).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjavascriptcoregtk-4.1-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/velox /usr/local/bin/velox

WORKDIR /app
COPY examples/railway-hono/package.json /app/
# Dogfood velox's package manager: resolve + install hono/@hono/node-server.
RUN velox install
COPY examples/railway-hono/app.ts /app/

# Railway provides $PORT at runtime; app.ts reads it.
CMD ["velox", "app.ts"]
