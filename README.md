# DSH Learning 0.1

为 DSH 增加有来源、可纠正的长期记忆，以及经过用户反馈验证的工作技能。**第一版用记忆与方法改善上下文，不训练模型权重，不自动改写自身代码。**

## 运行与安装

- Node.js **24+**，使用自带 `node:sqlite`；不需要 Python、GPU、npm 运行时依赖或独立数据库服务。
- 已针对 **DSH 0.2.0-rc.2** 验证，`engines.dsh` 暂时精确限定该版本。其他宿主版本需适配验证，不建议跳过兼容检查。
- 标准 DSH bundle：`package.json → dsh.bundle.patch → cordis.patch.yml`，包含中英文展示元信息。

安装打包文件（替换为实际绝对路径）：

```powershell
dsh plugin --profile web add 'C:\Downloads\dsh-learning-0.1.0.tgz'
```

重启 DSH，输入 `/learn help`。开发时可在源码目录运行 `npm pack` 生成 TGZ。桌面版应使用其内置插件管理入口，不要用 npm CLI 管理保留的 desktop profile。

卸载：`dsh plugin --profile web remove dsh-learning`。本地记忆库保留，不删除聊天数据。

## 立即体验：无需额外模型调用

```text
/learn prefer --profile 先给结论，再解释必要细节
/learn remember 当前项目使用 Node 24，修复前先复现问题
/learn search 修复
/learn list active
/learn show 记忆ID
/learn revise 记忆ID 新的内容
/learn forget 记忆ID
/learn status
```

`prefer` 默认是当前项目偏好；`--profile` 是同一个 DSH profile 的通用偏好。`remember` 默认记录项目事实，也支持 `--profile`，请仅用于确实需要跨项目共享的事实。

当前目录来自 DSH session.header.cwd，按规范化路径划分项目；没有工作目录时只在当前会话内可见。不会自动猜测多个子目录属于同一个 Git 项目。不同 profile 使用独立数据库；单 profile 目前面向单用户，不作为多租户服务。

普通对话中的纠正和模型 `learning_propose` 会形成来源明确的**候选**。查看 `/learn list candidate`，使用 `/learn accept ID` 接受后才自动召回。自然语言候选不会未经确认就变成永久偏好；当前明确指令仍应立即由 DSH 遵循，不必等学习完成。

## 技能闭环

```text
/learn skill {"title":"排查测试失败","preconditions":["已有可复现故障"],"steps":["记录失败输出","定位根因","进行最小修改"],"checks":["相关测试通过","确认原问题已解决"],"counterexamples":["没有复现时先收集信息，不直接重写"]}
/learn accept 技能ID
/learn feedback 技能ID pass 本次按流程定位并解决了故障
```

技能从 candidate 进入 trial。**两个不同会话的人工通过反馈**才提升为 active；同一会话重复反馈不叠加。一条失败反馈即停用为 deprecated，修订产生新版本并重新验证。不同会话只是最低限度的去重，并不能证明两次任务真的独立，仍需真实使用结果。

有效技能按相关性通过记忆上下文或 `learning_get` 提供给主模型；插件不自动运行候选脚本，不自动重放具有外部副作用的工具，也不把普通工具 exit=0 当成整个任务成功。试用技能可由用户通过 `/learn show ID` 检查并指导当前任务使用。

## 可选：后台增量学习

默认 `learning: false`：本地采集、检索、明确记忆命令和技能管理均可用，**没有后台模型请求**。在插件配置中显式设置 DSH 已注册的 provider 与 model 后开启。不会隐式选择主对话的昂贵模型。

示例：在当前 profile 的 `cordis.patch.yml` 中追加以下宿主 patch（如已有同 ID override，请合并 config）。该结构需与所安装 DSH 的 patch 格式对应：

```yaml
- id: dsh-learning
  config:
    learning: true
    provider: your-registered-provider
    model: your-low-cost-model
    dailyCalls: 4
    maxOutputTokens: 600
    maxInputBytes: 12000
    memoryBytes: 2400
    idleMs: 30000
```

provider/model 必须是用户自己的 DSH 路由；不附带 API Key。`reasoningEffort` 可选，必须用适配器支持的值；当前 DeepSeek 宿主适配器使用 `off/low/high/max`，可将简单提炼设为 `off` 后测试质量。其他适配器不应直接套用该值。

触发条件是明确记忆/纠正类表达、工具失败和手动 `/learn review`。关键词只是排队信号，不是自动生效判断。它会把近期有限摘录交给学习模型；返回内容须引用本批证据、通过结构校验，然后保存为候选。普通对话不逐轮进行模型反思，也不整库重写。

