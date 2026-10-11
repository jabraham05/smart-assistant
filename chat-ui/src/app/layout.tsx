import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Sidebar } from "@/components/Sidebar";
import { ConnectionBanner } from "@/components/ConnectionBanner";
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
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <div className="min-h-0 flex-1 pb-[calc(3.75rem+env(safe-area-inset-bottom))] md:pb-0">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
