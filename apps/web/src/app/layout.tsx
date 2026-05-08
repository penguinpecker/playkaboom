import type { Metadata, Viewport } from "next";
import "../styles/globals.css";
import { Web3Provider } from "@/components/providers/web3";
import { GameProvider } from "@/hooks/useGame";
import { ModalProvider } from "@/hooks/useModal";
import { ToastProvider } from "@/hooks/useToast";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { ModalRoot } from "@/components/modals/ModalRoot";

export const metadata: Metadata = {
  metadataBase: new URL("https://playkaboom.gg"),
  title: {
    default: "PlayKaboom — On-Chain Mines on Solana",
    template: "%s · PlayKaboom",
  },
  description: "A Fully Onchain Minesweeper Style Game with Community owned Defi Vault!",
  applicationName: "PlayKaboom",
  manifest: "/manifest.json",
  // Favicon + apple-touch-icon resolve via Next.js file-convention from
  // app/icon.png + app/apple-icon.png — the metadata.icons field would
  // override that. We keep only the OG image declaration in openGraph
  // below (no auto-resolution exists for it).
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PlayKaboom",
  },
  openGraph: {
    type: "website",
    siteName: "PlayKaboom",
    title: "PlayKaboom",
    description: "A Fully Onchain Minesweeper Style Game with Community owned Defi Vault!",
    // Fresh URL (was /kaboom-logo.png) — busts Telegram/X/Discord OG caches
    // that pinned the older brand mark. The file is identical, just at a
    // dedicated OG path.
    images: [{ url: "/og.png", width: 400, height: 400, alt: "PlayKaboom" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PlayKaboom",
    description: "A Fully Onchain Minesweeper Style Game with Community owned Defi Vault!",
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#1b0639",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head />
      <body className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
        <Web3Provider>
          <GameProvider>
            <ModalProvider>
              <ToastProvider>
                <Navbar />
                <main className="flex-1 pt-14 sm:pt-16">{children}</main>
                <Footer />
                <ModalRoot />
              </ToastProvider>
            </ModalProvider>
          </GameProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
