import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The shared Web<->API contract package is published as raw TS (no build
  // step); Next must transpile it like first-party source.
  transpilePackages: ["contracts"],
};

export default nextConfig;
