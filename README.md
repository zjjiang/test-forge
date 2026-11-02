# TestForge

面向 AI Coding 工作流的场景驱动自动化测试平台。由 Data Forge 团队维护，基于 Apache-2.0 许可证。

> 状态：设计阶段。目前仓库里只有计划和 UI 原型，还没有可运行的代码。

## 要解决的问题

AI Coding 写代码已经很快，测试仍然是瓶颈：

- 人工测试要反复点击、输入、检查页面。
- 传统自动化测试要维护大量 CSS Selector 和固定脚本。
- 直接让 AI 自己测，没有可靠的结果验证。
- 特殊用户身份、业务状态、系统时间这类测试环境很难快速准备。
- 测试结果缺少统一的截图、执行轨迹和验证证据。

## 核心原则

AI 负责操作，代码负责验证，证据负责说明，人负责最终确认。

- 场景用 YAML 描述，场景定义和执行引擎分开。
- 环境注入、接口 Mock、关键断言都由确定性代码完成。
- 只有 AI 断言通过的场景判为「待人工复核」，不算通过。
- 每次执行生成独立的 Run，保留场景快照、截图、Trace、断言结果和每一次重试记录。

## 技术栈

- [Playwright](https://playwright.dev/)：浏览器、多角色上下文、变量注入、Mock、时间控制、截图、Trace、DOM 断言。
- [Midscene.js](https://www.midscenejs.com/)：自然语言操作页面和视觉断言。模型使用智谱 GLM（`glm-v`）。
- TypeScript、Node.js、Zod、Vitest；SQLite 存项目和执行记录；Fastify 和 React 提供 Web 界面。

## 功能规划

- 按项目管理：每个项目有自己的被测地址、全局环境变量（支持 secret）和安全护栏。
- 场景支持多个角色，每个角色有独立的浏览器上下文；`teardown` 一定执行。
- 安全护栏：拦截高危接口，拒绝在生产域名上运行。
- CLI 和 Web 共用同一个执行引擎，CLI 支持 `--json` 输出，方便 Claude Code、Codex 等 Agent 调用。

## 快速开始（开发中）

```bash
pnpm install
pnpm tf project add htinns "HTinns 新平台" http://127.0.0.1:5005
pnpm tf var set htinns ADMIN_USER=admin --secret --note 管理员账号
pnpm tf validate scenarios/htinns/      # 校验场景
pnpm tf run scenarios/htinns/新店开通.yaml -p htinns   # 执行
pnpm tf runs                            # 执行历史
pnpm tf report                          # 打开最近一次的报告
pnpm tf serve                           # Web 控制台 http://127.0.0.1:3300
```

场景 YAML 放在 `scenarios/<项目ID>/` 下，Web 控制台会自动索引。
AI 步骤需要 GLM 配置：给项目加 `MIDSCENE_MODEL_FAMILY=glm-v`、
`MIDSCENE_MODEL_NAME`、`MIDSCENE_MODEL_BASE_URL`、`MIDSCENE_MODEL_API_KEY`（secret）。

## 文档

- [实施计划](docs/plan.md)
- [UI 原型](docs/prototype/ui.html)：下载后用浏览器直接打开。

## License

[Apache-2.0](LICENSE)
