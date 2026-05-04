import type { Metadata } from "next";
import "../styles/globals.css";
import { Web3Provider } from "@/components/providers/web3";
import { ToastProvider } from "@/components/providers/toast";
import { ModalProvider } from "@/components/providers/modal";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { ModalRoot } from "@/components/modals/ModalRoot";

export const metadata: Metadata = {
  title: "PlayKaboom — On-chain Mines on Solana",
  description: "Provably fair 4×4 Mines on Solana. Built like Stake, paid by the chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen flex-col bg-surface text-on-surface">
        <Web3Provider>
          <ModalProvider>
            <ToastProvider>
              <Navbar />
              <main className="flex-1 pt-16">{children}</main>
              <Footer />
              <ModalRoot />
            </ToastProvider>
          </ModalProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
