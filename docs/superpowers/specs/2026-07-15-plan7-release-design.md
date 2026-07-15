# Plan 7 — 发布流水线（binary release + install.sh）设计

日期：2026-07-15
状态：已与用户逐段确认
上位文档：`docs/superpowers/specs/2026-07-13-minimal-agentparty-design.md` §9「CLI 发布」、§11 步骤 7

## 1. 目标与边界

给 `party` CLI 一条发布流水线：打 tag 即由 GitHub Actions 交叉编译三平台单二进制、生成 SHA256 校验和、传到 GitHub Release；再提供一个匿名 `curl | sh` 的 `install.sh` 让用户按平台下载、校验、安装。

### 已确认决策

| 维度 | 决定 |
|---|---|
| GitHub 仓库 | 新建 `zzcan/agent-party`，**public**（一次性 `gh repo create` 推送 main） |
| 触发 | push tag `v*`（如 `v0.2.0`） |
| 版本源 | tag 即真源；CI 内把 tag 版本 stamp 进 `cli/package.json`（不 commit 回），使 `party --version` == tag |
| 目标平台 | 3 个：`darwin-arm64`、`darwin-x64`、`linux-x64`（Bun 交叉编译，单 ubuntu runner） |
| 校验 | `SHA256SUMS` 随 Release 发布；install.sh 校验本平台那行 |
| 安装位置 | `${PARTY_INSTALL_DIR:-$HOME/.local/bin}`，匿名下载 |

### Non-goals（明确不做）

代码签名 / macOS 公证；linux-arm64 / windows 目标；Homebrew tap / npm 发布；自动版本 bump（版本靠人打 tag）；install.sh 的自动 PATH 写入（只提示）；私有仓 token 鉴权路径（仓库 public）。

## 2. 建仓（前置一次性）

```sh
gh repo create zzcan/agent-party --public --source=. --remote=origin --push
```

之后 owner/repo = `zzcan/agent-party`；`origin` 指向它，main 已推。install.sh 的 raw URL 与 workflow 的 release 目标都基于此。

## 3. `.github/workflows/release.yml`

单 job，`runs-on: ubuntu-latest`，`permissions: { contents: write }`，`on: { push: { tags: ['v*'] } }`。

步骤：
1. `actions/checkout@v4`。
2. `oven-sh/setup-bun@v2`（固定 bun 版本，如 `bun-version: 1.2.x` 对齐本地）。
3. `bun install`（仓库根，装 workspace 依赖）。
4. **门禁**：`bun run check`（shared/web/worker/cli 全绿才继续）。
5. 取版本：`VERSION="${GITHUB_REF_NAME#v}"`（去掉前缀 `v`），用它 stamp `cli/package.json` 的 `version` 字段（`bun`/`node` 原地改写或 `jq`；不 commit）。
6. 交叉编译三平台（`cd cli`，逐个 `bun build src/index.ts --compile --target=<t> --outfile dist/party-<os>-<arch>`）：
   - `--target=bun-darwin-arm64` → `party-darwin-arm64`
   - `--target=bun-darwin-x64` → `party-darwin-x64`
   - `--target=bun-linux-x64` → `party-linux-x64`
7. 生成校验和：在产物目录 `shasum -a 256 party-darwin-arm64 party-darwin-x64 party-linux-x64 > SHA256SUMS`（文件内路径为裸文件名，供 install.sh `-c` 校验）。
8. 发布：`gh release create "$GITHUB_REF_NAME" party-darwin-arm64 party-darwin-x64 party-linux-x64 SHA256SUMS --title "$GITHUB_REF_NAME" --generate-notes`，`env: GH_TOKEN: ${{ github.token }}`。

产物命名唯一事实来源：`party-<os>-<arch>`，`os ∈ {darwin,linux}`，`arch ∈ {arm64,x64}`。install.sh 必须与此一致。

## 4. `install.sh`（仓库根）

纯 POSIX `sh`，匿名 `curl | sh` 可跑。职责链：

