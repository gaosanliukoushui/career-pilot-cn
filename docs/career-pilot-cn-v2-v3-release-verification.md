# CareerPilot CN V2/V3 正式版验证记录

验证日期：2026-07-29
分支：`codex/v2-v3-formal-release`
依据：`docs/career-pilot-cn-v2-v3-gap-audit.md`

## 验证结论

V0–V3 中国校招默认主链已形成可运行闭环。岗位确认、AI 只读边界、30% 岗位简历、网申材料、事务化阶段同步和个人证据中心均有自动化或真实浏览器证据。V4/V5 继续保持预留，不在本次交付范围内。

## 自动化证据

| 命令 | 结果 | 覆盖 |
|---|---|---|
| `npm run careerpilot:test` | 92 项通过 | CandidateProfile 23、简历 24、岗位/岗位简历/申请 40、边界策略 5 |
| `npm --prefix web test` | 28/28 通过 | API 主链、受限字段、上传证据、CLI 策略和 Web 辅助逻辑 |
| `npm --prefix web run typecheck` | 通过 | TypeScript 严格类型检查 |
| `npm --prefix web run build` | 通过 | Next.js 生产构建与全部路由收集 |
| `npm run careerpilot:web-e2e` | 通过 | 匿名建档至阶段同步的真实 Chromium 完整链 |
| `npm run careerpilot:export-qa` | 通过 | 3 个模板 × Markdown/DOCX/PDF 共 9 个导出；LibreOffice 3/3 DOCX 渲染通过 |
| `node test-all.mjs` | 2084 项通过、0 失败、3 条已审阅警告 | 全仓语法、脚本、Dashboard、数据契约、状态写入和提供方回归 |

## 关键风险用例

- 央企、地方国企、银行、运营商分别验证资格通过、失败和信息不足。
- 真实文本 PDF、真实 DOCX、10 MB 边界、越界目录、文件符号链接、异常 ZIP/DOCX、超大解压内容和伪造 PDF 均有确定性结果。
- 岗位、CandidateProfile 或主简历任一变化都会让既有岗位简历预览过期。
- 直接 `job-evaluate`、旧 `/api/run` 和未授权 Fact 无法绕过确认与白名单。
- 身份证值写入尝试在 API 被拒绝，并扫描 API 响应、服务日志、页面 HTML 和浏览器页面文本。
- 同一申请的并发阶段更新在共享锁中串行执行；侧车与汇总冲突时拒绝覆盖。
- 未确认主简历从 Core 或 CLI 导出时均被拒绝；岗位简历候选改写由岗位原文相关性生成，且只允许重排原 Fact 分句。
- 真实浏览器链会生成 1 条候选改写、逐条接受并验证 25% 门槛，同时验证岗位特有表单字段和材料定义进入申请侧车。

全仓 3 条警告均为既有、非阻断信号：无用户数据时 `cv-sync-check` 预期失败、测试夹具中的公开作者名命中个人信息启发式扫描，以及 Windows 未授予符号链接测试权限；没有新增失败。

## 可回退边界

本版只修改系统层代码、Schema、测试和正式版文档；没有写入用户事实，也没有执行任何外部申请、邮件发送或官网提交。回退时可按本次独立提交整体撤销，不需要迁移或删除用户层数据。
