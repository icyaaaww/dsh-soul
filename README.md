# DSH Soul 0.9.0 — 独立 Evolve

从真实任务的分歧中精炼运行策略。保留独立 Evolve 架构，不包含旧 Soul 的记忆检索、后台学习或固定答案套件。

0.9 的重点是可信采纳与 C1–C8 的实际执行：旧策略和候选必须从同一提交、同一输入、同一路由和验收定义分别重跑；只有重复验证支持改善才进入真实任务试用。模型权重不变。

## 安装与配置

需要 Node.js 24+、Git、DSH 0.2.1-rc.2 起的 0.2.x，以及本地 spawn、skills、tools、systemPrompt、commands、llm 服务。实际接口测试覆盖 0.2.1-rc.2；0.2.0-rc.2 缺少 startActivation，不能探测。后续宿主版本仍需能力检查。

~~~powershell
dsh plugin --profile tui add "C:\path\dsh-soul-0.9.0.tgz"
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
3. 一次只改一个组件。默认跑两组旧策略/候选对照，交替执行顺序。任意候选验收失败则提前停止。
4. 候选必须每次通过同一组实际验收。质量提升要求每组旧策略失败、候选通过；效率提升要求双方每组都通过，并重复达到至少 20% 的 token 或耗时改善，另一项不恶化超过 10%。缺 token usage 时不授予效率收益；短于 1 秒的计时不作为可靠速度依据。
5. 缩短提示词、减少步数或工具调用不能单独触发采纳。验证文件在执行前、执行后及验收后都核对，改变即作废。
6. 候选进入 shadow 后真实生效。正常结束或用户沉默不会推进转正；同类真实任务完成后运行 /evolve verify，实际检查通过才计一轮。同一轮不能重复计数；错误、未完成或用户纠正仍可自动回滚。

两次重复同一任务不能证明泛化能力。转正只表示通过已声明的检查和试用窗口，不是所有任务都会变好。结构检查和锚定区也不等于自然语言策略的完备安全证明。

## 使用流程与命令

~~~text
/evolve status             能力、验证规则、当前版本、额度和试用窗口
/evolve diagnose           最近分歧与重复次数
/evolve run [C1–C8]        启动一次精炼，默认使用归因目标
/evolve verify             验收最近一次真实试用任务
/evolve diff [A] [B]       比较版本
/evolve log [n]            审计账本
/evolve explain [rev]      采纳依据
/evolve rollback [rev]     回滚并撤销新增组件加载
/evolve watch              待决试用窗口
/evolve tree               组件大小
/evolve lint               校验当前树
/evolve export [目录]      导出供人工审阅
~~~

同类分歧默认出现 3 次才允许启动。一次 /evolve run 授权编辑、成对探测及通过后的真实试用；没有按关键词自动付费的后台循环。未结束的试用窗口会阻止叠加新演化。

管理工具：evolve_status、evolve_diagnose、evolve_request、evolve_tree。执行工具：evolve_catalog、evolve_script、evolve_delegate。evolve_request 只返回资格，不会直接启动付费演化；evolve_delegate 是真实付费子任务。

## 成本、运行边界与升级

默认每次最多 60 次模型请求、320,000 输入字节、8 分钟；每项目每日最多 100 次请求、800,000 输入字节。每请求最多 24,000 输入字节、60 秒。validationTrials 默认 2，可配 2–5，总额度不会随试验数自动提高。预算包含编辑、旧策略重跑、候选以及受管本地委派，失败或取消也计费；额度用完会停止，不降低验证门槛。

这些是上限，不是固定消耗，也不是货币预算。C1–C4 默认 1952 字节，上限 2400 字节；此数不包含工具 schema、技能目录、按需加载正文和宿主自身上下文。状态读取缓存已物化的版本，避免重复查询每个组件正文。

Git worktree 不是安全沙箱；宿主工具仍具有其正常权限。Node 权限与独立 VM/进程用于限制组件接口和终止失控执行，不应视为可对抗恶意代码的 OS 级隔离。检查指纹能发现申明路径上的变化，不能阻止具有相同系统权限的进程篡改外部环境，也不能自动识别遗漏的验收依赖。

从 0.8.1 升级：补充有效 checks，文件型检查补充 protectedPaths；不提供验收时在模型调用前拒绝。旧的未结束试用缺少成对验证定义，不能用 verify 转正，请先 rollback 再按新规则演化。历史记录保留；新版本标识加入项目与父版本，修复相同内容跨项目共享状态。已经回滚的同一版本不能被自动再次激活。

## 验证

~~~powershell
npm run check
npm run demo
$env:DSH_TEST_PACKAGE = 'C:\path\node_modules\@deepseek-ai\dsh\package.json'
npm run test:host
~~~

宿主测试使用真实 Cordis、AgentLoop、技能服务、工具执行链和 spawn，只在模型供应商边界使用确定性响应，不调用付费 API。离线 demo 的编辑器和执行器都是替身。测试证明实现路径和拒绝条件，不证明真实模型在未知项目上的提升。
