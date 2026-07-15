# 计划 7：发布流水线（binary release + install.sh）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打 tag `v*` 即由 GitHub Actions 交叉编译三平台 `party` 单二进制 + SHA256SUMS 传到 GitHub Release；提供匿名 `curl | sh` 的 `install.sh` 按平台下载、校验、安装。

**Architecture:** 三件产物——(1) `install.sh`（仓库根，纯 POSIX sh，纯逻辑 `detect_asset`/`verify_checksum` 可本地单测）；(2) `.github/workflows/release.yml`（单 ubuntu runner，Bun 交叉编译）；(3) README 安装/发版文档。建仓 + 端到端 tag 验证由控制者在实现末尾人工执行。

**Tech Stack:** GitHub Actions、`oven-sh/setup-bun`、`bun build --compile --target=...`、`gh` CLI、POSIX sh、`sha256sum`/`shasum`。

**设计文档：** `docs/superpowers/specs/2026-07-15-plan7-release-design.md`

## Global Constraints

- **owner/repo = `zzcan/agent-party`**（public）。install.sh 的 raw/download URL 与 workflow release 目标都基于此，写死此常量。
- **产物命名唯一事实来源**：`party-<os>-<arch>`，`os ∈ {darwin,linux}`、`arch ∈ {arm64,x64}`。三资产：`party-darwin-arm64`、`party-darwin-x64`、`party-linux-x64`。SHA256SUMS 内为**裸文件名**。workflow 与 install.sh 两处命名必须逐字一致。
- **触发**：`on: push: tags: ['v*']`。**版本**：`VERSION=${GITHUB_REF_NAME#v}`，build 前 stamp 进 `cli/package.json`（不 commit），使 `party --version` == tag（`cli/src/index.ts` 在 `--compile` 时把 `../package.json` 打进二进制，故 stamp 必须早于 `bun build`）。
- **install.sh**：装到 `${PARTY_INSTALL_DIR:-$HOME/.local/bin}/party`；版本默认取 `releases/latest`，`PARTY_VERSION=vX.Y.Z` 可覆盖；校验失败即退出非 0 不安装；不支持的 os/arch 组合明确报错退出非 0；不自动改 PATH（只提示）。
- **Non-goals**：代码签名/公证、linux-arm64/windows、Homebrew/npm、自动 bump、install.sh 自动写 PATH。
- POSIX `sh` 严格（`set -eu`，无 bashism）；conventional commits；`cli/dist/` 不提交（已 gitignore）；每任务只提交自己涉及的路径（永不提交 `.superpowers/`）。

---

### Task 1: `install.sh` + 可本地测的纯逻辑 + shell 单测

**Files:**
- Create: `install.sh`（仓库根）
- Create: `test/install.test.sh`
- Modify: `package.json`（根，加 `check:install` 并串进 `check`）

**Interfaces:**
- Produces（脚本内函数，`PARTY_INSTALL_LIB=1 . ./install.sh` 后可单独调用）：
  - `detect_asset <uname_s> <uname_m>`：stdout 打印 `party-<os>-<arch>` 并 return 0；不支持组合 return 1（无 stdout）。
  - `pick_sha`：stdout 打印 `sha256sum` 或 `shasum -a 256`；都没有 return 1。
  - `verify_checksum <file> <sumsfile>`：文件摘要与 sumsfile 中同名行一致 return 0，否则 return 1。
  - `main`：完整安装流程；仅当未设 `PARTY_INSTALL_LIB=1` 时在脚本末尾自动执行。

- [ ] **Step 1: 写失败测试 `test/install.test.sh`**

```sh
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `sh test/install.test.sh`
Expected: FAIL —「. ./install.sh: No such file」（脚本还不存在）。

- [ ] **Step 3: 实现 `install.sh`**

```sh
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `sh test/install.test.sh`
Expected: 每行 `ok - ...`，末行 `ALL PASS`，退出码 0。

- [ ] **Step 5: 把 shell 测试串进根 `check`**

`package.json`（根）`scripts` 内：在 `check` 链首加 `check:install`，并新增该脚本。改后：
```json
"check": "bun run check:install && bun run check:shared && bun run check:web && bun run check:worker && bun run check:cli",
"check:install": "sh test/install.test.sh",
```
（只改这两行/新增一行，其余 script 不动。）

- [ ] **Step 6: 跑聚合校验确认未破坏**

Run: `bun run check:install`
Expected: `ALL PASS`，退出 0。

- [ ] **Step 7: 提交**

```bash
git add install.sh test/install.test.sh package.json
git commit -m "feat(release): install.sh with SHA-256 verify + platform detection, shell tests"
```

---

### Task 2: `.github/workflows/release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes：Task 1 的产物命名约定（`party-<os>-<arch>`、`SHA256SUMS` 裸名）；根 `bun run check`；`cli` 的 `bun build --compile`。
- Produces：tag `v*` 触发时，一个含 `party-darwin-arm64`/`party-darwin-x64`/`party-linux-x64`/`SHA256SUMS` 四资产的 GitHub Release。

- [ ] **Step 1: 写 `.github/workflows/release.yml`**

