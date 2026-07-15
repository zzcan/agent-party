#!/bin/sh
# install.sh 纯逻辑单测：source 出函数（PARTY_INSTALL_LIB=1 阻止 main 自动执行）
set -u
fail=0
PARTY_INSTALL_LIB=1 . ./install.sh

check() { # desc expected actual
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: expected [$2] got [$3]"; fail=1
  fi
}
expect_fail() { # desc  (runs remaining args, expects non-zero)
  desc=$1; shift
  if "$@" >/dev/null 2>&1; then echo "FAIL - $desc: expected non-zero"; fail=1; else echo "ok   - $desc"; fi
}

# detect_asset 映射
check "darwin arm64"   "party-darwin-arm64" "$(detect_asset Darwin arm64)"
check "darwin aarch64" "party-darwin-arm64" "$(detect_asset Darwin aarch64)"
check "darwin x86_64"  "party-darwin-x64"   "$(detect_asset Darwin x86_64)"
check "darwin amd64"   "party-darwin-x64"   "$(detect_asset Darwin amd64)"
check "linux x86_64"   "party-linux-x64"    "$(detect_asset Linux x86_64)"
expect_fail "linux arm64 unsupported"   detect_asset Linux aarch64
expect_fail "windows unsupported"       detect_asset Windows x86_64
expect_fail "garbage arch unsupported"  detect_asset Linux mips

# verify_checksum：正确通过、篡改失败
SHACMD=$(pick_sha) || { echo "FAIL - no sha tool"; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf 'hello world\n' > "$tmp/party-linux-x64"
hash=$($SHACMD "$tmp/party-linux-x64" | awk '{print $1}')
printf '%s  party-linux-x64\n' "$hash" > "$tmp/SHA256SUMS"
if verify_checksum "$tmp/party-linux-x64" "$tmp/SHA256SUMS"; then echo "ok   - checksum matches"; else echo "FAIL - checksum should match"; fail=1; fi
printf 'tampered\n' > "$tmp/party-linux-x64"
expect_fail "checksum mismatch rejected" verify_checksum "$tmp/party-linux-x64" "$tmp/SHA256SUMS"

[ "$fail" = "0" ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
