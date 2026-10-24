# DSH Soul 0.2.1 宿主兼容验证

验证日期：2026-10-24。

## 问题与修复

Soul 0.2.0 的清单声明 `engines.dsh: 0.2.0-rc.2`。在 DSH 0.2.1-rc.2 的独立环境中，标准安装命令实际返回版本不兼容并回滚安装。该行为来自宿主的清单检查，不能据此认定发生过插件崩溃或数据丢失。

新版宿主上的功能测试通过后，Soul 0.2.1 将范围改为 `0.2.0-rc.2 || 0.2.1-rc.2`，仅接受两个经过测试的版本，没有使用 `*`、删除兼容声明或设置风险豁免。插件运行时代码和 schema 2 未变化。

## 可复现的检查

新宿主从官方 npm registry 安装到独立工作目录，不替换全局 DSH。插件操作使用独立 DSH_HOME。设置下列测试变量后执行 `npm run check`：

```text
DSH_TEST_PACKAGE=<isolated-host>/node_modules/@deepseek-ai/dsh/package.json
DSH_TEST_VERSION=0.2.1-rc.2
```

本地 Windows / Node 24.19.0 的 48 项测试与 11 个检索场景通过，无跳过。新增的五项宿主集成同时针对 0.2.0-rc.2 回归通过。CI 将同一完整检查运行在 Windows/Linux 和两个精确宿主版本的四种组合上，结果以对应提交的 Actions 为准。

标准安装验证也已完成：新 CLI 在独立 profile 成功安装 Soul 0.2.1，`--dump-config` 包含正确的 bundle 注册；安装后的 TGZ 入口通过五项真实宿主集成测试。旧宿主中的 Soul 0.2.0 也已通过标准安装命令升级为 0.2.1。全程没有设置风险豁免或修改用户常用 profile。

测试内容：

- 真实 CommandRuntime、SessionStore、SystemPrompt：命令、消息来源、候选确认、上下文和技能卡片。
- 真实 ToolRuntime：工具注册、参数与输出处理、查询、按 ID 读取及卸载清理。
- 真实 LlmRuntime + 本地确定性 LlmAdapter：明确路由、提炼请求、来源约束、usage、忽略 reasoning、取消在途学习。
- Cordis 插件加载、卸载及重复加载。
- 磁盘记忆在卸载/重载后保留；修订版本关系与遗忘在重新打开后仍有效；SQLite integrity_check 为 ok。
- 新宿主兼容检查器接受新版声明，拒绝旧包声明和未声明支持的宿主版本。
- 保留的 schema 1 → 2 升级测试验证记忆、来源、遗忘指纹和已用调用额度；此补丁没有新增数据迁移。

## 验证边界

测试通过表示所覆盖接口和数据流程可运行，不是所有插件组合与未来版本的无故障保证。LLM 流程没有发出付费 API 请求；本地适配器验证宿主协议，不证明远程供应商的可用性或提炼质量。没有进行桌面 UI 全流程和长时间压力测试。

使用 DSH 0.2.1-rc.2 的用户应下载 Soul 0.2.1 的安装包，不对 Soul 0.2.0 设置 `allow-version`。已有 Soul 0.2.0 用户正常退出 DSH 后安装新包即可，原数据目录和命令保持不变。