```yaml
name: release
on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install deps
        run: bun install

      - name: Check (all workspaces + install.sh)
        run: bun run check

      - name: Stamp version from tag
        env:
          VERSION: ${{ github.ref_name }}
        run: |
          export V="${VERSION#v}"
          bun -e "const fs=require('fs');const f='cli/package.json';const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version=process.env.V;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
          echo "stamped cli/package.json version = $V"

      - name: Build three targets
        run: |
          cd cli
          mkdir -p dist
          bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/party-darwin-arm64
          bun build src/index.ts --compile --target=bun-darwin-x64   --outfile dist/party-darwin-x64
          bun build src/index.ts --compile --target=bun-linux-x64    --outfile dist/party-linux-x64

      - name: Checksums
        run: |
          cd cli/dist
          shasum -a 256 party-darwin-arm64 party-darwin-x64 party-linux-x64 > SHA256SUMS
          cat SHA256SUMS

      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${{ github.ref_name }}" \
            cli/dist/party-darwin-arm64 \
            cli/dist/party-darwin-x64 \
            cli/dist/party-linux-x64 \
            cli/dist/SHA256SUMS \
            --title "${{ github.ref_name }}" \
            --generate-notes
```

说明：`VERSION` 由 step 的 `env:` 注入（含 `v` 前缀），run 内 `export V="${VERSION#v}"` 去前缀后经 `process.env.V` 传给 `bun -e`。stamp 早于 build，故 `--compile` 打进二进制的 `../package.json` 已是 tag 版本。

- [ ] **Step 2: 结构自检（本地无法跑 Actions）**

- 确认 YAML 可解析：`bun -e "const y=require('fs').readFileSync('.github/workflows/release.yml','utf8'); console.log(y.length>0?'read ok':'empty')"`（仅确认文件非空、缩进无 tab）。若本机有 `actionlint` 则跑 `actionlint .github/workflows/release.yml`；无则跳过并在报告注明。
- 人工核对：`permissions: contents: write` 存在；三 `--target` 与产物名逐字匹配 Global Constraints；stamp 早于 build；SHA256SUMS 用裸名且在 `cli/dist`；`gh release create` 引用 `cli/dist/` 下四文件。

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): tag-triggered cross-compile + SHA256SUMS + gh release"
```

---

### Task 3: README 安装与发版文档

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes：Task 1/2 的 URL 与命令约定。

- [ ] **Step 1: 在 README 顶部（`## 开发` 之前）加「安装」段**

```markdown
## 安装（party CLI）

一键装最新版（macOS / Linux x64，公开仓匿名下载）：

```sh
curl -fsSL https://raw.githubusercontent.com/zzcan/agent-party/main/install.sh | sh
```

指定版本 / 安装目录：

```sh
PARTY_VERSION=v0.2.0 PARTY_INSTALL_DIR=/usr/local/bin \
  curl -fsSL https://raw.githubusercontent.com/zzcan/agent-party/main/install.sh | sh
```

装好后 `party --version`。macOS 首次运行未签名二进制若被 Gatekeeper 拦：
`xattr -d com.apple.quarantine ~/.local/bin/party`（或在「访达」里右键→打开一次）。

### 发版

打 tag 即触发 GitHub Actions 交叉编译三平台二进制 + SHA256SUMS 并创建 Release：

```sh
git tag v0.2.0 && git push origin v0.2.0
```
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: install.sh usage + release-by-tag flow in README"
```

---

### Task 4（控制者执行，非 subagent）：建仓 + 端到端 tag 验证

> 此任务涉及真实外部动作（建公开仓、推送、发 Release），由控制者在前三任务合并后亲自执行，不派 subagent。

- [ ] **Step 1: 建仓并推送**（`gh` 已认证为 `zzcan`）

```bash
gh repo create zzcan/agent-party --public --source=. --remote=origin --push
```
Expected: 仓库创建，`origin` 指向它，main 已推。

- [ ] **Step 2: 打 tag 触发真实发布**

```bash
git tag v0.1.0 && git push origin v0.1.0
```
用 `gh run watch` 跟踪 workflow；Expected: `release` job 成功。

- [ ] **Step 3: 校验 Release 资产**

```bash
gh release view v0.1.0 --json assets --jq '.assets[].name'
```
Expected: 恰好 `party-darwin-arm64`、`party-darwin-x64`、`party-linux-x64`、`SHA256SUMS` 四项。

- [ ] **Step 4: 本机端到端安装冒烟**

```bash
PARTY_INSTALL_DIR=$(mktemp -d) sh install.sh && "$PARTY_INSTALL_DIR/party" --version
```
（或用 `curl -fsSL <raw install.sh> | sh` 走真实下载路径。）
Expected: 下载+校验通过，`party --version` 打印 `0.1.0`。若 macOS Gatekeeper 拦截，按 README 提示解除后重试。

---

## 自审记录

- **Spec 覆盖**：§2 建仓 → Task 4 Step 1；§3 workflow（触发/stamp/三 target/SHA256SUMS/gh release/权限）→ Task 2；§4 install.sh（detect/version/download/verify/install/PATH 提示）→ Task 1；§5 测试（install 纯逻辑单测 + 端到端 tag 验证）→ Task 1 Step 1-4 + Task 4；§6 文档 → Task 3；§7 风险（Gatekeeper 提示）→ Task 3 README。
- **占位符扫描**：无 TBD；install.sh、workflow、README、shell 测试均给完整内容。Task 2 Step 1 的 stamp 步骤有一处「以修正段为准」的显式说明，实现者按修正段落地。
- **命名一致性**：`party-<os>-<arch>` 三资产名 + `SHA256SUMS` 裸名在 install.sh(`detect_asset`/`verify_checksum`)、workflow(build/checksums/release)、测试三处逐字一致；owner/repo `zzcan/agent-party` 在 install.sh 常量、README URL、Task 4 命令一致。
