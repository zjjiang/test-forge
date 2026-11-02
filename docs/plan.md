# TestForge MVP 计划（含 Web UI）

## Context
TestForge 是一个场景驱动的 AI 测试平台，以 GPT 写的计划书为准，同时吸收 htinns-test 已经跑通的做法（多角色 context、`操作 → 验收点`、teardown 必执行、高危接口拦截、截图命名和失败补拍、报告可整体拷走）。
用户已确认：
- 技术栈是 Playwright 打底，上面接 Midscene。
- MVP 之后直接用平台测 htinns，每次场景执行都要留痕。
- 平台要按项目区分。每个项目在 Web UI 上配置 global 环境变量。

## 第 0 步：UI 原型（先做，给用户看）
- 做成单个 HTML Artifact，只是静态原型，没有后端。
- 页面：
  1. 项目列表
  2. 项目详情 → 环境变量（global）：key、value、是否 secret（secret 掩码显示）、说明；支持增删改
  3. 项目详情 → 场景列表：最近一次结果、执行次数
  4. 场景执行历史：按时间排的 run 列表，显示状态（passed / failed / needs_review）、耗时、触发人或 Agent
  5. Run 详情：步骤列表、每步的验收点、前后截图、断言表（区分确定性断言和 AI 断言）、每次尝试的记录、Trace 下载
- 示例数据用 htinns（新店开通、信科Cookie失效更换）。
- 用户确认原型后再写真实实现。

## 架构
- 浏览器层：Playwright 负责 context、addInitScript 注入、route Mock、clock、trace、截图、DOM 断言。
- AI 层：`@midscene/web` 的 PlaywrightAgent，提供 aiAct、aiAssert、aiWaitFor、aiQuery。模型统一用智谱 GLM：`MIDSCENE_MODEL_FAMILY=glm-v`，加上 `MIDSCENE_MODEL_NAME`、`MIDSCENE_MODEL_BASE_URL`、`MIDSCENE_MODEL_API_KEY`。这几项配置存为项目 global 变量，Key 标为 secret。
- 存储：SQLite（better-sqlite3）存项目、变量、场景索引和 run 索引。证据文件放在 `data/projects/<p>/runs/<runId>/`，场景快照、脱敏后的变量快照、截图、trace.zip、summary.json、report.html 都在这里，目录可以整体拷走。
- 变量优先级：项目 global < 场景 `variables` < CLI `--var`。场景里用 `${var:NAME}` 引用。secret 在快照和日志里一律脱敏。
- 服务和 UI：Fastify API 加 React（Vite）前端。CLI 和 Web 共用同一个 runner。
- 判定规则：只有 AI 断言通过时，结果是 `needs_review`。至少有一条确定性断言通过且没有失败，结果才是 `passed`。重试的每次尝试都保留。

## 实施顺序（TDD，Vitest）
1. UI 原型（Artifact）→ 用户确认
2. 项目骨架（TS、pnpm），实现 scenario schema（zod）、loader、`validate`
3. 存储层：项目、变量（secret 加密存储，密钥来自 env）、run 索引
4. Runner：actors、注入、Mock、护栏、确定性动作和断言、证据落盘
5. 接入 Midscene：ai_action、visual_assert
6. Fastify API 和 React UI（按确认后的原型实现）
7. 试点：把 htinns `新店开通` 改写成 YAML，在平台上跑通

## 验证
- 单元测试：schema、变量合并和脱敏、判定规则
- 集成测试：自带 demo 页面跑通 Mock 和注入，跑一遍 run，检查落盘文件
- 端到端：Web UI 新建项目、配置变量、触发 run、查看历史和截图
- 试点：htinns `新店开通` 在 TestForge 上通过，并且留痕可查
