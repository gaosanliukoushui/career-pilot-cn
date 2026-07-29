# CareerPilot CN 二次开发总纲

> 文档性质：基于对话 `019fa20a-29c4-7543-97da-666c828a2229` 整理的二次开发基线  
> 编制日期：2026-07-27  
> 上游底座：[santifer/career-ops](https://github.com/santifer/career-ops)  
> 推荐项目名：`CareerPilot CN`（暂定）

## 1. 一句话定位

CareerPilot CN 是一个面向中国本科应届生、重点适配央企、地方国企、银行、运营商等校招场景的本地 AI 求职工作台。

它以候选人的真实材料和可核验证据为基础，完成岗位资格检查、岗位匹配、适度定制简历、网申字段准备、投递跟踪和面试准备；AI 负责分析和起草，用户始终负责敏感信息授权与最终提交。

## 2. 二次开发结论

### 2.1 为什么选 career-ops

选择 `career-ops`，不选择 `ai-job-search` 作为主底座，主要因为：

- `career-ops` 已具备岗位评价、定制简历、投递状态、批处理、仪表盘和面试材料等完整工作流。
- 上游已提供 Codex 接入说明；在 Codex 中即使没有斜杠命令，也可以通过自然语言直接运行对应 mode。
- 简历主要使用 HTML 与 Playwright 生成 PDF，相比以 LaTeX 为主的方案，更容易在 Windows 上处理中文字体和模板。
- 上游本来就强调 human-in-the-loop，不会自动提交申请，这与国内招聘平台的风控和敏感字段边界一致。

`ai-job-search` 可作为“材料质量审查”的参考来源，例如借鉴双角色审查、页数检查、PDF 文本层检查，但不作为代码主干。

### 2.2 这不是简单汉化

项目不能只翻译界面和提示词。真正有价值的新增能力是：

1. 央国企校招资格规则引擎。
2. 候选人事实库与证据追踪。
3. 20%–30% 岗位定制与差异审计。
4. 中国招聘网申字段生成。
5. 中文 DOCX/PDF 简历输出。
6. 国内校招投递状态机。
7. 面向中国招聘场景的解释性匹配报告。

## 3. 产品原则与安全边界

### 3.1 必须遵守

- 真实优先：教育、成绩、排名、证书、项目、时间和成果必须来自候选人事实库。
- 证据约束：重要陈述必须能关联到证书、成绩单、项目仓库、文档或用户确认记录。
- 适度定制：保持 70%–80% 事实稳定，只调整 20%–30% 的排序、重点和措辞。
- 可解释：所有资格结论和匹配分都要给出规则、证据和缺口。
- 人工确认：简历导出、敏感字段使用、正式网申和投递必须由用户确认。
- 本地优先：个人材料默认保存在本地，不把敏感资料默认发送给第三方服务。

### 3.2 明确禁止

- 编造实习、项目、技术栈、奖项、成绩或量化结果。
- 自动决定是否服从调剂、工作地点、志愿顺序和期望薪资。
- 自动填写或传播身份证号、家庭成员、住址等敏感字段。
- 第一版接入无人值守爬虫、验证码绕过或自动海投。
- 把开源底座包装成完全从零原创。

## 4. 版本路线图

| 版本 | 目标 | 主要交付物 | 发布定位 |
|---|---|---|---|
| V0 | 建立真实资料底座 | 候选人事实库、证据索引、字段校验 | 后续所有功能的基础 |
| V1 | 生成央国企风格简历 | 一页版、技术版、网申详细版；Markdown/DOCX/PDF | 可用的基础简历工具 |
| V2 | 针对岗位适度定制 | JD 解析、资格检查、匹配报告、差异审计 | 可实际辅助投递 |
| V3 | 管理网申与投递 | 网申字段、材料清单、状态机、截止日期 | 首个正式可发布版本 |
| V4 | 辅助笔试与面试 | 企业研究、项目问答、行为题、复盘 | 完整 AI Agent 工作流 |
| V5 | 浏览器辅助 | JD 提取、普通字段辅助填写、提交前核对 | 高维护成本的增强版 |

首期范围锁定为 **V0–V3**。V4 在首期稳定后开发；V5 只做浏览器辅助，不做无人值守自动提交。

## 5. 首个正式版本范围（V0–V3）

### 5.1 V0：候选人事实与证据中心

建议目录：

```text
profile/
├── basic.yaml
├── education.yaml
├── skills.yaml
├── certificates.yaml
├── awards.yaml
├── campus.yaml
├── internships/
├── projects/
└── evidence/
```

每条事实至少包含：

```yaml
id: project.smart_education.rag
type: project_fact
statement: 在智慧教育平台中实现课程知识库检索问答流程
source: projects/smart-education.yaml
evidence:
  - kind: repository
    ref: local-or-remote-repo-reference
confidence: confirmed
allowed_uses:
  - resume
  - application_form
  - interview
sensitive: false
```

验收重点：AI 无法把 `unconfirmed` 或无证据的陈述直接写进正式简历。

### 5.2 V1：中文简历生成

首期提供三种模板：

- 央国企通用一页版：教育、技能证书、项目/实习、奖项与校园经历、自我评价。
- 技术岗位一至两页版：适合 Java 后端、信息科技、数字化和 AI 应用岗位。
- 网申详细版：信息完整，便于复制到企业招聘系统。

输出格式：

- Markdown：单一事实源与版本追踪。
- DOCX：便于人工修改。
- PDF：正式投递与排版验收。

模板要求：

- 默认中文字体，Windows 环境可稳定渲染。
- 不堆砌架构术语；每个项目控制在背景、职责、关键动作、结果四类信息内。
- PDF 生成后检查页数、文本层、字体缺失、断行、重叠和留白。

### 5.3 V2：岗位分析与定制简历

输入支持：岗位文本、招聘公告文本、用户手动提供的岗位链接。

处理流程：

```text
JD 输入
  -> 结构化字段抽取
  -> 硬条件检查
  -> 能力与经历证据匹配
  -> 投递价值评分
  -> 选择简历模板
  -> 生成定制草稿
  -> 事实校验与差异审计
  -> 用户确认
  -> 导出
```

硬条件至少包括：

- 学历、专业、毕业时间、应届身份。
- 英语等级、资格证书、政治面貌（仅岗位明确要求时）。
- 工作地点、基层期限、出差或轮岗要求。

匹配报告至少输出：

- `eligible`：是否满足明确硬条件。
- `fit_score`：综合匹配分。
- `evidence`：每项匹配所依据的候选人事实。
- `gaps`：缺失条件和不可证明能力。
- `recommendation`：投递、谨慎投递或不建议投递。
- `resume_variant`：推荐模板和定制方向。

差异审计必须标出：新增、删除、改写、排序变化，以及每一处变化的事实来源。不得只给“相似度百分比”。

### 5.4 V3：网申与投递管理

网申字段覆盖：

- 个人信息、教育经历、主修课程、成绩和排名。
- 实习、项目、证书、奖项、学生工作。
- 求职动机、自我评价、工作地点、是否服从调剂。
- 材料清单和证明文件状态。

国内校招状态建议统一为：

```text
发现岗位 -> 待评估 -> 待投递 -> 已网申 -> 资格审查
-> 笔试通知 -> 笔试完成 -> 一面 -> 二面/专业面 -> HR 面
-> 体检 -> 考察/政审 -> 拟录用 -> 签约
```

终止状态：`不符合资格`、`拒绝`、`主动放弃`、`岗位关闭`、`已过期`。

## 6. 建议领域模型

| 实体 | 职责 | 关键字段 |
|---|---|---|
| CandidateProfile | 候选人基本资料 | education、skills、preferences |
| Fact | 可复用的真实陈述 | statement、confidence、allowedUses |
| Evidence | 事实证明材料 | kind、ref、verifiedAt |
| JobPosting | 岗位快照 | employer、jobCode、deadline、rawText |
| EligibilityRule | 硬条件规则 | field、operator、expected、source |
| MatchReport | 匹配结论 | eligible、score、evidence、gaps |
| ResumeVariant | 某岗位简历版本 | template、sourceFacts、diff、status |
| ApplicationAnswer | 网申字段答案 | field、answer、limit、sensitivity |
| Application | 一次投递 | jobId、status、events、materials |
| InterviewSession | 面试与复盘 | questions、answers、lessons |

关系约束：`ResumeVariant` 中的每条陈述必须能追溯到至少一个 `Fact`；受保护的 `ApplicationAnswer` 必须经过显式授权才能导出。

## 7. 建议代码边界

在实际 fork 后，应先对照上游 `ARCHITECTURE.md` 和 `DATA_CONTRACT.md` 再确定真实文件路径；以下是目标边界，不代表上游当前已有同名目录。

```text
domain/
├── profile/
├── evidence/
├── job/
├── matching/
├── resume/
└── application/

workflows/
├── ingest-profile/
├── evaluate-job/
├── tailor-resume/
├── prepare-application/
└── track-application/

templates/cn/
├── soe-one-page/
├── tech-two-page/
└── application-detail/

config/cn/
├── eligibility-rules/
├── employer-types.yml
├── status-map.yml
└── skill-synonyms.yml
```

对上游已有模块优先做适配层，不要一开始重写扫描器、仪表盘和 PDF 管线。

## 8. 实施顺序

### Phase 0：建立独立仓库与基线

- 在 `smart_education` 之外创建独立项目目录，建议 `E:\my_projects\career-pilot-cn`。
- fork 或 clone `career-ops`，记录上游 commit 和版本。
- 保留 MIT LICENSE、上游版权和修改说明；使用独立产品名。
- 在未修改前运行安装、doctor、测试和示例 PDF，保存基线结果。
- 阅读上游 `AGENTS.md`、`ARCHITECTURE.md`、`DATA_CONTRACT.md`、`docs/CODEX.md`。

完成定义：干净安装可复现，基线测试通过，中文开发分支建立，未混入个人敏感资料。

### Phase 1：V0 数据模型

- 定义 profile、fact、evidence schema。
- 建立 JSON Schema 或等价校验器。
- 添加匿名示例数据和隐私扫描。
- 实现“未经确认事实不得正式导出”的策略测试。

### Phase 2：V1 中文简历管线

- 创建三类模板及中文字体策略。
- 保留 Markdown 单一事实源。
- 打通 HTML/PDF，并新增 DOCX 导出。
- 建立渲染快照、页数、文本层与字段完整性测试。

### Phase 3：V2 资格与匹配

- 实现 JD 结构化解析。
- 先做确定性硬条件规则，再做 LLM 语义匹配。
- 输出带证据的匹配报告。
- 实现简历差异审计与 20%–30% 定制护栏。

### Phase 4：V3 网申与投递

- 建立网申字段字典、字数限制和敏感等级。
- 建立材料清单、截止日期和投递状态机。
- 接入现有 tracker/dashboard；不做自动提交。
- 完成从 JD 到投递记录的一条端到端演示。

### Phase 5：V4/V5 增强

- V4：企业研究、面试题、项目深挖、STAR 故事和面试复盘。
- V5：已登录浏览器中的 JD 提取和普通字段辅助填写；最终发送或提交前必须停下等待用户确认。

## 9. 首期验收场景

准备一套完全匿名化的验收资料，并至少覆盖：

1. 合格岗位：学历、专业和毕业时间全部满足，能生成证据完整的定制简历。
2. 硬条件不合格：专业或英语不满足，系统明确拦截而不是提高软匹配分掩盖问题。
3. 信息不确定：项目成果没有证据，系统将其标记为待确认且不进入正式 PDF。
4. 多岗位定制：同一份事实库分别生成 Java、数字化和 AI 应用版本，事实一致、侧重点不同。
5. 敏感字段：未授权时不导出家庭成员、身份证等内容。
6. 过期岗位：超过截止日期后不能进入待投递状态。
7. 中文渲染：DOCX/PDF 无乱码、字体缺失、遮挡、截断，PDF 文本可复制。
8. 人工确认：系统不能执行最后的提交动作。

## 10. 测试策略

- Schema 测试：候选人、岗位、匹配报告、投递记录。
- 规则测试：学历、专业、应届身份、英语、截止日期等边界条件。
- 事实一致性测试：简历陈述必须关联事实和证据。
- Golden file 测试：固定 JD 与固定资料产生稳定的结构化结果。
- 差异测试：不同岗位版本不得改写不可变事实。
- 渲染测试：DOCX/PDF 页数、文本层、字体、溢出和视觉快照。
- E2E：录入资料 -> 解析 JD -> 评估 -> 生成简历 -> 准备网申 -> 更新状态。
- 隐私测试：日志、测试快照、Git 追踪文件中不得出现真实敏感信息。

## 11. 开发前需要准备的材料

- 当前个人简历，可不完善，但所有内容必须真实。
- 3–5 份已匿名化、已获授权使用的央国企成功简历，仅用于提炼结构和表达规律。
- 10–20 条真实目标 JD，覆盖优先投递的企业类型和岗位类型。
- 成绩排名、四六级、证书、竞赛、学生工作等可核验资料。
- 目标优先级：央企、地方国企、银行、运营商，以及 Java、信息科技、数字化、AI 应用等方向。
- 明确不可接受条件：城市、基层年限、出差、轮岗、薪资、工作强度等。

第三方简历必须先删除姓名、电话、身份证号、住址、照片等个人信息。

## 12. 不应在首期做的事情

- 复杂 RAG：V0 使用结构化事实库和全文检索即可；只有材料规模和检索评测证明有需要时再引入向量检索。
- 多 Agent 炫技：先保证单流程可测、可解释、可回滚，再拆代理角色。
- 全平台爬虫：BOSS、智联、前程无忧、猎聘和企业独立网申页面变化快，首期采用复制 JD 或用户提供页面。
- 自动海投：不仅有风控风险，也违背高质量筛选和人工确认原则。
- 一次性重写上游：先复用上游稳定能力，通过中国规则、模板和工作流适配形成差异化。

## 13. 开源与项目陈述

上游采用 MIT License，可以使用、修改和分发，但必须保留版权与许可声明。上游另有商标政策，代码许可不等于获得 `career-ops` 名称和品牌授权；二次开发项目应使用独立名称，并明确写“基于 career-ops 二次开发”。

简历中的诚实表述建议：

> 基于开源 career-ops 二次开发面向央国企校招的 AI 求职工作台，设计候选人事实与证据模型、岗位资格规则引擎、可解释匹配报告、中文简历生成及投递状态管理流程。

不要写成“从零独立开发完整求职平台”。

## 14. 建议后续使用的技能（Suggested Skills）

- `ask-matt`：进入新仓库后先路由合适的工程流程。
- `research`：调研央国企公开招聘字段、规则和合规边界，并把一手来源落成仓库文档。
- `domain-modeling`：冻结 Fact、Evidence、JobPosting、Application 等领域词汇和不变量。
- `codebase-design`：对照上游真实结构确定适配 seam，避免大面积重写。
- `to-prd` / `to-issues`：把本总纲细化为 PRD 和可独立领取的垂直切片。
- `tdd`：优先实现资格规则、事实追踪、状态机和差异护栏测试。
- `implement`：在 PRD、边界和验收条件确认后实施。
- `documents` / `pdf`：实现并验证 DOCX/PDF 中文简历输出。
- `playwright`：验证 PDF 渲染，后期用于用户确认前的浏览器辅助。

## 15. 参考资料

- [career-ops README](https://github.com/santifer/career-ops)
- [career-ops Codex 使用说明](https://github.com/santifer/career-ops/blob/main/docs/CODEX.md)
- [career-ops 自动填表说明](https://github.com/santifer/career-ops/blob/main/docs/APPLY_AUTOFILL.md)
- [career-ops 架构说明](https://github.com/santifer/career-ops/blob/main/ARCHITECTURE.md)
- [career-ops 数据契约](https://github.com/santifer/career-ops/blob/main/DATA_CONTRACT.md)
- [career-ops MIT License](https://github.com/santifer/career-ops/blob/main/LICENSE)
- [career-ops 商标政策](https://github.com/santifer/career-ops/blob/main/TRADEMARK.md)
- [ai-job-search README](https://github.com/MadsLorentzen/ai-job-search)

## 16. 下一步执行建议

本文件只定义二次开发方向，不代表功能已经实现。下一次开发会话建议只完成 Phase 0：在独立目录取得 `career-ops` 源码、核对真实架构、跑通未修改基线，并据此把 V0–V3 拆成仓库内 PRD 与 issues；在基线通过前不要开始大规模改代码。
