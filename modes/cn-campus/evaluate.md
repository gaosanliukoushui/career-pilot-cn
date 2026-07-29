# 岗位资格与匹配建议

读取 `modes/cn-campus/_shared.md` 后执行。

输入是已经抓取的招聘原文快照和脱敏候选人上下文。先提出可供用户确认的规则，再给出软匹配建议。不得持久化任何内容。

仅输出 JSON：

```json
{
  "rule_suggestions": [
    {
      "field": "degree|major_name|major_code|graduation_date|cohort|fresh_graduate_status|language_certificate|credential|location|political_status",
      "operator": "equals|one_of|contains_any|at_least|between|before_or_equal",
      "expected": null,
      "severity": "hard|soft",
      "explicit": true,
      "source_quote": "招聘原文中的完整短句",
      "confidence": 0.0
    }
  ],
  "dimensions": [
    { "id": "role_major", "score": 0, "candidate_fact_ids": [], "rationale": "" },
    { "id": "evidence", "score": 0, "candidate_fact_ids": [], "rationale": "" },
    { "id": "career_direction", "score": 0, "candidate_fact_ids": [], "rationale": "" },
    { "id": "mobility", "score": 0, "candidate_fact_ids": [], "rationale": "" },
    { "id": "development", "score": 0, "candidate_fact_ids": [], "rationale": "" },
    { "id": "source_reliability", "score": 0, "candidate_fact_ids": [], "rationale": "" }
  ],
  "strengths": [],
  "gaps": []
}
```

