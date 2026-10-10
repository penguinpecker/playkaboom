# Contributing

## Development workflow

1. `nvm use` — pin Node 20.
2. `npm install` — installs all workspace deps.
3. Create `apps/web/.env.local` — the required variable names are validated in `apps/web/src/server/env.ts`; at minimum set `SESSION_ENC_KEY` and `NEXT_PUBLIC_PRIVY_APP_ID`.
4. `npm run dev` — starts the web app on http://localhost:3000.
5. `npm run test` — runs SDK Vitest suite. `npm run anchor:test` runs the on-chain flow tests (requires Anchor + a funded devnet wallet).

## Code style

- TypeScript strict; no `any` outside narrow Privy adapter shims.
- No hand-rolled discriminators in app code — go through `@playkaboom/sdk`.
- Server entry points must validate input via `zod` (`@playkaboom/shared/schemas`).
- Server-only modules import from `@/server/*`. Client modules must not.

## Commit conventions

- One concern per commit.
- Subject line starts with the area: `program: …`, `sdk: …`, `web: …`, `tests: …`, `infra: …`.
- Use the imperative mood.

## Reporting security issues

Report privately via GitHub's private advisory form:
<https://github.com/penguinpecker/playkaboom/security/advisories/new>
Please don't open public issues for vulnerabilities.
See [`SECURITY.md`](./SECURITY.md) for the threat model.
