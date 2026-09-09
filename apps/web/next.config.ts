import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: ["@loom/core"],
  serverExternalPackages: ["ai", "@ai-sdk/openai"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
