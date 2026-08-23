import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — PlayKaboom",
  description: "How playkaboom.gg handles your data.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-on-surface px-4 sm:px-6 lg:px-12 py-12 max-w-3xl mx-auto">
      <Link
        href="/"
        className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant hover:text-primary"
      >
        ← Back
      </Link>
      <h1 className="font-headline text-4xl font-black italic tracking-tight text-on-surface mt-6 mb-2">
        PRIVACY POLICY
      </h1>
      <p className="font-headline text-[10px] tracking-widest uppercase text-on-surface-variant mb-12">
        Last updated 2026-05-07
      </p>

      <div className="space-y-8 text-sm leading-relaxed text-on-surface-variant">
        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            1. What We Collect
          </h2>
          <p>
            PlayKaboom is non-custodial and minimizes data collection. We process the
            following:
          </p>
          <ul className="list-disc ml-6 mt-3 space-y-1.5">
            <li>
              <strong>Wallet address</strong> — your Solana public key. Required to play and
              receive payouts. Public on chain by design.
            </li>
            <li>
              <strong>Email (optional)</strong> — only if you log in via Privy social/email
              login. Stored by Privy under their own privacy policy. We do not market to you.
            </li>
            <li>
              <strong>IP address</strong> — used transiently for rate-limiting and abuse
              prevention. Not stored long-term beyond standard server logs.
            </li>
            <li>
              <strong>Game history</strong> — settled games are public on the Solana mainnet.
              We mirror this data into our indexer (Supabase Postgres) for fast leaderboard
              and history queries; nothing is stored that isn't already public on chain.
            </li>
            <li>
              <strong>Referral metadata</strong> — if you visit via a referral link, a session
              identifier and the referral code are stored locally to attribute future signups.
              No personal data attached.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            2. What We Do Not Collect
          </h2>
          <ul className="list-disc ml-6 space-y-1.5">
            <li>We do not collect government IDs, KYC documents, or financial account data.</li>
            <li>We do not custody crypto assets — wagers settle wallet-to-vault on chain.</li>
            <li>We do not sell, rent, or trade personal data.</li>
            <li>We do not use third-party advertising networks or behavioral tracking pixels.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            3. Cookies and Local Storage
          </h2>
          <p>
            We use first-party cookies and browser localStorage solely to (a) maintain your
            authenticated session via Privy, (b) cache your encrypted game token across page
            reloads, and (c) remember UI preferences. No third-party tracking cookies are
            served from our origin.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            4. Third-Party Processors
          </h2>
          <p>
            We use the following third-party services to operate the Service. Each has its own
            privacy practices; review their policies if you wish.
          </p>
          <ul className="list-disc ml-6 mt-3 space-y-1.5">
            <li>
              <strong>Privy</strong> — embedded wallets and authentication (
              <a
                href="https://privy.io/legal/privacy"
                className="text-primary hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                privy.io/legal/privacy
              </a>
              )
            </li>
            <li>
              <strong>Turnkey</strong> — HSM-backed signing for the house authority key.
              Turnkey never sees your data; only ours.
            </li>
            <li>
              <strong>Supabase</strong> — Postgres database hosting our indexer cache.
            </li>
            <li>
              <strong>Vercel</strong> — application and API hosting.
            </li>
            <li>
              <strong>Alchemy</strong> — Solana RPC and WebSocket node provider.
            </li>
            <li>
              <strong>Pyth</strong> — public SOL/USD price feed for the in-app price overlay.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            5. On-Chain Data Is Public
          </h2>
          <p>
            All on-chain transactions associated with your wallet — bets, payouts, LP
            deposits, referral claims — are publicly visible on the Solana blockchain forever.
            We cannot redact or remove on-chain data. If you want privacy, use a dedicated
            wallet for PlayKaboom and avoid linking it to your other identities.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            6. Your Rights
          </h2>
          <p>
            You may request deletion of off-chain data we hold (indexer mirror rows, referral
            visit logs, server logs older than 30 days) by contacting us. On-chain data is
            outside our control.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            7. Security
          </h2>
          <p>
            All sensitive secrets (Supabase service role, Turnkey API keys, session encryption
            keys) are stored in Vercel environment variables marked as Sensitive (encrypted at
            rest, write-only). The hot signing key for the on-chain house authority lives
            inside a Turnkey HSM and never leaves the enclave.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            8. Changes
          </h2>
          <p>
            We may update this policy. Material changes will be announced via{" "}
            <a
              href="https://x.com/playkaboomgg"
              className="text-primary hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              @playkaboomgg
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
