import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// package.json sits one directory above the compiled file (dist/version.js ->
// ../package.json; src/version.ts -> ../package.json). Read it at runtime so the
// name and version have a single source of truth instead of hard-coded copies.
const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;
export const USER_AGENT = `${pkg.name}/${pkg.version} (+https://www.npmjs.com/package/${pkg.name})`;
