# CareerPilot CN 首个正式版

本版把默认工作流从海外资深岗位求职切换为中国本科应届生校招，优先适配央企、地方国企、
银行和运营商。Phase 0–2 的事实中心与主简历工作室继续保留；Phase 3–4 的岗位资格分析、
岗位简历、网申材料和中国招聘阶段跟踪在本版交付。面试中心和 offer/入职管理仅预留数据边界。

## 默认工作流

1. 在 `/profile` 建立 CandidateProfile v2，为结构化字段引用已确认 Fact 和 Evidence。
2. 在 `/cv` 确认主简历并保存为 `ready` 基线。
3. 在 `/job-analysis` 粘贴公告、输入官网 URL，或上传 PDF/DOCX。
4. 人工核对岗位原文和资格规则后，由确定性核心计算 `eligible | ineligible | unknown`。
5. 资格门槛通过后生成 5 分制软匹配和 Markdown 岗位报告。
6. 选择主简历事实，逐条确认岗位改写；改动比例超过 30% 时禁止导出。
7. 在 `/application-materials` 准备字段和材料，并更新中国校招详细阶段。

海外 ATS 扫描、批处理、LinkedIn 联系、英文求职信、多语言市场模式等仍保留在高级功能区，
但不再是默认入口。本版不提供 BOSS 直聘、智联、前程无忧或猎聘爬虫。

## 数据与安全边界

- 用户事实只写入 `profile/`；岗位、匹配和申请侧车分别写入
  `data/careerpilot/jobs/`、`data/careerpilot/matches/` 和 `data/careerpilot/applications/`。
- `data/applications.md` 仍是兼容汇总；新增行走 TSV 合并器，状态更新走统一锁定脚本。
- 身份证号、家庭成员和完整住址不落盘、不写日志、不进入报告、API 或页面，只提示本人手填。
- AI 仅给出只读建议；资格结论、分数、改动比例和落盘都由确定性核心重新计算。
- 读取 CandidateProfile v1 不会改写文件；迁移只能显式执行，并生成 `.v1.bak` 备份。

## 核心命令

```powershell
node careerpilot.mjs migrate-profile
node careerpilot.mjs profile-structure --stdin
node careerpilot.mjs job-parse --source-text "..."
node careerpilot.mjs job-evaluate --stdin
node careerpilot.mjs resume-tailor-preview --stdin
node careerpilot.mjs resume-tailor-export --stdin
node careerpilot.mjs application-prepare --stdin
node careerpilot.mjs application-stage --stdin
```

## 阶段范围

| 阶段 | 状态 | 本版边界 |
|---|---|---|
| Phase 0 | 已完成 | 中国默认配置、数据保护和兼容边界 |
| Phase 1 | 已完成 | CandidateProfile 事实与证据中心 |
| Phase 2 | 已完成 | 主简历工作室与可审计导出 |
| Phase 3 | 本版交付 | 岗位导入、硬资格、软匹配和岗位报告 |
| Phase 4 | 本版交付 | 30% 岗位简历、网申材料和详细阶段 |
| Phase 5 | 仅预留 | 面试中心、offer 与入职管理 |

## 验收

```powershell
npm run careerpilot:test
node updater-migration-tests.mjs
node updater-coverage-tests.mjs
cd web
npm run typecheck
npm run build
npm test
```

浏览器验收至少覆盖：匿名建档、JD 导入、规则确认、资格结论、岗位报告、岗位简历预览、
用户确认导出、网申准备和阶段更新。任何外部申请提交、邮件发送或表单最终确认仍由用户本人完成。
