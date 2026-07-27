# CareerPilot CN 候选人事实与证据中心

Phase 1 将 `profile/candidate.yml` 作为本地候选人聚合资料。整个 `profile/`
目录属于用户层并被 Git 忽略；Schema、匿名样例、领域策略和 Web API 属于
系统层，可以安全提交。

## 正式发布门槛

- Fact 状态必须为 `confirmed`。
- Fact 必须允许用于当前用途，并至少关联一条存在的 Evidence。
- 教育、证书、奖项、实习和量化成果等高风险 Fact 必须关联可核验的强证据：
  本地文件需要 SHA-256，远程材料需要 HTTPS 链接。
- `unconfirmed`、`rejected`、`conflicted` 或不满足证据门槛的 Fact 不会进入
  兼容 `cv.md`。

## CLI

```powershell
node careerpilot.mjs validate
node careerpilot.mjs import-cv
node careerpilot.mjs show
node careerpilot.mjs set-status <fact-id> confirmed
node careerpilot.mjs attach-evidence <fact-id> --id <evidence-id> --kind document --ref profile/evidence/file.pdf --strength strong
node careerpilot.mjs project-cv
node careerpilot.mjs audit
```

所有命令输出 JSON。写入在 Schema 校验后采用同目录临时文件原子替换，并为
已有文件保留 `.bak` 恢复副本。

## Web API

| 路径 | 用途 |
|---|---|
| `GET /api/candidate-profile` | 读取 CandidateProfile |
| `POST /api/candidate-profile/import-cv` | 将旧简历导入为待确认 Facts |
| `POST /api/candidate-profile/fact-status` | 更新 Fact 状态 |
| `POST /api/candidate-profile/evidence` | 关联 Evidence |
| `POST /api/candidate-profile/project-cv` | 生成兼容 `cv.md` 与 manifest |
| `GET /api/candidate-profile/audit` | 执行结构、证据和投影审计 |
| `GET /api/cv` | 获取事实库生成的只读预览 |

`POST /api/cv` 固定返回 `409 CV_READ_ONLY`，避免绕过事实真源直接覆盖简历。
