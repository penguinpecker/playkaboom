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
  description:
    "Provably fair 4×4 Mines on Solana. Server-assisted commit-reveal, fully on-chain settlement.",
  applicationName: "PlayKaboom",
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PlayKaboom",
  },
  openGraph: {
    type: "website",
    siteName: "PlayKaboom",
    title: "PlayKaboom — On-chain Mines on Solana",
    description: "Provably fair 4×4 Mines. SHA-256 commit-reveal. Built on Solana.",
    images: [{ url: "/icons/icon.svg", width: 512, height: 512 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PlayKaboom",
    description: "On-chain Mines. Provably fair. Solana.",
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
                <main className="flex-1 pt-16">{children}</main>
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
