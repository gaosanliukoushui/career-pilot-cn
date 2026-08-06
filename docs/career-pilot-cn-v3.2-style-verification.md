# CareerPilot CN V3.2 可信简历风格中心验证记录

日期：2026-08-06

固定点：`b3bb855`
结论：通过

## 实现范围

- 五套可选择主题：央国企蓝色正式、央国企深蓝紧凑、央国企红色学术、央国企科研综合、技术极简。
- 头像、信息密度、页数预算、内容强调为相互独立的呈现轴。
- Web 提供同内容真实缩略图、可解释推荐、两两比较、实时预览和用户层保存。
- CLI/Web API 提供样式目录、匿名预览与保存；旧版 v1 配置只读迁移，不写回用户文件。
- HTML/PDF 与 DOCX 共享标准化内容模型、主题定义、区块顺序和 Fact 追踪边界。
- 央国企编辑策略结构化约束实习、项目、校园和技能写法，不从参考图引入候选人事实。
- ResumeVariant 绑定完整 ResumeStyle SHA-256；确认后改主题、密度、页数、区块顺序或头像位置都会使旧预览失效。
- 普通 DOCX/PDF 与 Campaign 最终导出都在原子发布前执行渲染 QA；稀疏或损坏的正式文档会被拒绝。

## 私有参考图

- 12 张原始附件保存在 Git 忽略的 `profile/style-references/originals/`。
- 私有 manifest 记录原文件名、SHA-256、MIME、字节数、尺寸、用途和风格归类。
- 逐文件重新计算 SHA-256，12/12 与 manifest 一致；`git check-ignore` 确认目录不会进入版本库。
- 参考图被明确限制为版式与编辑结构来源，禁止作为候选人事实、身份、头像或作者关系来源。

## 渲染与视觉 QA

- 使用共享匿名夹具 `examples/cn-profile/resume-style-preview.yml` 中 18 条证据完备的 Fact 生成 5 主题 × Markdown/DOCX/PDF。
- 五份 PDF 均为 1 页，文本层可复制，Fact 标记完整，无截断、重叠或异常留白。
- 五份 DOCX 经 `E:\liberoffice\program\soffice.com` 转换后逐页检查；均为结构化可编辑文档，颜色与区块顺序和对应主题一致。
- Playwright 在 `/cv` 验证主题选择、Fact 分布推荐、头像开关、内容强调、编辑规则展开和并排比较；相关 API 全部返回 200，浏览器控制台 0 error。
- 浏览器验收未点击保存，没有替用户更改当前私人风格选择。
- 最终保留的匿名验收产物位于 `output/careerpilot/style-preview-qa-v3.2-final/`；10 份 DOCX/PDF manifest 的渲染状态和文本层均为 `verified`。

## 自动化门禁

| 门禁 | 结果 |
|---|---|
| `npm run careerpilot:test` | 通过 |
| `npm run careerpilot:style-qa` | 通过，5 主题 × 3 格式 |
| `npm --prefix web test` | 29/29 通过 |
| `npm --prefix web run typecheck` | 通过 |
| `npm --prefix web run build` | 通过 |
| `npm run careerpilot:web-e2e` | 通过 |
| `node test-all.mjs` | 2088 通过、0 失败、3 个既有警告 |

生产构建保留一个仓库既有的 Turbopack 动态文件追踪警告；未造成编译、类型或运行失败。

## 安全边界

- 主题和参考图不能绕过 CandidateProfile Fact、Evidence、敏感字段授权、30% 定制上限或 manifest。
- 头像开关只声明版式位置；正式包含头像时仍需当前 ResumeVariant 授权和照片哈希匹配。
- 系统仅生成、预览和导出材料，不执行外部申请提交。