后台只在观察到的会话空闲且达到 idleMs 后启动，一次处理一个作业。任务忙时不启动新作业，已发出的作业允许在限时内结束。冷启动后可能无法知道所有已在运行的宿主任务，不能保证全局资源调度。

## 费用、延迟与边界

- 每个 profile 每 UTC 日最多 4 个插件逻辑学习请求，额度跨重启持久化；失败、中断也占用一次。
- 不自动重试。超时或崩溃后用量可能未知，不自动重发，避免重复付费。
- 日额度是本插件调用限制，**不是供应商 HTTP 尝试数或人民币硬上限**。宿主/provider 中间件自身的重试需另外配置与计费。
- 单请求证据默认最多 12000 UTF-8 字节，输出上限 600 token。输入字节数不是精确 token 数；系统提示与请求封装另计。
- 动态记忆区块默认最多 2400 字节，且不截断单条记录。很长的技能可用工具按需读取，不强塞进每次请求。
- 使用中文二元词及英文关键词搜索，无嵌入 API；同义改写检索能力有限。第一版不提供向量检索。
- `/learn status` 返回插件的学习配置、usage 与队列状态。宿主 usage 的 input/cacheRead/cacheWrite 是分离字段，reasoning 不应在输出之外重复计费；未知 usage 保持未知。状态不声称覆盖主对话总费用。
- 稳定偏好也占主模型输入，每次请求可能再计费。本地存储免费不等于模型阅读记忆免费。

本地捕获只读取正文和有界错误摘要，不读取 reasoning 内容。常见凭据格式在落盘前脱敏，但模式匹配不能保证识别所有秘密；敏感内容不要交给自动学习。开启远程学习模型后，选中的摘录会经 DSH 发往该模型；不能称为全程离线。

## 数据、删除与可靠性

默认数据路径：`~/.dsh/dsh-learning/<profile>/memory.sqlite`，尊重 `DSH_HOME`。安装目录位于 profiles 下时自动识别 profile；直接从源码加载时默认为 development，也可显式配置 profile/database。指定同一个 database 会共享存储，勿用于需要隔离的 profile。

每条记忆保留来源、范围、状态和版本。原文属于数据，不拥有修改身份或权限的权力；用户当前要求优先。工具只能读或提交候选，激活/修订/删除由 `/learn` 人类命令执行。

遗忘会删除记录、搜索条目、引用摘录及依赖或共享来源的记忆，并阻止相同来源事件和相同文字指纹被自动重新学习。用户可以通过新的明确 remember/prefer 命令重新记住同一事实，旧来源仍受抑制。为了稳妥，部分共享证据的关联记忆也会一起删除；后台在途结果检查版本变化，不能将已删除来源写回。

删除不能清除宿主原聊天记录、已经发送给 API 的内容或已在当前模型历史中的副本；需要时新建会话并按宿主方式删除历史。此版本也不保证识别来自全新来源的同义重述。SQLite secure_delete 已开启，但不承诺对磁盘备份、WAL 和文件系统快照进行取证级擦除。

未引用对话摘录默认 30 天保留、约 10000 条上限；已被记忆引用的来源保留。维护在空闲时运行，因此不是即时磁盘硬上限。未完成队列最多 32 个，过期作业不重发；有效与候选记忆合计上限 10000，达到后需整理。完成作业与调用明细保留 30 天。遗忘抑制指纹不含原文，长期保留用于防复活。

## 验证

```powershell
npm test
npm run bench
npm pack --dry-run
```

测试涵盖中文检索、范围隔离、候选状态、技能反馈、删除与修订传播、在途删除、额度并发与重启、超时与关闭、来源伪造、隐藏思维隔离，以及真实 DSH SessionStore/CommandRuntime/SystemPrompt 和 schema 校验器。设置 `DSH_TEST_PACKAGE` 可指向另一位置的宿主 package.json；没有宿主时集成测试明确跳过。

性能脚本创建独立临时 SQLite 库，用 10000 条合成记录测检索 p50/p95，结束后清理；它不是真实任务质量评测，也不是普通用户设备性能承诺。真实 API 语义质量与跨设备性能仍需后续评测。

## 设计依据

借鉴 Reflexion 的反馈学习、ACE 的增量经验维护、Mem0 的选择性记忆和 Sleep-time Compute 的异步复用思想。本实现独立编写，没有复制这些项目源码，也不声称复现其论文指标。

暂未实现：向量检索、图形记忆面板、全自动技能测试/执行、模型微调、自主源码修改、人民币硬预算、自动修改身份与目标。
