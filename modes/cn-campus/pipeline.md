# 中国校招主流程

1. 从官网 URL、粘贴文本、PDF 或 DOCX 建立原文快照；不使用图片 OCR。
   - 官网 URL 在 `config/profile.yml` 显式设置 `scan.extractor: cli` 时，可以先运行只读的
     `node browser-extract.mjs <url> --mode jd`，再把返回的正文交给 `job-parse`；工具缺失或失败时
     必须静默回退到官网 URL 解析。该优化不能用于填写或提交网申表单。
2. 用户确认岗位单位、名称和资格规则。
3. 确定性核心计算 `eligible | ineligible | unknown`。
4. 资格允许后生成六维软匹配和人类可读报告。
5. 基于已确认主简历生成岗位定制预览；事实级改动比例超过 30% 时阻断。
6. 建立网申字段、材料清单和详细阶段侧车；通过 `set-status.mjs` 同步兼容 tracker 状态。
7. 所有外部提交由用户本人确认。
