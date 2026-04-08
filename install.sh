#!/bin/sh
set -eu

# deer installer — downloads deer + deerbox binaries and the sandbox runtime.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/zdavison/deer/main/install.sh | bash -s -- --version 0.8.1

REPO="zdavison/deer"
INSTALL_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/deer"
SRT_PACKAGE="@anthropic-ai/sandbox-runtime"

# ── Helpers ───────────────────────────────────────────────────────────

die() { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }
info() { printf '\033[36m%s\033[0m\n' "$1"; }
ok() { printf '\033[32m%s\033[0m\n' "$1"; }

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)       die "Unsupported OS: $(uname -s). Supported: Linux, macOS." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)             die "Unsupported architecture: $(uname -m). Supported: x64, arm64." ;;
  esac
}

fetch_latest_version() {
  # Use GitHub API to get the latest release tag
  url="https://api.github.com/repos/${REPO}/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    tag=$(curl -fsSL -H "Accept: application/vnd.github.v3+json" "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
  elif command -v wget >/dev/null 2>&1; then
    tag=$(wget -qO- --header="Accept: application/vnd.github.v3+json" "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
  else
    die "Neither curl nor wget found. Install one and retry."
  fi
  [ -z "$tag" ] && die "Failed to fetch latest release tag from GitHub."
  echo "$tag"
}

download() {
  src="$1"
  dst="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dst" "$src"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dst" "$src"
  fi
}

# ── Parse args ────────────────────────────────────────────────────────

VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version|-v) VERSION="$2"; shift 2 ;;
    --version=*)  VERSION="${1#--version=}"; shift ;;
    --help|-h)
      printf 'Usage: install.sh [--version <version>]\n'
      printf '  --version, -v   Install a specific version (e.g. 0.8.1)\n'
      printf '  --help, -h      Show this help\n'
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# ── Main ──────────────────────────────────────────────────────────────

OS=$(detect_os)
ARCH=$(detect_arch)

if [ -z "$VERSION" ]; then
  info "Fetching latest release..."
  TAG=$(fetch_latest_version)
  VERSION="${TAG#v}"
else
  TAG="v${VERSION}"
fi

info "Installing deer v${VERSION} for ${OS}/${ARCH}"

mkdir -p "$INSTALL_DIR"

for bin in deer deerbox; do
  binary_name="${bin}-${OS}-${ARCH}"
  url="https://github.com/${REPO}/releases/download/${TAG}/${binary_name}"
  dest="${INSTALL_DIR}/${bin}"

  info "Downloading ${bin}..."
  download "$url" "$dest" || die "Download failed for ${bin}. URL: ${url}"
  chmod +x "$dest"
  ok "  Installed: ${dest}"
done

# ── Install sandbox runtime ──────────────────────────────────────────

mkdir -p "$DATA_DIR"
info "Installing ${SRT_PACKAGE}..."

srt_installed=false
if command -v bun >/dev/null 2>&1; then
  if bun add --cwd "$DATA_DIR" "$SRT_PACKAGE" 2>/dev/null; then
    srt_installed=true
  fi
fi

if [ "$srt_installed" = false ] && command -v npm >/dev/null 2>&1; then
  if npm install --prefix "$DATA_DIR" "$SRT_PACKAGE" 2>/dev/null; then
    srt_installed=true
  fi
fi

if [ "$srt_installed" = true ]; then
  ok "  Installed ${SRT_PACKAGE} to: ${DATA_DIR}"
else
  printf '\033[33mWarning: Failed to install %s. Install it manually:\033[0m\n' "$SRT_PACKAGE"
  printf '  bun add --cwd %s %s\n' "$DATA_DIR" "$SRT_PACKAGE"
  printf '  # or: npm install --prefix %s %s\n' "$DATA_DIR" "$SRT_PACKAGE"
fi

# ── PATH check ────────────────────────────────────────────────────────

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    printf '\n'
    printf '\033[33mNote: %s is not in your PATH. Add this to your shell profile:\033[0m\n' "$INSTALL_DIR"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

printf '\n'
ok "Done! Run 'deer' inside a git repo to get started."
