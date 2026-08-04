# CareerPilot CN V3.1 可信多岗位投递闭环验证记录

验证日期：2026-08-04
分支：`codex/v2-v3-formal-release`
范围：Campaign 核心、manifest v2、简历样式/视觉 QA、Web/CLI 联调、申请提交边界、运行诊断与清理

## 验证结论

V3.1 已形成 Web 与 CLI 共用确定性核心的闭环：多来源导入、逐岗确认、稳定可解释排名、限投选岗、
30% 内 Fact Diff、用户确认、DOCX/PDF 正式导出、ResumeArtifactManifest v2 和申请包不可变绑定。
所有自动化与真实浏览器门禁通过；系统没有外部提交、邮件发送、验证码处理、浏览器扩展或常驻桥接。

## 自动化证据

| 命令 | 结果 | 覆盖 |
|---|---|---|
| `npm run careerpilot:test` | 111 项通过 | Profile 23、Resume 25、Job/Campaign/Tailoring/Application/Runtime 58、边界 5 |
| `npm --prefix web test` | 28/28 通过 | Campaign API、批量导入、v2 manifest、申请绑定、受限字段和提交前停止 |
| `npm --prefix web run typecheck` | 通过 | TypeScript 严格类型检查 |
| `npm --prefix web run build` | 通过 | Next.js 生产构建，收集 `/campaigns` 与全部新增 API 路由 |
| `npm run careerpilot:web-e2e` | 通过 | 真实 Chromium 主链；`submitted` 未确认时按钮禁用，验收停在 `pending_apply` |
| `npm run careerpilot:export-qa` | 通过 | 3 模板 × Markdown/DOCX/PDF 共 9 个匿名导出，LibreOffice 与文本层 QA 通过 |
| `node test-all.mjs` | 2088 通过、0 失败、3 条已审阅警告 | 全仓语法、脚本、Dashboard、数据契约、PII、路径和 provider 回归 |

Next.js 构建另有 1 条既有 Turbopack 动态路径追踪警告，指向 `next.config.mjs → career-ops.ts → whats-new`，
未影响类型检查、路由收集或生产构建。全仓 3 条警告仍为预期无用户数据时的 `cv-sync-check`、
公开上游作者名触发启发式扫描，以及 Windows 未授予测试进程创建符号链接权限；本版本没有新增失败。

## 关键门禁证据

- Campaign 对未确认、关闭、过期、缺 MatchReport 和哈希漂移岗位拒绝排名或选岗。
- 排名以资格、建议、精确分、Fact 覆盖、缺口和岗位 ID 固定排序；完全相同结果稳定。
- URL、最终跳转 URL、岗位 ID 和内容 SHA-256 去重；混合批次保留成功项并报告单项失败。
- CandidateProfile、JobPosting、MatchReport 正文哈希、约束或选岗变化会使后续预览/导出失效；重新选择同一岗位不会让旧最终产物恢复可信。
- 正式导出拒绝未确认 Fact、超过 30%、未授权/变更头像、标题漂移、旧 manifest 和 QA 未验证文件。
- DOCX 使用受约束字号/页边距及无边框双列头像头部；LibreOffice 转换后重新验证页数、文本层、Fact、截断、重叠、异常留白、头像存在/比例/版心边界。
- `submitted` 必须显式携带 `external_submission_confirmed`；匿名 API/E2E 都验证未确认时状态不前进。
- `doctor` 不再把“无项目 MCP 配置”误报为“浏览器不可用”，并给出固定导入降级顺序。
- `cleanup` 仅删除已登记 QA/失败/临时子项，测试证明不会触及 `final`、Evidence、Campaign 或申请。

## 私有回放

私有用户层完成了一个同企业 14 岗、最多投 1 岗的完整回放：14 个官网快照与 MatchReport 均重新确认，
排名首选通过硬资格；证据 PDF 不含实习陈述，因此没有创建或猜测实习 Fact。头像以授权 Evidence 哈希绑定，
岗位版只移除 7 条弱相关 Fact、无改写，定制比例为 25%。最终 DOCX/PDF 均为 1 页，manifest v2 的
页数、文本层、语义、头像和哈希检查通过；申请包停在 `Evaluated`，未发生外部提交。

私有 Campaign、岗位快照、MatchReport、Evidence、头像、申请记录和最终文件均位于 git 忽略的 User Layer；
仓库只保留匿名测试。旧报告和旧成品继续作为 legacy 参考，两个临时个人简历构建脚本已删除。

## 兼容与回退

- `/job-analysis`、既有单岗位 API/CLI 和旧 manifest 读取保持兼容；旧 manifest 不能授权新的 Campaign 最终产物。
- 没有执行 career-ops 上游更新，也没有引入浏览器扩展、本地桥接或无人值守投递。
- 系统层变更可按本次提交整体回退；User Layer 的 Campaign、Evidence、manifest 和申请记录不由更新器删除。