1. **检测平台** → asset 名：
   - `os`：`uname -s` → `Darwin`→`darwin`、`Linux`→`linux`，其余报错退出。
   - `arch`：`uname -m` → `arm64`/`aarch64`→`arm64`、`x86_64`/`amd64`→`x64`，其余报错退出。
   - 组合 `asset="party-${os}-${arch}"`；不支持组合（当前仅 `linux-arm64`）明确报错并退出非 0（提示该平台无预编译二进制）。
2. **解析版本**：`PARTY_VERSION` 环境变量若给定则用之（形如 `v0.2.0`）；否则查 `https://api.github.com/repos/zzcan/agent-party/releases/latest` 取 `tag_name`。
3. **下载**：从 `https://github.com/zzcan/agent-party/releases/download/<tag>/` 取 `$asset` 与 `SHA256SUMS` 到临时目录（`mktemp -d`，`trap` 清理）。
4. **校验**：用 `sha256sum`（Linux）或 `shasum -a 256`（macOS）对 `$asset` 那行做 `-c`；不匹配即退出非 0、不安装。
5. **安装**：`chmod +x`，`mv` 到 `${PARTY_INSTALL_DIR:-$HOME/.local/bin}/party`（目录不存在则 `mkdir -p`）。
6. **收尾**：打印安装路径与版本；若安装目录不在 `$PATH`，提示把它加进 PATH（不自动改 shell 配置）。

依赖：`curl`、`uname`、`mktemp`、`chmod`、`mv`，以及 `sha256sum` 或 `shasum` 之一（脚本探测择一）。任一必需命令缺失时报错退出。

### 可测的纯逻辑

把「os/arch → asset 名」映射抽成脚本内一个函数（`detect_asset`，读两个入参或环境变量而非直接调 `uname`），便于用不同 `uname` 输出驱动断言。校验逻辑同理可用一个已知内容+已知/错误摘要的临时文件走通过/失败各一次。

## 5. 测试

- **install.sh 单测**（`test/install.test.sh` 或 bats，用 `bun test` 之外的 shell 断言；仓库无 bats 依赖则写一个自包含的 `sh` 断言脚本，非 0 退出即失败）：
  - `detect_asset` 映射：`(Darwin, arm64)`→`party-darwin-arm64`、`(Darwin, x86_64)`→`party-darwin-x64`、`(Linux, x86_64)`→`party-linux-x64`；不支持组合 `(Linux, aarch64)` 与未知 os 均非 0 退出。
  - SHA256 校验：正确摘要 → 通过；篡改内容 → 非 0 退出、不产出已安装文件。
- **workflow**：无法本地跑。端到端验证在实现末尾人工执行：建仓推送 → 打 `v0.1.0` tag 触发 → 确认 Release 含 3 二进制 + SHA256SUMS → 本机 `curl -fsSL <raw install.sh> | sh` 装一次 → `party --version` 输出 `0.1.0`。

## 6. 文档

README 加「安装」段：
- 一键：`curl -fsSL https://raw.githubusercontent.com/zzcan/agent-party/main/install.sh | sh`
- 指定版本：`PARTY_VERSION=v0.2.0 curl -fsSL … | sh`
- 发版流程：`git tag v0.2.0 && git push origin v0.2.0`（Actions 自动出 Release）。
- macOS 首次运行未签名二进制的 Gatekeeper 提示：`xattr -d com.apple.quarantine ~/.local/bin/party` 或右键「打开」。

## 7. 风险与取舍

- **未签名 darwin 二进制**：macOS Gatekeeper 首次拦截，README 给绕过法；不做签名/公证（YAGNI，超最小面）。
- **Bun 交叉编译产物体积**：单二进制含 Bun runtime（数十 MB），可接受。
- **`bun run check` 拖慢发布**：发布不频繁，门禁价值 > 耗时，保留。
- **版本 stamp 不 commit 回**：CI 内临时改，源码 `cli/package.json` 保持人工维护的基线；tag 与源码版本可能短暂不一致，以 tag 为准（`--version` 反映 tag）。
