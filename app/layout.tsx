import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/manrope";
import "./globals.css";

import { siteDescription, siteOrigin } from "@/lib/seo";

export const metadata: Metadata = {
  metadataBase: siteOrigin,
  title: {
    default: "Aisle — Build your agent stack",
    template: "%s · Aisle",
  },
  description: siteDescription,
  applicationName: "Aisle",
  alternates: { canonical: "/" },
  category: "developer tools",
  creator: "Aisle",
  publisher: "Aisle",
  keywords: ["Agent Skills", "AI agents", "skill marketplace", "developer tools"],
  openGraph: {
    type: "website",
    siteName: "Aisle",
    title: "Aisle — Build your agent stack",
    description: siteDescription,
    url: "/",
  },
  twitter: {
    card: "summary",
    title: "Aisle — Build your agent stack",
    description: siteDescription,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0a0910",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
