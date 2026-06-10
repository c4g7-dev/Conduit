import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["10.8.8.2", "10.27.27.0/24", "192.168.0.0/16"],
  transpilePackages: ["ansi-to-html"],
  // Minimal self-contained server bundle for deploying the panel into per-node LXCs.
  output: "standalone",
  // Admin panel — skip image optimization so the runtime has no native sharp dependency
  // (keeps the standalone bundle portable across the build host and the Debian LXC).
  images: { unoptimized: true },
};

export default nextConfig;
