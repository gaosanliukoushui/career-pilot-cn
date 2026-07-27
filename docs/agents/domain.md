# Domain Docs

CareerPilot CN uses a single-context domain documentation layout.

## Before exploring

- Read the root `CONTEXT.md` when it exists.
- Read ADRs under `docs/adr/` that relate to the area being changed.
- If either location is absent, continue silently. Producer skills create domain documents only when terms or decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/adr/
└── web/
```

## Vocabulary

Use the terms defined in `CONTEXT.md` for issue titles, proposals, hypotheses, interfaces, and test names. Do not introduce synonyms that weaken established distinctions such as Fact, Evidence, ResumeVariant, and Application.

## ADR conflicts

If proposed work conflicts with an existing ADR, identify the conflict explicitly rather than silently overriding the decision.
