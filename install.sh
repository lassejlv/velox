#!/bin/sh
# velox installer — downloads the latest signed (JIT-enabled) release binary and
# installs it. macOS / Apple-silicon only.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/velox/main/install.sh | sh
#
# Override the repo or install dir:
#   VELOX_REPO=owner/velox VELOX_BIN_DIR=~/.local/bin sh install.sh
set -e

REPO="${VELOX_REPO:-your-org/velox}"
BIN_DIR="${VELOX_BIN_DIR:-$HOME/.local/bin}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "velox is macOS / Apple-silicon only." >&2
  exit 1
fi

echo "Finding the latest velox release of $REPO..."
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "$TAG" ]; then
  echo "No release found. Build from source instead: 'make install'." >&2
  exit 1
fi

ASSET="velox-${TAG}-aarch64-apple-darwin.tar.gz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
TMP=$(mktemp -d)
echo "Downloading $ASSET ($TAG)..."
curl -fsSL "$URL" -o "$TMP/$ASSET"
tar -xzf "$TMP/$ASSET" -C "$TMP"

mkdir -p "$BIN_DIR"
install -m 755 "$TMP/velox-${TAG}-aarch64-apple-darwin/velox" "$BIN_DIR/velox"
rm -rf "$TMP"

echo "✓ Installed velox $TAG to $BIN_DIR/velox"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "  Run:  velox --version"
