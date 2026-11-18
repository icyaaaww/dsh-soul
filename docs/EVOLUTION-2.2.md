# 2.2 开发版：演化与评测

普通完成或错误恢复只是观察，只有项目验收通过才算产物证据。工具指引支持按整行精确替换；全文件编辑仍兼容。编辑器可按需读取上次同簇的修改和拒绝原因。连续失败暂停付费尝试；新验收的同类任务（不同 taskKey）可给已暂停的问题一次新机会。仅重复上报不解锁。

## 在原题通过后测试新题

以下是项目方配置示意，所列测试文件须由项目实际提供。任务、检查和适用的项目范围应在看到候选前固定。在项目中准备测试，但不要把留出题答案放进编辑器可见的轨迹或原题。系统会排除归一化后相同的题面；语义重复和训练数据污染仍需项目方排查。

```yaml
evolution:
  enabled: true
  holdouts:
    - role: transfer
      task: 修复另一个工作区中从子目录运行构建时的路径问题
      checks:
        - name: nested-build
          argv: [node, --test, tests/nested-build.test.mjs]
          protectedPaths: [tests, package.json]
    - role: control
      task: 在项目根目录更新根构建产物
      checks:
        - name: root-build
          argv: [node, --test, tests/root-build.test.mjs]
          protectedPaths: [tests, package.json]
```

仍需原题的顶层 `checks`。原题通过所有成对比较后才运行新题；每题比较旧版和候选版。迁移题要求修好产物、满足既有效率门槛或减少工具错误。对照题要求两版均通过产物验收，且候选不增加工具调用或错误。两题都通过才进入原有影子试用；这不等于证明普遍泛化。每题一旦开始回放就视为消耗，失败或中断后也不能在同一 scope 重用。请更换已经消耗的题再运行。未启用该设置则迁移结论是 `unknown`。

`validationTrials: 2` 时，最多从 4 个执行臂变为 8 个。仍从同一个 episode 调用上限预留，所以每臂的步数可能变少。实验比较时应锁定实际每臂步数；若新旧配置不同，不能把差异都归因于规则。

## 三组外部实测

在固定项目提交、模型路由、验收、推理参数和总调用上限下，分别运行 `fixed21`（2.1 不学习）、`evolve21` 和 `evolve22`。各组从独立的学习库开始，使用相同训练任务。冻结三个最终版本，再在它们都没看过的任务上测量。发布评测不要重复使用上述调参用例。事先定义各任务的目标错误（例如错误路径调用），从实际轨迹计数。至少覆盖工作目录、工具参数、漏做交付验收；每类都准备迁移题和不该受影响的任务。

从仓库根运行 `npm run bench:evolution -- measurements.json`。工具只汇总，不运行宿主，不产生实测数据。JSON 顶层字段为 `model`、`revision`、`callBudget`、`learningCalls` 和 `cases`。`learningCalls` 是三组各自编辑与验证消耗的调用总数（`fixed21` 为 0）。`cases` 中每行需要唯一 `id`、`role`（`transfer` 或 `control`）及三个组名字段。每组字段格式是 `{"passed":true,"targetErrors":0,"calls":3}`，其中 `calls` 仅为该组本次最终任务的调用数。重复种子要用不同的行 ID。不要删掉失败的运行。

输出相对于固定 2.1 的修好题数、退化题数、目标错误减少量及额外调用成本；无修好题目时单题成本为 `null`。计数不提供显著性判断，模型和版本元数据由实验者保证一致。仓库里的确定性 fixture 只验证门控逻辑，不是效果数据。
