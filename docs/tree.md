# secedgar-mcp-server - Directory Structure

Generated on: 2026-07-10 02:07:48

```text
secedgar-mcp-server/
├── .agents/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.10.x/
│   ├── 0.11.x/
│   ├── 0.12.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   ├── 0.8.x/
│   ├── 0.9.x/
│   └── template.md
├── claude-plans/
├── docs/
│   └── sec-edgar-mcp-design.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── edgar-mirror-init.ts
│   ├── edgar-mirror-refresh.ts
│   ├── edgar-mirror-verify.ts
│   ├── gen-former-names.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── company-analysis.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── concepts.resource.ts
│   │   │       └── filing-types.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── company-search.tool.ts
│   │           ├── dataframe-describe.tool.ts
│   │           ├── dataframe-drop.tool.ts
│   │           ├── dataframe-query.tool.ts
│   │           ├── fetch-frames.tool.ts
│   │           ├── get-filing.tool.ts
│   │           ├── get-financials.tool.ts
│   │           ├── get-insider-transactions.tool.ts
│   │           ├── get-institutional-holdings.tool.ts
│   │           ├── search-concepts.tool.ts
│   │           └── search-filings.tool.ts
│   ├── services/
│   │   ├── canvas-bridge/
│   │   │   ├── canvas-bridge.ts
│   │   │   └── sql-gate-extras.ts
│   │   └── edgar/
│   │       ├── data/
│   │       │   └── former-names.json
│   │       ├── mirror/
│   │       │   ├── companyfacts-sync.ts
│   │       │   ├── edgar-mirror.ts
│   │       │   ├── index.ts
│   │       │   ├── tickers-sync.ts
│   │       │   └── types.ts
│   │       ├── concept-map.ts
│   │       ├── edgar-api-service.ts
│   │       ├── filing-headers.ts
│   │       ├── filing-to-text.ts
│   │       ├── ownership-parser.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── company-analysis.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── concepts.resource.test.ts
│   │   │       └── filing-types.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── company-search.tool.test.ts
│   │           ├── dataframe-describe.tool.test.ts
│   │           ├── dataframe-drop.tool.test.ts
│   │           ├── dataframe-query.tool.test.ts
│   │           ├── fetch-frames.tool.test.ts
│   │           ├── get-filing.tool.test.ts
│   │           ├── get-financials.tool.test.ts
│   │           ├── get-insider-transactions.tool.test.ts
│   │           ├── get-institutional-holdings.tool.test.ts
│   │           ├── search-concepts.tool.test.ts
│   │           ├── search-filings.tool.test.ts
│   │           └── security.test.ts
│   └── services/
│       ├── canvas-bridge/
│       │   ├── canvas-bridge.test.ts
│       │   └── sql-gate-extras.test.ts
│       └── edgar/
│           ├── mirror/
│           │   ├── companyfacts-sync.test.ts
│           │   ├── edgar-mirror.test.ts
│           │   └── tickers-sync.test.ts
│           ├── concept-map.test.ts
│           ├── edgar-api-service.efts.test.ts
│           ├── edgar-api-service.full-index.test.ts
│           ├── edgar-api-service.mirror.test.ts
│           ├── edgar-api-service.test.ts
│           ├── filing-to-text.test.ts
│           └── ownership-parser.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
