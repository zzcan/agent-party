#!/bin/sh
# party CLI installer — downloads the matching prebuilt binary from GitHub Releases,
# verifies its SHA-256, and installs it. Anonymous curl | sh works (public repo).
#   curl -fsSL https://raw.githubusercontent.com/zzcan/agent-party/main/install.sh | sh
# Env: PARTY_VERSION=vX.Y.Z (default: latest), PARTY_INSTALL_DIR (default: ~/.local/bin)
set -eu

REPO="zzcan/agent-party"
BIN="party"

detect_asset() { # uname_s uname_m  ->  party-<os>-<arch>  (return 1 if unsupported)
  os=""
  arch=""
  case "$1" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) return 1 ;;
  esac
  case "$2" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) return 1 ;;
  esac
  # 当前仅发布 darwin-{arm64,x64} 与 linux-x64；linux-arm64 无预编译二进制
  if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
    return 1
  fi
  printf 'party-%s-%s\n' "$os" "$arch"
}

pick_sha() { # prints the sha-256 command, or return 1
  if command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256sum\n'
  elif command -v shasum >/dev/null 2>&1; then
    printf 'shasum -a 256\n'
  else
    return 1
  fi
}

verify_checksum() { # file sumsfile
  SHACMD="${SHACMD:-$(pick_sha)}"
  name=$(basename "$1")
  expected=$(grep "  ${name}\$" "$2" | awk '{print $1}' | head -n1)
  [ -n "$expected" ] || return 1
  actual=$($SHACMD "$1" | awk '{print $1}')
  [ "$expected" = "$actual" ]
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not found" >&2; exit 1; }; }

latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
}

main() {
  need curl
  need uname
  need mktemp
  SHACMD=$(pick_sha) || { echo "error: need 'sha256sum' or 'shasum'" >&2; exit 1; }

  asset=$(detect_asset "$(uname -s)" "$(uname -m)") || {
    echo "error: no prebuilt binary for $(uname -s)/$(uname -m)" >&2; exit 1;
  }
  version=${PARTY_VERSION:-$(latest_version)}
  [ -n "$version" ] || { echo "error: could not resolve latest release version" >&2; exit 1; }

  base="https://github.com/${REPO}/releases/download/${version}"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "downloading ${asset} (${version})..." >&2
  curl -fsSL -o "$tmp/$asset" "$base/$asset"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"

  verify_checksum "$tmp/$asset" "$tmp/SHA256SUMS" || {
    echo "error: SHA-256 checksum mismatch for ${asset}" >&2; exit 1;
  }

  dir=${PARTY_INSTALL_DIR:-$HOME/.local/bin}
  mkdir -p "$dir"
  chmod +x "$tmp/$asset"
  mv "$tmp/$asset" "$dir/$BIN"
  echo "installed ${BIN} ${version} -> ${dir}/${BIN}" >&2
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "note: ${dir} is not in your PATH — add it to use '${BIN}' directly" >&2 ;;
  esac
}

# 被 test 以 PARTY_INSTALL_LIB=1 source 时只暴露函数、不执行安装
[ "${PARTY_INSTALL_LIB:-}" = "1" ] || main "$@"
