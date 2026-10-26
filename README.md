# DSH Soul 0.8.1 — 独立 Evolve

**本版本只发布独立 dsh-evolve 的宿主接线修复版，并改名为 dsh-soul；不包含旧 Soul 记忆检索、后台学习或固定套件演化模块。**

观察真实任务中的分歧，每次修改一个组件，在独立 Git worktree 中执行候选，再用真实任务试用和回滚。模型权重不变。

## 已接通的链路

- 使用真实接口 `ctx.subagents.startActivation()`，本地 `spawn` 后端，`delivery: caller`。不再假设存在 `ctx.get('subagent').run`。
- 候选 C1–C4 经 `systemPrompt.context` 注入指定子会话；通过宿主 `session/event` 获取步数、工具调用、错误和完成状态。
- 子会话经过宿主 LLM 服务的请求在发送前预留额度并记录 usage。请求上限、超时和取消会终止子会话并等待清理。
- 项目检查在候选工作目录中执行，再删除 worktree；保留 Git 仓库内的子项目相对目录。
- 缺宿主能力、没有活跃父会话、非 Git 项目、脏工作区在编辑器调用前拒绝。
- 重复阈值统计真实观察，而非历史进化次数；成功任务推进影子窗口；下一轮用户纠正关联前一任务并触发回滚；冷却计数随真实任务推进。
- `/evolve status` 只初始化数据库，不往项目写文件，避免状态查询导致脏工作区。

## 实际可用范围

要求 Node.js 24+、Git、DSH **0.2.1-rc.2 起的 0.2.x** 及宿主本地 `spawn` 后端。已验证 0.2.1-rc.2；未来 0.2.x 以运行时能力检查为准。0.2.0-rc.2 没有 `startActivation`，不支持本版本探测。

| 组件 | 文件 | 真实宿主状态 |
| --- | --- | --- |
| C1 系统提示 | `system.md` | 已接入，锚定区外可编辑 |
| C2 护栏 | `guardrails.md` | 已接入，锚定区外可编辑 |
| C3 记忆策略 | `memory.md` | 已接入 |
| C4 工具指引 | `tools.md` | 已接入 |
| C5 子代理配置 | `subagents.md` | 尚未接入配置加载 |
| C6 技能 | `skills/*/SKILL.md` | 尚未接入发现与加载 |
| C7 脚本 | `scripts/*.mjs` | 尚未接入线上版本分发 |
| C8 hook | `hooks/*.mjs` | 尚未接入 hook 注册 |

C5–C8 可以查看、校验和导出。诊断指向这些组件时，真实 episode 返回 `component_not_connected`，不调用编辑模型、不采纳。文件写入 worktree 不代表宿主已经加载了它。

## 安装与开启

在 DSH 0.2.1-rc.2 中安装打包文件，把路径改为实际位置：

```powershell
dsh plugin --profile tui add "C:\path\dsh-soul-0.8.1.tgz"
```

插件默认关闭。在 profile 的用户 patch 中修改已有 Soul 节点。已安装独立 dsh-evolve 时先移除它，避免命令冲突：

```yaml
- id: dsh-soul
  config:
    enabled: true
    profile: tui
    provider: your-registered-provider
    model: your-model
    shadowWindow: 3
    cooldownTurns: 20
    repeatThreshold: 3
    checks:
      - name: project-tests
        argv: [node, --test]
```

所有选项直接放在插件 `config` 顶层，不使用 `harnessEvolution` 嵌套。`provider/model` 必须显式配置为宿主已有路由，编辑和探测使用同一路由，不读取旧版学习或固定套件配置。checks 按项目实际测试命令配置，直接执行 argv，不经过 shell。项目依赖需能在新 worktree 中使用；不会自动复制被 Git 忽略的 node_modules、虚拟环境、未提交文件或密钥。

数据库默认位于 `DSH_HOME/dsh-soul/<profile>/evolve.sqlite`（未设置 DSH_HOME 时用 `~/.dsh`）。无法确定 profile 且没有显式 database 时拒绝启动，不共用开发库。旧 Soul 记忆库不会打开、迁移或删除。要继续使用独立 dsh-evolve 或 0.8.0 的 harness 数据库，先停用旧插件，再将 `database` 显式指向对应的 Evolve 数据库；不要指向旧 Soul 记忆库。

执行 `/evolve status`，确认 `hostProbe.ok: true`。同项目同意图默认出现 3 次分歧后，用 `/evolve diagnose` 查看归因，再用 `/evolve run` 启动一次付费精炼。需要干净工作区且已有提交。`injectHarness: false` 时禁止启动，因为线上不会应用候选。

