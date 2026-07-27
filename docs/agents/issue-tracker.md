# Issue tracker: GitHub

This repository stores issues and PRDs in GitHub Issues at `gaosanliukoushui/career-pilot-cn`. Use the `gh` CLI for issue operations.

External pull requests are not a triage request surface. Requirements enter through GitHub Issues; pull requests are implementation and review artifacts linked to an issue.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body-file <path>`.
- **Read an issue:** `gh issue view <number> --comments`, including labels.
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments` with label or state filters as needed.
- **Comment on an issue:** `gh issue comment <number> --body "..."`.
- **Apply or remove labels:** `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue:** `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v` when operating inside the checkout.

## Skill integration

When a skill says "publish to the issue tracker," create a GitHub issue. When a skill says "fetch the relevant ticket," run `gh issue view <number> --comments`.
