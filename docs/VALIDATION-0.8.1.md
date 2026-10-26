# 0.8.1 独立版验证

日期：2026-10-26。发布范围是独立 Evolve 改名为 dsh-soul，未合并旧 Soul 功能。

- Windows / Node 24：`npm run check`，50 项通过；未指定宿主路径时 1 项宿主测试明确跳过。
- `npm run demo`：确定性编辑器与执行器，验证生产闸门、预算、试用和回滚路径。
- DSH 0.2.1-rc.2：真实 Cordis、AgentLoop、SubagentRuntime、spawn、LLM runtime 与工具服务集成通过。覆盖真实观察→精炼→worktree 探测→试用→转正，以及用户纠正→回滚；覆盖预算拒绝、步数上限、取消、超时、工作目录与清理。
- DSH 0.2.0-rc.2：缺少 startActivation 时拒绝探测。该旧宿主的安装检查不读取 engines.dsh，因此另测运行时能力拒绝；新版宿主的兼容性检查也确认 0.2.0 不在允许范围。
- 使用真实 DSH CLI 与独立 DSH_HOME 安装 TGZ，dump-config 确认顶层配置与默认关闭；对已安装入口再次运行真实宿主集成测试通过。
- 包内容仅含独立入口、14 个 Evolve 源模块、默认 harness、插件 patch、本地化与文档；无旧学习器、记忆检索、固定套件执行器或旧测试包。
- 注册边界断言：仅 4 个 evolve 工具与 1 个 evolve 命令。
- CI 在 Linux / Windows 跑单元测试与 demo，并分别对两个 DSH RC 版本验证宿主行为。

集成测试只在模型供应商响应边界使用确定性替身，不请求付费 API。离线 demo 的编辑器和执行器都是替身；两者均不证明真实模型效果提升。C5–C8 尚未接入宿主激活，不在可运行的演化范围。
