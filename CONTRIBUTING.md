# Contributing to insta-oss

## Dev setup

Prereqs: Docker (running) + Node ≥ 22 (`.nvmrc`).

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # unit (no Docker) + integration (needs Docker; pulls postgres/minio/mc once)
npx tsx src/main.ts   # run the daemon locally
```

## Branch model

- `main` is the release branch — changes land via PR.
- Day-to-day work happens on `devel` (or a feature branch) and merges into `main` by PR.

## Guidelines

- **Keep CLI parity**: the daemon implements the standard `insta` command surface — don't add
  daemon-only commands or endpoints; response shapes must keep the stock CLI working unchanged.
- **Every behavior change needs a test** — contract tests (fake adapters, fast) for API shapes,
  integration tests (real Docker) for anything touching containers or clone isolation.
- **Never orphan resources**: provisioning failures must compensate (destroy what was created).
- Match the existing style: small focused modules, comments only for non-obvious constraints.

## Reporting issues

Include: OS, Docker + Node versions, the daemon log, and the failing `insta` command.
