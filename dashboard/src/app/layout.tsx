import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SidebarNav } from "@/components/sidebar-nav";
import { Toaster } from "@/components/ui/sonner";
import { HelpProvider } from "@/components/help-center";

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
        <HelpProvider>
          <SidebarNav />
          {/* pt-14 on mobile clears the fixed top bar; md+ uses the left sidebar offset */}
          <main className="pt-14 md:pl-60 md:pt-0">
            <div className="mx-auto max-w-7xl px-4 py-5 sm:px-5 sm:py-6 md:px-8">{children}</div>
          </main>
          <Toaster richColors position="bottom-right" />
        </HelpProvider>
      </body>
    </html>
  );
}
