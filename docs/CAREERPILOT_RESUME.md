# CareerPilot CN 中文简历与导出

Phase 2 在 CandidateProfile 之上建立 `ResumeVariant`。简历不是新的事实真源：
每次预览和导出都会重新运行 Fact 状态、Evidence 完整性、允许用途、敏感授权和
引用一致性审计，失败时不发布正式文件。

## 三类模板

| 模板 ID | 用途 | 默认页数 | 侧重点 |
|---|---|---:|---|
| `soe-one-page` | 央国企通用简历 | 1 | 教育、荣誉、校园与综合经历 |
| `tech-two-page` | 技术岗位简历 | 1–2 | 技能、项目与技术成果 |
| `application-detail` | 网申详细材料 | 不强制 | 按资料表顺序完整展示 |

模板定义位于 `templates/cn/*.json`。三者使用同一批通过正式发布门槛的 Facts，
只改变顺序与版式，不制造新陈述。`diff` 明确记录新增展示、删除、已接受改写和
排序变化；候选改写只有 `accepted: true` 才能进入正式版本。首期改写策略允许
完整分句重排及标点、空白规范化，但每个分句的词项必须保持不变，防止删除否定词、
限定词或数字后改变事实含义。服务端会重新计算 `diff`，不信任客户端提交的审计结果。

## 敏感信息

- 照片、政治面貌必须在当前 ResumeVariant 或当前导出操作中逐项授权。
- 授权不会写入全局设置，也不会影响下一次导出。
- 身份证号、家庭成员和完整住址永远禁止进入简历。
- 通用版和技术版默认最小披露。
- 邮箱、电话、城市等联系方式也必须作为通过门槛、具有 `email`、`phone` 或
  `city_region` 结构化 subtype 的 `basic` Fact；详细门牌地址仍会被拒绝；
  `candidate.email/phone/location` 不会绕过事实门槛直接输出。

## CLI

```powershell
node careerpilot.mjs resume-preview --template tech-two-page
node careerpilot.mjs resume-save --template soe-one-page --ready
node careerpilot.mjs resume-export --template soe-one-page --format md
node careerpilot.mjs resume-export --template tech-two-page --format docx
node careerpilot.mjs resume-export --template application-detail --format pdf
node careerpilot.mjs resume-list --approved
node careerpilot.mjs resume-tailor-preview --stdin
node careerpilot.mjs resume-tailor-export --stdin
```

可选的一次性授权参数为 `--authorize-photo` 和
`--authorize-political-status`。正式文件只允许写入 `output/careerpilot/`；每个
导出文件旁边都有 `.manifest.json`，包含模板、Fact IDs 和内容 SHA-256。

## Web 工作台

打开现有 Web 前端的 `/cv` 页面即可完成：

1. 导入旧简历为待确认 Facts；
2. 审阅状态、敏感等级、允许用途与 Evidence；
3. 为普通事实添加用户确认证言，或为高风险事实关联强证据；
4. 选择三类模板并查看实时预览和差异审计；
5. 对照片或政治面貌进行本次授权；
6. 下载 Markdown、DOCX 或 PDF。

`POST /api/resume-variants/preview` 只预览，不写事实库；
`POST /api/resume-variants/export` 必须提交刚审阅的 ResumeVariant。Variant 保存
源资料 SHA-256；预览后资料发生变化时导出会失败，避免“看到 A、导出 B”。接口
还会锁定已授权照片的 SHA-256，并拒绝证据目录外路径、符号链接、伪造图片与
超限文件。导出使用新文件名且禁止覆盖：manifest 先发布，正式简历作为最后一个
排他原子提交点，避免留下无法追踪的正式文件。

## 岗位简历与 30% 上限

岗位简历必须从状态为 `ready` 或 `exported` 的同模板主简历生成，并绑定岗位 ID、
主简历 SHA-256、CandidateProfile SHA-256 和全部引用的 Fact ID。改动比例按发生增删、
改写或相对顺序变化的唯一事实数除以主简历事实总数计算，同一事实只计一次。

- `0%` 到 `30%` 可以进入逐条确认与导出；
- 超过 `30%` 时核心层直接拒绝，Web 和 CLI 都没有越权参数；
- 改写必须引用已有 Fact ID，不能新增数字、经历、证书或改变否定含义；
- 预览后岗位、档案或主简历哈希变化时必须重新生成；
- 岗位分析本身不再自动生成 PDF，只有用户确认改写后才能导出。

Web 的 `/job-analysis` 页面在资格评估完成后提供岗位简历面板；原有 `/cv` 页面继续负责
主简历和通用模板。`POST /api/cn/resumes/tailor-preview` 只计算并保存待确认预览，
`POST /api/cn/resumes/tailor-export` 再次校验全部哈希、资格门槛和 30% 上限后才导出。

## 字体与格式

- HTML/PDF 从 `@fontsource/noto-sans-sc` 嵌入 OFL 授权的 Noto Sans SC，正文可复制。
- PDF 使用现有 Playwright 渲染器，并对央国企版、技术版执行严格页数限制。
- DOCX 使用结构化 OOXML 生成，正文可编辑；中文字体首选微软雅黑，
  LibreOffice 回退为 Noto Sans CJK SC。
- Markdown 与 HTML 含隐藏 Fact 标记；DOCX 含隐藏 Fact run；所有格式另有 manifest。

## 验证

```powershell
npm run careerpilot:resume-test
npm run careerpilot:export-qa
npm run careerpilot:web-e2e
cd web
npm test
npm run typecheck
npm run build
```

`careerpilot:export-qa` 只使用匿名样例，在 Git 忽略的
`output/careerpilot/qa-anonymous-workspace/` 生成 3 模板 × 3 格式的验收文件，
并通过 LibreOffice 转换 DOCX，自动检查页数预算、空白页、中文提取和可复制文本。
