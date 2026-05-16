# Draft: public issue to file on magicblock-labs/delegation-program

This is the unresolved hard launch blocker from the 2026-05-16 feasibility
audit. Filing this on the record gives us a written answer to point at
when the question comes up internally during the Phase 3 canary review.

**Target repo**: `magicblock-labs/delegation-program`
**Issue type**: Question / documentation request (no template required)
**Title**: `Documenting the force-undelegate / validator-stall recovery path for the program owner`

---

**Body** (markdown — paste verbatim):

```
Hi team — thank you for the work on the delegation program. I'm evaluating Magicblock ER for a real-money mainnet Solana product and the migration plan is well underway. Before flipping any real-money traffic, I'd like to confirm one operational property that I couldn't find documented:

**Question**: When a delegated account is held by an ER and the operating validator becomes unresponsive (or chooses not to commit/undelegate), what recourse does the program owner have to recover the account back to base layer?

Specifically:

1. Does `commit_frequency_ms` (or any timeout) cause an **automatic** undelegation if no commit lands within some window? If so:
   - What window is enforced today on the public mainnet validators (`as.magicblock.app`, `us.magicblock.app`, `eu.magicblock.app`)?
   - Is the auto-expiry observable on-chain, or do we need to query the validator out-of-band?

2. Is there a `force_undelegate` / `claim_back` instruction that the **program owner** (or an end user) can invoke on base layer when the validator fails to cooperate? If yes, please link the canonical reference; if no, what is the recommended runbook for that situation?

3. If neither (1) nor (2) provides recourse: in the worst case where a validator simply ignores undelegate requests, what is the practical bound on how long a delegated account can stay stuck?

For context: I'm planning to delegate per-game PDAs that hold ~100ms-of-game state, NOT funds. The vault PDA itself is never delegated. So the worst-case impact is "a single game session never settles" rather than "player funds locked" — but I still need to document the worst-case clock to set Phase 3 canary alarms appropriately.

Happy to discuss off-issue if any of this is sensitive. Mostly I want to make sure the property is recorded somewhere I can cite during our pre-launch review.

Thanks!
```

---

## Why this exact wording

- **Specific, not hand-wavy.** Naming the public endpoints + asking
  about `commit_frequency_ms` shows we've done homework. Generic
  "what happens if it breaks?" gets generic non-answers.
- **Three numbered subquestions** so Magicblock can answer 1+2 even
  if 3 has no good answer. Maximizes chance of getting at least
  partial documentation we can cite.
- **Mentions the scope** (per-game state, not vault funds) so they
  understand we're not asking them to underwrite an unlimited risk
  surface. This makes them more likely to answer candidly.
- **Offers off-issue discussion** as an out for sensitive answers.
- **Does NOT mention PlayKaboom by name.** Public issue, generic
  "real-money mainnet Solana product." We can introduce the brand
  in a follow-up if/when they reach out for a paid relationship.

## Cross-reference

This issue tracks the V8 (force-undelegate) blocker in
[MAGICBLOCK_PLAN.md §4](../MAGICBLOCK_PLAN.md). The Phase 3 canary
gate cannot open until this has a written answer.
