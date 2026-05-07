import Link from "next/link";

export const metadata = {
  title: "Terms of Service — PlayKaboom",
  description: "Terms governing use of playkaboom.gg.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-on-surface px-4 sm:px-6 lg:px-12 py-12 max-w-3xl mx-auto">
      <Link
        href="/"
        className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant hover:text-primary"
      >
        ← Back
      </Link>
      <h1 className="font-headline text-4xl font-black italic tracking-tight text-on-surface mt-6 mb-2">
        TERMS OF SERVICE
      </h1>
      <p className="font-headline text-[10px] tracking-widest uppercase text-on-surface-variant mb-12">
        Last updated 2026-05-07
      </p>

      <div className="space-y-8 text-sm leading-relaxed text-on-surface-variant">
        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            1. Acceptance
          </h2>
          <p>
            By connecting a Solana wallet or otherwise interacting with playkaboom.gg ("the
            Service"), you agree to these Terms. If you do not agree, do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            2. Nature of the Service
          </h2>
          <p>
            PlayKaboom is a non-custodial, on-chain Mines-style game implemented as a Solana
            program. All wagers and payouts settle directly between your wallet and a
            community-owned vault PDA on the Solana mainnet. PlayKaboom does not custody user
            funds, does not operate a deposit balance, and does not facilitate withdrawals or
            deposits of fiat currency.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            3. Eligibility
          </h2>
          <p>
            You represent that (a) you are of legal age to enter into a contract and engage in
            games of chance with crypto assets in your jurisdiction, (b) such activity is lawful
            where you reside, and (c) you are not a sanctioned person under any applicable law.
            You are solely responsible for ensuring your use of the Service complies with the
            laws applicable to you.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            4. Provably Fair
          </h2>
          <p>
            Each game uses a SHA-256 commit-reveal scheme: the server commits a hash of the
            mine layout on chain at start, signs each tile reveal during play, and publishes
            the layout + salt at settlement. Anyone can independently verify any settled game
            via the public verifier or by recomputing the hash.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            5. No Warranty
          </h2>
          <p>
            The Service is provided "as is" without warranties of any kind. The on-chain
            program is open source; review the source code before depositing or wagering.
            We make no guarantees of uptime, profit, or recoverability of funds in the event
            of network outages, smart-contract exploits, or third-party (Solana validators,
            wallet providers, RPC providers) failures.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            6. Limitation of Liability
          </h2>
          <p>
            To the maximum extent permitted by law, the Service operators, contributors, and
            affiliates are not liable for any direct, indirect, incidental, special, or
            consequential damages arising from your use of the Service, including loss of
            funds, missed cash-outs, or game outcomes.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            7. Vault Liquidity
          </h2>
          <p>
            The vault that backs player payouts is a permissionless yield vehicle: anyone may
            deposit SOL via the LP interface and share the casino's net P&L pro-rata. LP
            positions are subject to a withdrawal cooldown (3 days at default config) during
            which deposited assets remain at risk. LPs are not guaranteed returns and may lose
            principal if player payouts exceed accrued house P&L during their stake period.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            8. Prohibited Conduct
          </h2>
          <p>
            You agree not to (a) use the Service for money laundering, terrorism financing, or
            any unlawful purpose, (b) attempt to exploit, reverse engineer, or interfere with
            the Solana program beyond its intended public interface, (c) automate gameplay with
            bots in a way that violates rate limits or stresses the indexer.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            9. Changes
          </h2>
          <p>
            We may update these Terms at any time. Continued use of the Service after a change
            constitutes acceptance.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-xl font-bold text-on-surface mb-3">
            10. Contact
          </h2>
          <p>
            For questions or disputes, reach us via the project's X account:{" "}
            <a
              href="https://x.com/playkaboom"
              className="text-primary hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              @playkaboom
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
