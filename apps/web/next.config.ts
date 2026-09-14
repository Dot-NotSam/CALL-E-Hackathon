import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The workspace packages ship TypeScript source rather than a build step, so
   * Next compiles them alongside the app. `@sentinel/agent` pulls the LangGraph
   * coordination graph into the route handlers.
   */
  transpilePackages: ["@sentinel/calle", "@sentinel/agent", "@sentinel/types"],
};

export default nextConfig;
