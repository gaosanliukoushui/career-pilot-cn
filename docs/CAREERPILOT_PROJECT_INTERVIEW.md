# CareerPilot CN 项目面试特训

项目面试特训从已通过正式导出 QA 的简历中识别项目，调用本机 AI 命令行工具规划题目与反馈，再由 CareerPilot 服务端完成 Fact 校验和候选人答案渲染。它用于帮助候选人讲清“问题、本人责任、方案与取舍、验证、真实边界”，不会把项目仓库、技术栈或模型常识自动当成候选人经历。

## 使用流程

1. 在 `/cv` 完成主简历或定向简历的确认与正式导出。
2. 打开 `/interview-center`，在“项目面试特训”中选择正式简历来源。
3. 选择简历里的项目，填写目标岗位；系统使用本机已登录的 Codex。
4. 生成项目分析、安全开场、六类问题和服务端参考答案。
5. 逐题输入自己的回答并提交点评。
6. 查看五维评分、原回答命中点、需加强项、未核实主张、只用已确认 Fact 生成的更强版本和下一道追问。

页面会自动显示当前正式简历实际包含的项目，项目名称和数量不是写死在前端的。简历重新导出、项目 Fact 或确认状态变化后，系统以新的有效正式产物为准。

## “特训”是怎样实现的

这里的特训不是把个人简历上传做模型微调，也不是只换一句提示词，而是四层约束：

- 专用提示词：固定六类题目和五段式回答结构，强调团队/个人项目的责任边界。
- 动态 JSON Schema：每次请求把项目 ID、问题哈希、回答哈希以及可选 Fact ID/哈希锁进 Schema。
- 服务端确定性校验：AI 只能选择 Fact、题型、评分和固定反馈模板；服务端重算哈希、校验引用和责任/指标边界。
- 服务端确定性渲染：参考回答和更强版本只使用完整 Fact 原文或已确认 rewrite，模型自由生成的经历散文不会进入可复述答案。
- 确定性降级：模型连续两次无法满足结构/事实协议时，服务端用同一批已核验 Fact 生成固定六题和安全反馈，避免模型随机性让训练中断；超时、取消或来源失效不会触发降级。

因此，示例简历适合用于提炼“问题—责任—行动—结果”的表达策略，但不应直接喂给模型当作候选人的事实。更深的项目细节应先转成有 Evidence、可发布且允许用于面试的 CandidateProfile Fact，再参与训练。

## 可信来源与安全边界

系统只接受满足以下条件的来源：

- 位于 `output/careerpilot/` 的正式 DOCX/PDF 及其 manifest；
- 输出哈希与 manifest 一致；
- 导出 QA 为 `verified`，并通过页数、文本层、截断和语义检查；
- 对应 ResumeVariant 仍有效，且确认记录与变体哈希匹配；
- 项目 Fact 为 `confirmed`，有 Evidence，且 `allowed_uses` 包含 `interview`。

项目指南、兄弟仓库、聊天记录和模型常识都不会被偷偷拼进回答。回答中新出现的职责、指标或成果只会被标为“待核实”，不会自动写回 Profile。

Web 与桌面 App 的项目面试入口只使用 Codex。每次调用都在独立临时目录中执行，使用临时会话并忽略用户配置、项目规则；同时关闭 Shell、MCP/Apps、浏览器、Computer Use、多代理、Web 搜索和命令网络。专用权限配置额外拒绝根文件系统，只保留 Codex 运行所需的最小运行时路径和隔离工作区；简历 Fact 仅经 stdin 传入，stderr 不回显到浏览器。Codex 只负责受生成 Schema 约束的题目与点评计划；返回结果还会继续通过 CareerPilot 原有的严格 Schema、Fact ID、SHA-256 和确定性渲染校验。

## CLI 与 API

CLI 提供可组合的确定性原语：

```powershell
node careerpilot.mjs interview-projects
node careerpilot.mjs interview-pack-prompt --stdin
node careerpilot.mjs interview-pack-validate --stdin
node careerpilot.mjs interview-pack-fallback --stdin
node careerpilot.mjs interview-review-prompt --stdin
node careerpilot.mjs interview-review-validate --stdin
node careerpilot.mjs interview-review-fallback --stdin
```

Web API：

- `GET /api/cn/interviews/projects`
- `POST /api/cn/interviews/projects/pack`
- `POST /api/cn/interviews/projects/review`

请求体有 64 KB 总上限和逐字段长度限制。AI 超时、输出过大、引用错误、哈希漂移、越界 Fact 或敏感信息都会被拒绝，CLI 的 stderr 不会回显到浏览器。仅当两次模型计划均因结构或事实校验失败时，API 才返回确定性降级结果，并通过 `X-CareerPilot-Generation-Mode: deterministic-fallback` 标注。

## 验证

```powershell
npm run careerpilot:interview-test
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
npm run desktop:dist
```

桌面 App 打包会强制执行 packaged smoke，确认 `/interview-center`、项目目录 API、训练包 API 和点评 API 均真实存在于安装产物中；因此旧的 `0.3.0` 安装包不会被误报为已同步，新安装包版本为 `0.3.1`。

项目面试测试还覆盖伪造 manifest、过期 ResumeVariant、事实哈希漂移、错误责任归属、额外指标、长输入、精确 quote 校验和 AI 进程树清理。

## 当前边界

- 模拟回答只保存在当前浏览器状态，不写入 CandidateProfile，也不自动成为事实。
- 系统不会从本机项目源码推断候选人贡献；代码审计结论必须经过用户确认并转成正式 Fact 后才能进入参考回答。
- 系统只准备面试材料，不替代真实面试，也不会触发投递或任何外部提交。
