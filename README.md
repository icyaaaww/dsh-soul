# DSH Soul 1.0.0 — 经验编译

从真实任务的分歧中精炼运行策略。保留独立 Evolve 架构，不包含旧 Soul 的记忆检索、后台学习或固定答案套件。

1.0 的重点是经验编译：每轮结束免费记录重复出现的纠正、工具错误、未完成和“出错后恢复”模式；经验先留在本地 SQLite，不进入主代理上下文。支持度达到阈值后，才由一次编辑会话把它编译成普通的 C1–C8 改动，再走 0.9 已有的成对验证、影子试用与回滚。核心约束是：经验存起来是免费的，进上下文是要付费的，进版本必须通过因果门控。模型权重不变。

## 安装与配置

需要 Node.js 24+、Git、DSH 0.2.1-rc.2 起的 0.2.x，以及本地 spawn、skills、tools、systemPrompt、commands、llm 服务。实际接口测试覆盖 0.2.1-rc.2；0.2.0-rc.2 缺少 startActivation，不能探测。后续宿主版本仍需能力检查。

~~~powershell
dsh plugin --profile tui add "C:\path\dsh-soul-1.0.0.tgz"
~~~

插件默认关闭。在 profile 的用户 patch 中配置已有节点，provider/model 使用宿主已注册的路由：

~~~yaml
- id: dsh-soul
  config:
    enabled: true
    profile: tui
    provider: your-provider
    model: your-model
    validationTrials: 2
    repeatThreshold: 3
    shadowWindow: 3
    checks:
      - name: project-tests
        argv: [node, --test, tests/acceptance.test.mjs]
        protectedPaths: [tests, package.json]
~~~

checks 必须验证实际产物。文件型检查必须声明 protectedPaths，覆盖测试代码、测试配置和依赖的验收逻辑；相对路径以项目工作目录为基准，不支持 glob。独立的 node -e 内联检查可省略该字段，其完整命令固定在配置中。只检查退出码的空测试无法证明任务正确；验收覆盖面仍由项目维护者负责。

探测使用新的 Git worktree，需要干净、已有提交的仓库。被忽略的 node_modules、虚拟环境、密钥不会自动复制；请先确保验收命令和任务环境可在独立 worktree 使用。命令直接按 argv 执行，不经过 shell。

数据库默认在 DSH_HOME/dsh-soul/<profile>/evolve.sqlite，未配置 DSH_HOME 时用 ~/.dsh。无法确定 profile 且未指定 database 时明确拒绝。不同 profile 不共享默认库。旧 Soul 数据库不自动打开或迁移。

## 八个组件如何生效

| 组件 | 存储形式 | 实际连接 |
| --- | --- | --- |
| C1 工作方式 | system.md | 主会话与探测子会话的提示上下文，保留锚定区 |
| C2 护栏 | guardrails.md | 同上；不能改宿主权限和审批规则 |
| C3 项目事实与记忆策略 | memory.md | 同上；不是旧 Soul 记忆检索系统 |
| C4 工具指引 | tools.md | 同上 |
| C5 委派指引 | subagents.md | evolve_catalog 返回决策指引；evolve_delegate 启动真实 spawn 并给子代理加载指引 |
| C6 技能 | skills/<name>/SKILL.md | 注册到真实 ctx.skills provider，宿主 skill 工具按需读取 |
| C7 脚本 | scripts/<name>.mjs | evolve_script 在可终止独立进程中执行纯 JSON 转换 |
| C8 工具反馈 hook | hooks/<name>.mjs | 真实 tools/post-execute 事件调用，追加建议，保留原始值和错误状态 |

候选探测与线上使用同一套组件加载机制。候选目录拥有独立的技能视图；探测结束移除视图。版本切换会使技能目录缓存失效，脚本和 hook 根据当前版本重新选择；回滚后不能再加载被撤销的组件。已进入历史上下文的文字不会被擦除。

### C5：委派

先调用 evolve_catalog 读取 delegationPolicy，再调用 evolve_delegate，并写清子任务与验收标准。子代理遵守宿主递归深度和权限；不修改 provider 配置，不扩大授权。探测中的插件委派以及可识别的本地宿主后代调用，共用该探测的请求上限和预算，usage 汇总进对照指标。远程或外部工具自行调用第三方服务不在此计量范围。

### C6：技能

~~~markdown
---
name: build-check
description: 构建失败时使用，先检查依赖，再执行项目验收
---
先检查项目声明的构建命令与依赖，再执行相关验收，报告通过和失败项。
~~~

对应路径 skills/build-check/SKILL.md，宿主注册名为 soul-build-check。元数据仅支持 name 和单行 description。技能正文按需加载；宿主仍会展示简短技能目录，这部分也会占用上下文。

### C7：脚本

~~~javascript
export function run(input) {
  return [...new Set(input)].sort()
}
~~~

