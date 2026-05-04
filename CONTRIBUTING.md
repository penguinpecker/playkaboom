# Contributing

## Development workflow

1. `nvm use` — pin Node 20.
2. `npm install` — installs all workspace deps.
3. `cp .env.example .env.local` — fill in `HOUSE_AUTHORITY_KEY`, `SESSION_ENC_KEY`, `NEXT_PUBLIC_PRIVY_APP_ID`.
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

Email `security@playkaboom.example` — please don't open public issues for vulnerabilities.
See [`SECURITY.md`](./SECURITY.md) for the threat model.