没有可用 runner 或干净仓库时明确拒绝，不会改用离线替身。非 Git 项目本版本不能启动演化。

## 试用与回滚

`/evolve run` 授权本次编辑、探测及通过闸门后的真实任务试用。`evolve_request` 工具仅报告资格，不付费启动。没有后台按工具错误自动运行的循环。

候选通过检查后进入 `shadow`。这里是**实际生效的试用版本**，会注入该项目后续主会话，可能影响用户任务，不是旁路隔离评估。同类任务默认 3 轮没有否决信号才转为 stable；窗口内纠正、错误增加或任务未完成可回滚。此模块不提供 autoAdopt 审批开关；需要禁止应用时关闭 `enabled` 或 `injectHarness`。

基线来自主会话，候选来自新子会话及当前已提交代码；上下文、工具权限、文件状态可能不同。零成本基线只能提供有限的对比证据。项目自带检查提高可信度，但不是不可篡改验证：候选能修改工作区中的测试文件。未配置 checks 时不会把 `deliverable` 伪造为 true；正常结束不等于答案正确。

## 成本与边界

| 限制 | 默认 |
| --- | --- |
| 编辑请求 | 最多 6 次 |
| 探测请求 | 最多 40 次 |
| episode 调用总额 | 60 次 |
| 每项目每日调用总额 | 100 次 |
| 单请求输入 | 24,000 字节 |
| 单 episode 输入 | 320,000 字节 |
| 每项目每日输入 | 800,000 字节 |
| 单请求超时 | 60 秒 |
| episode 超时 | 8 分钟 |

这是上限，不是每次固定消耗。实际消耗见 `/evolve status` 和 `/evolve log`。完整 system/messages/tools 都计入探测输入，可能远大于精简演示；`input_limit` 表示发送前拒绝。可按工具集调整 `requestInputBytes`（最大 96,000）及 episode/daily 输入额度。字节不是 token，调用数不是货币预算；外部工具自行调用第三方付费服务不由此账本计量。

C1–C4 默认共 1952 字节，固定税上限 2400 字节。稳定上下文有利于缓存，但不保证供应商缓存命中。

Git worktree 是独立代码副本，**不是安全沙箱**；权限、网络与工具边界由宿主决定。取消依赖宿主和工具配合，资源释放后才删除工作区，不能强杀不响应取消的第三方代码。

组件限制受管路径，拒绝路径逃逸和经过符号链接写入。锚定区逐字保持。这些结构规则不等于自然语言策略的完备安全证明。

## 命令

```text
/evolve status             宿主能力、版本、固定税、额度、窗口
/evolve diagnose           最近一轮归因与重复次数
/evolve run                手动启动一次付费精炼
/evolve diff [A] [B]       两版差异
/evolve log [n]            审计账本
/evolve explain [rev]      采纳证据
/evolve rollback [rev]     回滚
/evolve watch              待决窗口
/evolve tree               组件大小
/evolve lint               结构校验
/evolve export [目录]      导出到项目内供审阅
```

工具：`evolve_status`、`evolve_tree`、`evolve_diagnose`、`evolve_request`。

## 验证

```powershell
npm run check
npm run demo
$env:DSH_TEST_PACKAGE = 'C:\path\node_modules\@deepseek-ai\dsh\package.json'
npm run test:host
```

check 未配置宿主路径时明确跳过新增的宿主探测测试；test:host 必须提供路径。集成测试挂载独立 Evolve 入口，使用实际 Cordis、AgentLoop、SubagentRuntime、本地 spawn、LLM runtime、工具执行和工作目录服务，只在模型供应商边界返回确定性响应，不请求付费 API。确认未注册旧记忆工具，并覆盖候选提示、工具指标、检查目录、预算拒绝、步数上限、超时、取消清理，以及观察→编辑→探测→试用→转正/回滚。

离线 demo 的编辑器和执行器均为替身。两类测试都不证明真实模型能力提升；该结论仍需真实任务评估。

## 从误整合版 0.8.0 纠正

0.8.0 曾错误地将 Evolve 合并进旧 Soul；0.8.1 按发布要求恢复为独立 Evolve。旧模块的源码与安装包保留在历史标签，不随本版本分发。安装 0.8.1 后，将原 `harnessEvolution` 内需要的配置移至 `config` 顶层，并移除旧 `learning`、`evolution`、`harnessEvolution` 配置。仅保留原顶层 `enabled: true` 而未迁移 provider/model 会明确报错。默认新数据库不自动继承历史试用策略。
