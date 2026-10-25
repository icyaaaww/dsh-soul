# DSH Soul 0.5.0

为 DSH 提供长期记忆，以及**提出候选 → 独立执行 → 比较 → 组合 → 复测 → 递归改进 → 自动采用**的方法进化流程。目标是结果正确、少返工、更快完成；模型成本由配置限制，不强制使用便宜模型。

进化的对象是项目内的技能和工作策略，不是模型权重、身份或权限。0.5 已实现完整的受限试验循环，仍不是对所有开放任务都能自行判定成功的通用自进化系统。

## 安装与升级

- Node.js 24+，使用自带 SQLite，零 npm 运行时依赖。
- 明确兼容 DSH `0.2.0-rc.2 || 0.2.1-rc.2`，不跳过宿主兼容检查。
- 标准 DSH bundle，包名 `dsh-soul`，含中英文元信息。
- 内存任务无需其他运行环境；实际执行 JavaScript 的套件另需本地 Docker Linux 引擎及预先准备的 Node 镜像。

从本仓库 Releases 下载 TGZ，退出 DSH、备份记忆库后安装：

```powershell
dsh plugin --profile web add 'C:\Downloads\dsh-soul-0.5.0.tgz'
```

替换实际路径与 profile；桌面版使用其内置插件入口。重启后输入 `/learn help`。不通过 npm registry 发布。

**本版数据库升级到 schema 4。**原记忆、来源、反馈、试用、遗忘指纹和额度保留；0.1–0.3 不能打开升级后的库，回退需恢复备份。默认目录仍是 `~/.dsh/dsh-learning/<profile>/memory.sqlite`，尊重 `DSH_HOME`。不要让不同插件版本同时写入同一库。

原名 `dsh-learning` 的旧插件需先移除，再安装 Soul；不要同时加载。卸载 Soul 保留记忆库和宿主聊天记录。

## 0.5 真正新增了什么

| 环节 | 行为 |
| --- | --- |
| 基线 | 用当前方法执行固定训练任务，记录实际输出、通过情况、调用和动作次数 |
| 提出 | 编辑模型根据失败及差异提出多个结构化方法 |
| 探测 | 候选在互不共享状态的工作区中并发执行 |
| 组合 | 根据已发生的行为组合方法，并重新执行组合方案 |
| 递归 | 有改进则把选中方法用于下一轮；无提升、重复候选、预算或时间不足就停止 |
| 验证 | 选定方法后，基线与新方法都执行单独的验证用例；验证输入与答案不交给编辑模型 |
| 采用 | 所有训练及验证用例通过，且相对基线有可确认的质量或步骤改进，才自动写入本项目技能 |
| 复用 | 相关任务可召回新技能；后续进化复用当前策略及有来源的改进经验 |

套件由用户注册，任务、固定答案和运行权限不能由被测模型修改。普通模型建议仍保持 candidate；只有通过已授权套件的进化策略可以自动进入 active，卡片明确标记 `fixed_suite`。一条人工失败反馈仍会停用它。

实际耗时会记录，但一次运行更快不能独自决定升级。质量相同时，至少两个用例减少模型调用或动作数，且没有逐用例资源/错误回退，才算效率改进。

## 开启进化

默认 `learning: false`、`evolution: false`，不会自行请求模型。后台记忆提炼和方法进化可以分别开启。在当前 profile 的 patch 中配置已注册的模型路由：

```yaml
- id: dsh-soul
  config:
    evolution: true
    evolutionProvider: your-registered-provider
    evolutionModel: your-executor-model
    evolutionEditorModel: your-editor-model
    evolutionMaxRounds: 2
    evolutionCandidates: 2
    evolutionConcurrency: 2
```

编辑模型和执行模型可以不同，但使用同一个 evolutionProvider；省略编辑模型时沿用执行模型。也可以由已有 provider/model 配置提供默认路由。不附带 API Key，不自动挑选供应商。

先在项目里生成示例：

```text
/learn evolve example memory
/learn evolve register .dsh-soul/evolution-memory.json
/learn evolve run normalize-numbers
/learn evolve status
/learn evolve show 运行ID
```

注册的是本项目的一类任务，不是对任意电脑操作的授权。**示例只演示配置，实际使用应替换为自己的代表性任务和验收条件。**方法本来就能正确且高效完成时，结果可以是 unchanged；并不要求每次都“进化成功”。

套件设置 `auto: true` 后，同一轮正常任务出现至少两次非 Soul 工具错误、且用户任务关键词匹配时，会排队等宿主空闲后自动启动；每个套件有冷却时间。主模型也可通过 `learning_evolve` 启动已经注册的套件。注册、改验收条件和回退仍是用户命令。

```text
/learn evolve list
/learn evolve cancel 运行ID
/learn evolve rollback 套件ID
/learn evolve unregister 套件ID
```

取消、超时或失败保留原方法，不自动重试或断点续跑已付费请求。回退会停用当前方法，并在前版仍可用时恢复前版；没有前版则返回种子方法作为后续进化基线。

## 两种执行器

**memory**：每个执行实例只操作自己的内存文件，支持 read/write/finish。适用于信息提取、JSON/文本转换、格式整理、受约束的文件生成等。用 equals、jsonEquals、contains 检查实际答案或文件。没有 shell、网络、真实文件系统或宿主工具入口。

**javascript**：模型生成 `solution.mjs`，默认导出接受一个 JSON 输入的函数；插件在独立容器中实际调用，再在容器外比较返回值。固定答案不进入容器。需要配置：

```yaml
    evolutionDockerImage: node:24-alpine
    evolutionSandboxTimeoutMs: 10000
```

