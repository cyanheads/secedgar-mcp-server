# Contributing

Hi, and thanks for using `secedgar-mcp-server`! If you've hit a bug or want something the server doesn't do yet, an issue is the most useful thing you can send. Let me know about any rough edge or new ideas.

Issues are the contribution path here: bugs, feature requests, and documentation gaps all land there, and code changes go through my workflows, so a precise issue with a reproduction is the fastest route to a fix.

- [Report a bug](https://github.com/cyanheads/secedgar-mcp-server/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/cyanheads/secedgar-mcp-server/issues/new?template=feature_request.yml)
- [Float an idea or ask a question](https://github.com/cyanheads/secedgar-mcp-server/issues/new) — free-form, no template, no need to be sure it's a bug first

The bug and feature forms are structured, and filling in the fields is what makes those actionable. Anything that fits neither can just be a plain issue — a half-formed idea in your own words is fine.

## Before filing

A few things that save a round-trip:

1. **Separate the server from SEC EDGAR.** EDGAR data is sparse and inconsistent by filer, and a missing XBRL fact is usually upstream rather than a parsing bug. Where you can, check the raw SEC response — `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` for financials, the filing index on `https://www.sec.gov/Archives/edgar/data/` for documents — and say what it contained.
2. **Check you're on the latest release.** `bun outdated @cyanheads/secedgar-mcp-server` — fixes land on the current version, older ones aren't patched.
3. **Search existing issues.** `gh issue list -R cyanheads/secedgar-mcp-server --search "<keyword>" --state all`. Add to the matching thread instead of opening a duplicate.
4. **Redact anything sensitive.** Issues are public and permanent — no keys, tokens, auth headers, internal URLs, or PII in code, logs, or stack traces. `EDGAR_USER_AGENT` carries a real email address; scrub it.

## What makes an issue actionable

- Server version, runtime (Bun / Node), and transport (stdio / HTTP).
- The exact tool call — tool name and the full arguments object.
- Actual vs expected output, verbatim: error messages, `data.reason`, and stack traces as they appeared.
- A ticker, CIK, accession number, or concept that reproduces it. A concrete identifier turns a report into a test case.
- For features: the use case first, then the tool call as you'd want to make it.

## Security

Don't open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md) for private disclosure.
