import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";

import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import "./marketplace.css";
import "./monochrome.css";
import "./visibility.css";

import { SelectionProvider } from "@/lib/selection/react";
import { siteDescription, siteOrigin, siteSocialImage } from "@/lib/seo";

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
    images: [siteSocialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "Aisle — Build your agent stack",
    description: siteDescription,
    images: [siteSocialImage.url],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#080808",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className={GeistSans.variable} lang="en">
      <body className={GeistSans.className}>
        <SelectionProvider>{children}</SelectionProvider>
      </body>
    </html>
  );
}
