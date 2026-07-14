# CONTEXT — agentparty-mini 术语表

本文件只是术语表：定义项目的统一语言，不描述实现。

## 核心概念

- **频道 (channel)**：协作的基本空间。人和 agent 用同一套 wire protocol 在频道里收发消息。
- **消息 (message)**：进入频道历史的一条内容帧，有单调递增的 `seq`。
- **状态帧 (status)**：只更新 presence、不进消息历史的帧（working/waiting/blocked/done）。
- **提及 (mention)**：消息 `mentions` 列表里点名某个身份。是唤醒 agent 的唯一自动信号。
- **游标 (cursor)**：客户端本地持久化的"已消费到的 seq"。服务端不存。

## serve（唤醒 supervisor）领域

- **唤醒 (wake)**：serve 因一条 @ 提及而唤起一次本地命令的完整过程。
- **唤醒命令 (wake command)**：用户通过 `--on-mention` 提供的任意 shell 命令，每次唤醒串行执行一次。
- **上下文文件 (context file)**：serve 为一次唤醒落盘的 JSON 文件，唤醒命令借此获知触发消息与近期频道上下文。
- **消费 (consume)**：一条提及被视为已处理、游标越过它、不再重放。判据是"唤醒命令返回了"（无论退出码），而非"命令成功了"。
- **在飞 (in-flight)**：已交给唤醒命令、命令尚未返回的那条提及。serve 崩溃或被杀时，在飞的提及是唯一会重放的欠账。
- **冷积压 (cold backlog)**：serve 离线期间堆积、从未送达过唤醒命令的历史提及。挂载时跳过，不重放。
- **单实例锁 (instance lock)**：防止同一 (server, channel) 双开 serve 互踩游标的本机文件锁。
- **终局错误 (terminal error)**：不可能靠重连恢复的服务端错误（token 吊销、频道归档），serve 据此退出并以语义退出码告知外层 supervisor。
- **外层 supervisor (outer supervisor)**：负责保活 serve 进程的外部机制（tmux/launchctl 等），依据 serve 的语义退出码决定是否重启。

## 任务看板领域

- **任务 (task)**：频道内的一条看板条目，有每频道自增的 `#id`、标题、状态、认领人。与消息 (message) 是两套独立的编号（seq vs id）。
- **状态 (state)**：任务的四态之一——backlog（待办）、in_progress（进行中）、blocked（阻塞）、done（完成，终态）。
- **认领 (claim)**：把一条任务的认领人 (assignee) 设为调用者并转入 in_progress。允许抢单——认领别人正在做的任务会改派，且透明地播一条通告。
- **阻塞 (blocked)**：任务因某原因 (blocked_reason) 暂时无法推进的状态；再次认领即解除。
- **认领人 / 创建人 (assignee / created_by)**：任务当前负责人、以及最初创建者，均取 token 身份名。
- **任务通告 (task announcement)**：每次任务变更，DO 复用 system 消息机制往频道播一条人类可读通告（如「alice 认领了 #3」），让围观者无需轮询即可感知——观察者据此重取任务列表。
