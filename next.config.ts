import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    // The repository may live beside other JavaScript projects and lockfiles on local machines.
    // Keep Next's file tracing and dev server rooted to Aisle instead of an inferred ancestor.
    root: process.cwd(),
  },
};

export default nextConfig;