用 evolve_script 传入 name 和 JSON 字符串 input。当前契约是独立纯函数：不提供 import、文件、网络、进程、环境变量或宿主工具接口。输入最多 100 KB（含代码），输出最多 24 KB，进程超时 5 秒，单次同步执行最多 200 毫秒。需要读写项目文件时仍调用宿主工具，保留其权限链。

### C8：hook

~~~javascript
export const timeoutMs = 100
export const failOpen = true
export function run(event) {
  return event.isError ? {note: '先检查失败原因，避免原样重复调用。'} : {}
}
~~~

当前只连接工具执行后的建议反馈；不替换工具参数、结果、成功状态或审批结果。运行失败、超时、非法输出不会拦截原工具结果。每个 hook 的 timeoutMs 为 1–1000 毫秒，总进程生命周期上限 1 秒，最多激活 4 个；单次同步执行最多 200 毫秒。hook 运行在独立进程中，代码无法通过提供的接口直接调用宿主服务。

## 如何判断变好了

1. 真实主会话观察只用于归因，不能与新子会话直接比较成绩。
2. 开始演化时固定当前已提交代码、项目相对目录、任务输入、模型路由、检查命令与受保护验收文件指纹。新子会话不复制主会话全部历史；两组使用相同的重放输入。
3. 一次只改一个组件。默认跑两组旧策略/候选对照，交替执行顺序。任意候选验收失败则提前停止；某一组对照既无质量收益也无效率收益时同样提前停止，因为剩余重复已不可能改变“每一组都要赢”的结论。
4. 候选必须每次通过同一组实际验收。质量提升要求每组旧策略失败、候选通过；效率提升要求双方每组都通过，并重复达到至少 20% 的 token 或耗时改善，另一项不恶化超过 10%。缺 token usage 时不授予效率收益；短于 1 秒的计时不作为可靠速度依据。
5. 缩短提示词、减少步数或工具调用不能单独触发采纳。验证文件在执行前、执行后及验收后都核对，改变即作废。
6. 候选进入 shadow 后真实生效。正常结束或用户沉默不会推进转正；同类真实任务完成后运行 /evolve verify，实际检查通过才计一轮。同一轮不能重复计数；错误、未完成或用户纠正仍可自动回滚。

两次重复同一任务不能证明泛化能力。转正只表示通过已声明的检查和试用窗口，不是所有任务都会变好。结构检查和锚定区也不等于自然语言策略的完备安全证明。

## 经验编译：免费观察，付费编译，验证后才算经验

主代理的每轮上下文不增加任何经验文本。每轮结束后只在本地库做一次分类与聚类：

| 观察 | 类型 | 能否触发编译 |
| --- | --- | --- |
| 用户纠正 | user_correction | 是 |
| 工具错误且未完成 | tool_error | 是 |
| 未完成 | incomplete | 是 |
| 工具错误但最终完成 | recovery | 是 |
| 同类任务此前分歧、本轮干净完成 | resolved | 否，只作正样本 |
| /evolve verify 实际检查通过 | verified_success | 否，只作正样本 |

同一类模式按词项重合聚类，措辞变化不会新建簇；支持度达到 repeatThreshold（默认 3）且最近一次出现在 repeatWindowDays（默认 7 天）内，才转为 candidate 并出现在 `/evolve diagnose`、evolve_diagnose 和 evolve_request 的候选里。候选仍然不是提示，也不是版本。过期模式仍是历史，不会因为很久以前出现过就再次触发付费编译。聚类、状态变更和报告都不调用模型。

`/evolve run` 仍是唯一的付费入口。它可以用当前会话的分歧，也可以直接用支持度达标的经验簇（以该簇最近一次的任务文本、指标与轨迹作为探测输入）；阈值只决定资格，不会自动启动付费编译。编辑会话的 `index.contrast` 只有三块：经验簇摘要、当前观察的指标与错误、同任务的成功/恢复样本；原始轨迹仍按路径读取。contrast 上限 3000 字节，并明确标注为数据而非指令。

编译结果不是新版本：它先经过结构检查，再从同一固定提交、同一任务、同一路由和同一验收定义做旧策略/候选成对重跑；通过后才进入 shadow。shadow 内出现用户纠正、未完成或工具错误高于基线时自动回滚，并让编译这条经验的版本重新变为可尝试；同一经验因回滚或拒绝累计两次失败后退役，不再自动复活。只有显式回滚会重开已编译的经验，普通复发只增加支持度，不会重复购买编辑会话。

`/evolve report` 汇总经验池状态、进入试用/转正/回滚率、按阶段的调用与输入字节，并明确区分“已观察到的成本”与“尚未证明的留存/迁移”。不能把一次转正率当成泛化能力。

## 使用流程与命令

