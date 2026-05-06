/**
 * Transfer the program upgrade authority on the BPF Upgradeable Loader from
 * the deployer key to the Squads multisig vault PDA. Run once — after this,
 * every program upgrade requires a Squads vault transaction signed by 2/2
 * multisig members.
 *
 *   PROGRAM_ID=4rPEGz...                                          \
 *   npx tsx --env-file=apps/web/.env.local                       \
 *     scripts/transfer-upgrade-authority.ts
 *
 * What this does:
 *   1. Reads ~/.config/solana/id.json — current upgrade authority + payer.
 *   2. Reads keypairs/squads-devnet.json for the Squads vault PDA address.
 *   3. Computes the ProgramData PDA from the program ID.
 *   4. Builds a BPFLoaderUpgradeable `SetUpgradeAuthorityChecked` ix where:
 *        - current authority signs (deployer)
 *        - new authority is the Squads vault PDA (does NOT need to sign;
 *          we use the unchecked variant + manual confirmation prompt below)
 *   5. Confirms the destination address with the user before sending.
 *   6. Sends + confirms.
 *
 * Idempotent: if the authority is already the Squads vault, exits cleanly.
 *
 * AFTER RUNNING THIS:
 *   The deployer key can no longer call `anchor deploy`. To upgrade:
 *     a) Build the program (anchor build).
 *     b) Run scripts/upgrade-program-via-squads.ts (TODO — write when needed).
 *     c) Two Squads members approve the vault transaction.
 *     d) Execute → ProgramData is replaced with the new bytecode.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as readline from "node:readline";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID_STR = process.env.PROGRAM_ID;
if (!PROGRAM_ID_STR) {
  console.error("PROGRAM_ID env required");
  process.exit(1);
}
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function loadDeployer(): Keypair {
  const path = resolve(homedir(), ".config/solana/id.json");
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function loadSquadsVault(): PublicKey {
  const path = resolve("keypairs/squads-devnet.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { vaultPda: string };
  return new PublicKey(cfg.vaultPda);
}

function deriveProgramData(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  );
  return pda;
}

/** Build the SetUpgradeAuthorityChecked ix manually. The instruction layout
 *  is documented at:
 *  https://docs.solana.com/developing/runtime-facilities/programs#bpf-loader
 *
 *  Tag 7 = SetUpgradeAuthorityChecked. Both old + new authority must sign.
 *  Tag 4 = SetUpgradeAuthority (only old authority signs; new authority is
 *  not verified). We use tag 4 because the new authority is a PDA that
 *  can't sign EOA-style. */
function buildSetUpgradeAuthorityIx(
  programData: PublicKey,
  currentAuthority: PublicKey,
  newAuthority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(4, 0); // SetUpgradeAuthority
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: currentAuthority, isSigner: true, isWritable: false },
      { pubkey: newAuthority, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function confirmFromTerminal(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (a) => {
      rl.close();
      res(a.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const deployer = loadDeployer();
  const squadsVault = loadSquadsVault();
  const programData = deriveProgramData(PROGRAM_ID);

  console.log("RPC:               ", RPC);
  console.log("Program ID:        ", PROGRAM_ID.toBase58());
  console.log("ProgramData PDA:   ", programData.toBase58());
  console.log("Deployer (current):", deployer.publicKey.toBase58());
  console.log("Squads vault (new):", squadsVault.toBase58());

  // Read current authority from on-chain ProgramData.
  const info = await conn.getAccountInfo(programData, "confirmed");
  if (!info) throw new Error("ProgramData PDA not found — wrong program ID?");
  // ProgramData layout: [tag (u32) | slot (u64) | option<authority (33)> | bytecode...]
  // For 'Program' state (tag 3): u32 + u64 + 1+32 = 45 bytes header.
  const tag = info.data.readUInt32LE(0);
  if (tag !== 3) throw new Error(`Unexpected ProgramData tag: ${tag}`);
  const hasAuth = info.data[12] === 1;
  if (!hasAuth) {
    console.error("Program is already immutable — no authority to transfer.");
    process.exit(1);
  }
  const currentAuthority = new PublicKey(info.data.subarray(13, 45));
  console.log("On-chain authority:", currentAuthority.toBase58());

  if (currentAuthority.equals(squadsVault)) {
    console.log("Authority is already the Squads vault — nothing to do.");
    return;
  }
  if (!currentAuthority.equals(deployer.publicKey)) {
    console.error(
      `Deployer (${deployer.publicKey.toBase58()}) is not the current authority. Run as the keypair that deployed the program.`,
    );
    process.exit(1);
  }

  console.log();
  console.log("⚠️  This will transfer upgrade authority of the program to the");
  console.log("    Squads vault. After this, every program upgrade requires");
  console.log("    a 2-of-2 multisig approval. The deployer key alone will");
  console.log("    no longer be able to deploy new program versions.");
  console.log();
  const ok = await confirmFromTerminal("Type 'yes' to proceed: ");
  if (!ok) {
    console.log("Aborted.");
    return;
  }

  const ix = buildSetUpgradeAuthorityIx(
    programData,
    deployer.publicKey,
    squadsVault,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([deployer]);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log("sent:", sig);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("confirmed.");

  // Re-read to verify.
  const info2 = await conn.getAccountInfo(programData, "confirmed");
  if (!info2) throw new Error("ProgramData missing after tx");
  const newAuth = new PublicKey(info2.data.subarray(13, 45));
  console.log("new authority:", newAuth.toBase58());
  if (!newAuth.equals(squadsVault)) {
    console.error("⚠️  New authority does not match Squads vault — investigate.");
    process.exit(1);
  }
  console.log("✓ Done. Future upgrades require Squads multisig approval.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
