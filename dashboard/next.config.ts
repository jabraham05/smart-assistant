import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // dockerode pulls in docker-modem -> ssh2 (an optional SSH transport we
  // never use - we only connect via the local docker.sock), and ssh2 ships
  // a native crypto.js asset Turbopack can't place in an ESM chunk. Marking
  // it external leaves it as a real runtime require() instead of bundling
  // it, which is fine since this only ever runs in the Node.js server, not
  // the browser. Confirmed live: without this, `next build` fails with
  // "asset is not placeable in ESM chunks" tracing through
  // dockerode -> docker-modem -> ssh2 -> crypto.js.
  serverExternalPackages: ["dockerode"],
};

export default nextConfig;
