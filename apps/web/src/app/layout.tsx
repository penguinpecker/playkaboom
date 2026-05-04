import type { Metadata } from "next";
import "../styles/globals.css";
import { Web3Provider } from "@/components/providers/web3";
import { GameProvider } from "@/hooks/useGame";
import { ModalProvider } from "@/hooks/useModal";
import { ToastProvider } from "@/hooks/useToast";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { ModalRoot } from "@/components/modals/ModalRoot";

export const metadata: Metadata = {
  title: "PlayKaboom — On-Chain Mines on Solana",
  description: "Provably fair 4×4 Mines on Solana. Server-assisted commit-reveal, fully on-chain settlement.",
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
