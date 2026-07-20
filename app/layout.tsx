import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "Aisle — Build your agent stack",
    template: "%s · Aisle",
  },
  description:
    "Discover public Agent Skills, compose a trusted stack, and install it with one command.",
  applicationName: "Aisle",
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
