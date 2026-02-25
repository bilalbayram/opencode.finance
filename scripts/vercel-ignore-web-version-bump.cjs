#!/usr/bin/env node

const { execSync } = require("node:child_process");

function readWebVersion(ref) {
  const content = execSync(`git show ${ref}:packages/web/package.json`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(content);

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Missing "version" in ${ref}:packages/web/package.json`);
  }

  return parsed.version;
}

const previousVersion = readWebVersion("HEAD^");
const currentVersion = readWebVersion("HEAD");

if (previousVersion === currentVersion) {
  console.log(
    `Skipping Vercel build: packages/web/package.json version is unchanged (${currentVersion}).`,
  );
  process.exit(0);
}

console.log(
  `Running Vercel build: packages/web/package.json version changed ${previousVersion} -> ${currentVersion}.`,
);
process.exit(1);
