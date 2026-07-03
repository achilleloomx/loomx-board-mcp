import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the server version: package.json. Previously
// server.ts and remote.ts each hardcoded their own version string and drifted
// out of sync with package.json and each other.
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
  version: string;
};

export const PACKAGE_VERSION = version;
