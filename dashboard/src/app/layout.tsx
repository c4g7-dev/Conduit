import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SidebarNav } from "@/components/sidebar-nav";
import { Toaster } from "@/components/ui/sonner";

// Monospace UI font — gives the control plane an ops/terminal identity.
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Conduit · c4g7 Network",
  description: "Proxmox-based orchestration panel for the c4g7 MC network",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${jetbrains.variable} font-sans antialiased`}>
        <SidebarNav />
        <main className="md:pl-60">
          <div className="mx-auto max-w-7xl px-5 py-6 md:px-8">{children}</div>
        </main>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
