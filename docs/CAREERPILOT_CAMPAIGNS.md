# CareerPilot CN V3.1 可信多岗位 Campaign

V3.1 把同企业多个岗位组织为一个可失效、可解释、可审计的 `Campaign`，Web 与 CLI 共享
`lib/careerpilot/` 中的确定性核心。正式流程为：

`Fact/Evidence → 多岗位导入 → 逐岗规则确认 → 稳定排名 → 人工选岗 → Fact Diff → 预览确认 → manifest v2 导出 → 申请包 → 外部提交前停止`

## 数据与失效模型

- 私有 Campaign 写入 `data/careerpilot/campaigns/`，包含企业、批次、截止日期、岗位哈希引用、
  `max_applications`、互斥约束、排名、选择和审计事件。
- 每个来源仍必须生成独立 `JobPosting`，再走 `job-confirm` 与 `job-evaluate`；Campaign 不能跳过确认。
- CandidateProfile、岗位快照、MatchReport ID/正文 SHA-256 或约束变化后，既有排名与选岗立即失效，必须重新计算。
- 只有所有纳入岗位均已确认、在招且存在当前 MatchReport 时，Campaign 才能排名和选岗。
- 私有岗位、Campaign、匹配报告、申请记录和正式输出均属于 User Layer；CI 只使用匿名夹具。

稳定排名顺序固定为：硬资格、建议级别、内部精确匹配分、可发布 Fact 覆盖率、缺口数、岗位 ID。
界面只显示一位小数，同时展示硬门槛原文、Fact、缺口与未知项，避免把单一分数当成决定。

## CLI

```powershell
Get-Content campaign.json -Raw | node careerpilot.mjs campaign-create --stdin
Get-Content sources.json -Raw | node careerpilot.mjs campaign-import --campaign CAMPAIGN_ID --stdin
Get-Content constraints.json -Raw | node careerpilot.mjs campaign-constraints --campaign CAMPAIGN_ID --stdin
node careerpilot.mjs campaign-rank --campaign CAMPAIGN_ID
Get-Content selection.json -Raw | node careerpilot.mjs campaign-select --campaign CAMPAIGN_ID --job JOB_ID --stdin
node careerpilot.mjs campaign-show CAMPAIGN_ID
node careerpilot.mjs campaign-list
node careerpilot.mjs capabilities --json
node careerpilot.mjs cleanup --dry-run --older-than 7
node careerpilot.mjs cleanup --apply --older-than 7
```

`campaign-import` 接收 URL、文本、PDF/DOCX 文件、已存在 JobPosting 和 Codex 浏览器抓取记录
`{url,title,captured_text,captured_at,provider}`。批量导入按项返回成功、重复和失败；重复来源 URL、
最终跳转 URL、岗位 ID 或内容 SHA-256 不会重复加入。Web 不能直接读取本机标签页，调用方负责把
浏览器抓取记录传给 CLI。

## Web 与 API

- `/campaigns`：创建、列出和恢复 Campaign。
- `/campaigns/[id]`：批量 URL、文本块和文件导入，逐岗确认/排除，约束确认、横向排名、选岗、
  定制导出和申请准备。
- `/job-analysis`：保留单岗位入口，并可把已确认岗位加入 Campaign。
- API：`POST/GET /api/cn/campaigns`、`GET /api/cn/campaigns/:id`，以及
  `import`、`constraints`、`rank`、`select`、`exclude` 子路由。

单个来源失败不会回滚其他成功项。Web 只展示核心返回的状态与原因，不在前端重算资格、排名、
30% 比例、哈希或 manifest 信任。

## 正式导出与申请边界

Campaign 正式导出只接受当前已确认选岗和有效 `TailoringPreview`。所有实质改写必须逐条确认，
唯一变更 Fact 比例不得超过 30%，岗位标题必须一致，头像必须显式授权且哈希匹配。DOCX/PDF
完成后自动检查页数、可选文本、目标标题、全部 Fact 语义、截断、重叠、异常留白、头像存在/比例/版心和 LibreOffice 渲染，并在相邻
`.manifest.json` 中记录结果。

申请包必须绑定一个 QA 已验证的最终 DOCX/PDF manifest，记录官网 URL、材料、Fact 来源、
缺失项、人工敏感字段和提交前检查表。`submitted` 状态额外要求
`external_submission_confirmed=true`；系统没有点击提交、发送邮件或处理验证码的能力。

## 运行能力与清理

`doctor.mjs --json` 和 `capabilities` 分别报告 Playwright CLI、项目 MCP 配置与调用方声明的
Codex/Chrome/Edge 能力。缺少项目 MCP 配置不等于浏览器不可用；固定降级顺序为 Codex 标签页抓取、
批量 URL、文本/文件。

`cleanup` 只遍历已登记的 `output/careerpilot/qa*`、失败运行和 `tmp/careerpilot`、`tmp/pdfs`
子项；不会删除 `final`、manifest、Evidence、Campaign 或申请记录。先运行 `--dry-run` 审阅目标。

## 发布门禁

```powershell
npm run careerpilot:test
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
npm run careerpilot:web-e2e
npm run careerpilot:export-qa
node test-all.mjs
```

匿名 E2E 覆盖同企业多岗位限投、稳定排名、选岗、v2 manifest、申请绑定和“外部提交前停止”；
私有企业回放不得进入 git。