由用户先准备镜像，例如 `docker pull node:24-alpine`；插件本身不拉取镜像。镜像在运行前解析为不可变 ID。容器无网络、宿主凭据和宿主工作目录挂载，只有只读的临时试验文件；有 CPU、内存、进程数、输出及运行时间限制。正常完成和取消都等待清理。容器隔离不是内核漏洞防护的绝对保证；异常断电后的残留资源需检查。

使用 `/learn evolve example javascript` 创建代码套件，注册后运行 `normalize-js`。当前代码执行接口仅支持 JSON 输入/输出的 JavaScript 函数；不执行任意项目 shell 命令，不自动覆盖用户真实项目文件。

详细套件格式、状态、停止条件和验证边界见 [进化设计与使用](docs/EVOLUTION-0.5.md)。

## 效率与用量

默认进化参数：

| 配置 | 默认值 |
| --- | ---: |
| evolutionMaxRounds | 2 |
| evolutionCandidates | 2 |
| evolutionConcurrency | 2 |
| evolutionMaxSteps | 每个用例 6 次模型请求 |
| evolutionMaxCalls | 每次进化 160 次逻辑请求上限 |
| evolutionDailyCalls | 每 profile 每 UTC 日 400 次 |
| evolutionMaxTokens | 每次请求最多 2400 输出 token |
| evolutionTimeoutMs | 整次进化 180000 ms |
| evolutionRequestTimeoutMs | 单请求 60000 ms |
| evolutionCooldownMs | 自动触发同套件间隔 3600000 ms |

这些都是上限，不是目标调用量。实际开销由用例数、步骤数、候选数和轮数共同决定；成功完整运行可能需要几十次模型调用。并发缩短部分等待时间，不减少总请求。进化期间不启动新的后台记忆提炼作业，已经发出的请求允许在限时内结束。

`/learn evolve status` 查看阶段与已预留调用；`show` 查看逐请求 usage 和执行记录。额度跨重启持久化，失败和取消也占额度；宿主/provider 自身重试可能产生更多 HTTP 尝试，故它不是人民币硬预算。模型 usage 未报告就保留未知，不按零花费处理。

选择依据是通过验收与减少必要工作步骤，**尚未建立真实模型上的净提速或总费用下降结论**。强模型可能减少试错，也可能更慢，需要按任务评测。

## 原有记忆和人工技能仍可用

```text
/learn prefer --profile 先给结论，再解释细节
/learn remember 当前项目使用 Node 24
/learn search 关键词
/learn inbox
/learn show 记忆ID
/learn accept 记忆ID
/learn revise 记忆ID 新内容
/learn forget 记忆ID
/learn feedback 技能ID pass|fail 说明
/learn trials
/learn trial 试用ID
/learn assess 试用ID helped|neutral|harmed|uncertain 理由
/learn status
```

偏好/事实按规范化 cwd 隔离；无 cwd 时按会话隔离，profile 偏好只在当前 profile 共享。普通技能须接受并经过两个不同会话的人工通过反馈才激活；自动套件验证另有明确来源标记，不冒充人工认可。

`learning_trial` 可以登记正常任务的方法使用并返回完整技能，`learning_evidence`、`learning_result` 用于记录来源与观察。这套人工试用记录与自动进化试验分开，正常任务的工具 exit=0 或 completed 都不是成功证明。

普通记忆使用中文二元词/英文关键词检索，无嵌入 API；128 条检索缓存跨连接失效。上下文默认最多 3600 字节，长技能按需取全文。词面匹配可能漏掉同义表达，模型读取记忆仍消耗 token。

可另行设置 `learning: true` 和明确的 provider/model 开启增量记忆提炼：efficiency 默认每日 12 次、输入 18000 字节、输出 1600 token、空闲 10 秒；economy 为 4 次、12000 字节、600 token、空闲 30 秒。显式数值覆盖预设。这些额度与进化额度分别统计。

## 数据和限制

修订/遗忘会传播到依赖记忆和试验记录；在途结果不能复活已删除来源。注销进化套件会移除注册内容、其技能和试验正文，保留不含正文的额度记录；不会删除用户原始套件文件或宿主聊天记录。

记录不含模型 reasoning；常见凭据格式会脱敏，但不能保证识别所有秘密。**套件文件会存入本地库，模型需要的任务文本和虚拟文件内容会发送到所配置的模型。**不要把秘密或真实账号操作放入试验用例。

每项目最多 20 个套件，套件最多 12 个用例、256 KB；运行记录上限 10000。无技能引用的完成进化记录保留 30 天，已采用版本保留其验证证据；调用明细保留 30 天。不会自动改变用户偏好、模型权重、权限或插件核心源码。

## 验证与参考

```text
npm run check
npm run demo:evolution
npm run bench
npm pack --dry-run
```

demo 使用本地确定性模型替身，但执行的虚拟文件读写、比较、组合复测与自动采用都是生产代码；它验证流程，不证明真实模型质量。测试覆盖两版真实 DSH 服务。CI 额外使用真实 Docker 运行代码、检查网络/写入限制、超时清理，并跑完整代码进化流程。

参考 Google Research [Harness²](https://github.com/google-research/harness2) 与 [论文](https://arxiv.org/abs/2610.14224) 的任务内 Propose–Probe–Compose 和跨任务经验复用。0.5 独立实现了受限执行器上的递归循环，没有复制上游代码，也没有移植其全部运行框架编辑面、执行后端或评测结果。与上游开放任务方案不同，本版自动采用依赖用户固定验收条件。
