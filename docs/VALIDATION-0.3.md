# DSH Soul 0.3.0 验证记录

日期：2026-10-26。Windows / Node 24.19.0；未使用付费模型请求，未修改常用 DSH profile。

## 功能与兼容

在 DSH 0.2.0-rc.2 和 0.2.1-rc.2 的真实宿主服务上，分别通过 `npm run check`：65 项测试、11 个确定性检索场景，无跳过。

新增覆盖实际 SessionStore/ToolRuntime/CommandRuntime 的方法登记、工具结果按 call ID 配对、排除 Soul 自身输出、报告来源检查、前后对比及人工审核。另覆盖缺失/外部/其他轮次来源、迟登记、多个方法、缺失结果、重启中断、缓存失效、基线失效、技能删除以及未报告观察的遗忘。

原有 LlmRuntime 仍使用本地确定性适配器验证协议、usage 和取消流程。这些测试不证明远程模型的提炼质量或总任务提速。CI 还在 Windows/Linux × 两个精确宿主版本上运行相同检查，结果以该发布提交的 Actions 为准。

标准 TGZ 已通过 DSH 0.2.1-rc.2 CLI 安装到独立 `soul-03-check` profile。`--dump-config` 包含 `dsh-soul`、正确注入项、`learning: false` 与 `learningMode: efficiency`；安装后的入口通过全部 6 项真实宿主集成，入口 SHA256 与源码一致。未设置兼容风险豁免。

## 真实旧包升级

使用已发布的 `dsh-learning-0.1.0.tgz` 与 `dsh-soul-0.2.1.tgz` 创建旧库后，加载当前代码升级到 schema 3。验证记忆文本、来源、技能反馈、状态、遗忘指纹和已用额度保持；升级后可以登记新试用；SQLite integrity_check 和 foreign_key_check 正常；旧插件明确拒绝打开新库。

复现：

```text
node scripts/verify-upgrade.mjs /path/to/dsh-learning-0.1.0.tgz /path/to/dsh-soul-0.2.1.tgz
```

## 本地开销

AMD Ryzen 9 7945HX / 32 GiB / Windows / Node 24.19.0，临时磁盘 SQLite，100 次样本。数值会受设备、文件系统、后台负载影响。

| 场景 | p50 毫秒 | p95 毫秒 |
| --- | ---: | ---: |
| 10000 条事实，特定标签检索，插件缓存未命中 | 0.172 | 0.283 |
| 10000 条事实，宽泛中文检索，插件缓存未命中 | 23.970 | 26.512 |
| 10000 条事实，同一中文查询，插件缓存命中 | 0.004 | 0.007 |
| 1000 条技能，未缓存检索与证据排序 | 3.696 | 6.009 |
| 一轮 13 个观察事件（开始、步骤、5 对工具调用/结果、结束） | 27.169 | 32.541 |

`npm run bench` 和 `npm run bench:experience` 可复现。未清空操作系统/SQLite 缓存，观察测试不执行真实工具。以上数字只描述插件本地开销，不是完整任务耗时，不代表其他设备速度，不证明 0.3 相对 0.2 有任务提速。

## 尚未验证

真实模型任务成功率、完整任务耗时与费用、跨设备长期运行、完整桌面 UI 和所有第三方插件组合。方法报告仍需核对任务与环境的可比性；不把确定性测试包装成 Harness² 论文复现。
