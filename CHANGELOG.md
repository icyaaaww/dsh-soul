# Changelog

## 0.2.0 — 2026-10-24

- Compact skill cards with full-text retrieval; relevant accepted trial skills are discoverable and explicitly unverified.
- Bounded `/learn inbox` shows candidate/trial summaries, evidence and human review actions.
- Explicit remember/prefer commands now activate identical existing non-skill candidates.
- 128-entry retrieval cache invalidated by transactional memory revision triggers, including cross-connection changes. Prompt metrics are buffered instead of synchronously written on every assembly.
- Coalesce same-session pending learning batches up to 24 evidence records; consider older unqueued corrections. Running requests are never changed.
- Safe failure codes, reported daily token fields, unknown-usage counts and recent scoped job results.
- Transactional schema 1 → 2 upgrade preserves evidence, feedback, tombstones and spent budget. Version 0.1 cannot open schema 2.
- Added regression and actual-host coverage, 11 deterministic retrieval scenarios, and separate cached/uncached local benchmarks.

No new model calls or runtime dependencies are required. These changes do not establish real-model quality improvements or a monetary savings percentage.

## 0.1.0 — 2026-10-24

- Local SQLite/FTS memory with Chinese bigram retrieval, project boundaries and profile preferences.
- Native DSH commands, tools and durable context integration; no duplicate host runtime dependencies.
- Human corrections, revision history, evidence provenance, forgetting with source suppression.
- Structured skill candidates, human trial feedback and regression deactivation.
- Optional single-worker LLM extraction with explicit route, durable request reservations and no automatic retry.
- Bounded prompt context, input excerpts, pending jobs and unreferenced event retention.
- Real DSH 0.2.0-rc.2 integration tests, fault tests and an isolated 10,000-record benchmark.

This is an initial testable release. Automatic skill execution, semantic-vector retrieval, monetary hard caps and a graphical memory dashboard are not implemented.
