import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppDrawer } from "@/components/AppDrawer";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { ActiveSessionProvider } from "@/contexts/ActiveSessionContext";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Amy",
  description: "Amy - personal assistant console",
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full flex-col">
        <ConnectionBanner />
        <ActiveSessionProvider>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <AppDrawer />
            <div className="min-h-0 min-w-0 flex-1">{children}</div>
          </div>
        </ActiveSessionProvider>
      </body>
    </html>
  );
}