~~~text
/evolve status             能力、验证规则、当前版本、经验池、额度和试用窗口
/evolve diagnose           最近分歧与重复次数；无分歧时列出支持度达标的经验簇
/evolve run [C1–C8]        对最近分歧或经验簇启动一次精炼，默认使用归因目标
/evolve verify             验收最近一次真实试用任务，并记录正样本
/evolve report             经验池、进入试用/转正/回滚率、按阶段调用与输入字节
/evolve diff [A] [B]       比较版本
/evolve log [n]            审计账本
/evolve explain [rev]      采纳依据
/evolve rollback [rev]     回滚并撤销新增组件加载
/evolve watch              待决试用窗口
/evolve tree               组件大小
/evolve lint               校验当前树
/evolve export [目录]      导出供人工审阅
~~~

同类分歧默认出现 3 次才允许启动；没有当前分歧时，经验簇也必须达到同样的支持度。一次 /evolve run 授权编辑、成对探测及通过后的真实试用；没有按关键词自动付费的后台循环。未结束的试用窗口会阻止叠加新演化。

管理工具：evolve_status、evolve_diagnose、evolve_request、evolve_tree。执行工具：evolve_catalog、evolve_script、evolve_delegate。evolve_request 只返回资格，不会直接启动付费演化；evolve_delegate 是真实付费子任务。

## 成本、运行边界与升级

默认每次最多 60 次模型请求、640,000 输入字节、20 分钟；每个探测臂另有 3 分钟独立超时。每个臂的步数按 `(episodeCalls - 编辑器预算) / (2 × validationTrials)` 均分（默认 12 步，probeSteps 只是上限），避免前面的臂吃光额度、后面的臂付费后失败。每项目每日最多 100 次请求、800,000 输入字节。编辑请求最多 24,000 输入字节，探测请求最多 64,000 输入字节，单请求 60 秒。validationTrials 默认 2，可配 2–5，总额度不会随试验数自动提高。预算包含编辑、旧策略重跑、候选以及受管本地委派，失败或取消也计费；额度用完会停止，不降低验证门槛。装不下一对最小探测时，在编辑器调用前直接拒绝。

这些是上限，不是固定消耗，也不是货币预算。C1–C4 默认 1952 字节，上限 2400 字节；此数不包含工具 schema、技能目录、按需加载正文和宿主自身上下文。状态读取缓存已物化的版本，避免重复查询每个组件正文。

经验观察与聚类是本地 SQLite 写入：不调用模型，不增加任何提示字节，1.0 也没有新增 C9。主代理每轮的固定税仍是 C1–C4，与 0.9.1 相同。只有 /evolve run 触发的编辑会话会读取 contrast（≤3000 字节）；经验轨迹、detail 与 success 快照按 4–8 KB 截断保存。`/evolve report` 只读本地数据，同样零调用。

Git worktree 不是安全沙箱；宿主工具仍具有其正常权限。Node 权限与独立 VM/进程用于限制组件接口和终止失控执行，不应视为可对抗恶意代码的 OS 级隔离。检查指纹能发现申明路径上的变化，不能阻止具有相同系统权限的进程篡改外部环境，也不能自动识别遗漏的验收依赖。

本次 1.0 审查修复将数据库 schema 升到 3。从 0.9.1 升级时仍会补齐 lesson 表与 episode.lesson 列；从原 1.0 升级时会一次性脱敏历史观察字段，并从安全任务文本重建经验词项。无法恢复上下文的旧观察/影子窗口词项会被清空，仍可按原 taskKey 匹配。版本树、经验支持度、账本事件和预算记录保留；历史备份文件不在清理范围内。旧插件无法打开 schema 3，请勿混用版本。运行路径、checks 与 provider/model 配置无需修改。

修复后，回滚到较早版本会在同一事务内退役被撤销的中间版本并更新关联经验；当前会话分歧和经验池入口都检查 compiled/retired 状态。退役记录不参与普通历史淘汰。单次演化的调用数和输入字节按 episode 全生命周期累计，跨 UTC 零点或重启不会重置；每日额度仍按 UTC 日期重置。没有 episode 的常规委派只受每日额度限制。

从 0.8.1 升级：补充有效 checks，文件型检查补充 protectedPaths；不提供验收时在模型调用前拒绝。旧的未结束试用缺少成对验证定义，不能用 verify 转正，请先 rollback 再按新规则演化。历史记录保留；新版本标识加入项目与父版本，修复相同内容跨项目共享状态。已经回滚的同一版本不能被自动再次激活。

## 验证

~~~powershell
npm run check
npm run demo
$env:DSH_TEST_PACKAGE = 'C:\path\node_modules\@deepseek-ai\dsh\package.json'
npm run test:host
~~~

宿主测试使用真实 Cordis、AgentLoop、技能服务、工具执行链和 spawn，只在模型供应商边界使用确定性响应，不调用付费 API。离线 demo 的编辑器和执行器都是替身。测试证明实现路径和拒绝条件，不证明真实模型在未知项目上的提升。1.0 新增经验分类、聚类、contrast、编译/退役/回滚、报告与 schema 迁移测试；完整结果见 docs/VALIDATION-1.0.0.md。
