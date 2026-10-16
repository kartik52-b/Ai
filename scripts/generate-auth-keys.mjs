import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";

// Generates the RS256 signing keypair required by @convex-dev/auth and sets it
// on the currently configured Convex deployment (same as `npx @convex-dev/auth`).
// Safe to re-run; re-running invalidates existing sessions.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "jwk" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const jwtPrivateKey = privateKey.trimEnd().replace(/\n/g, " ");
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

function setVar(name, value) {
  execFileSync("bunx", ["convex", "env", "set", "--", name, value], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  console.log(`set ${name} (length ${value.length})`);
}

try {
  setVar("JWT_PRIVATE_KEY", jwtPrivateKey);
  setVar("JWKS", jwks);
  console.log("auth keys configured");
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(0, 300);
  console.error("failed to set env vars:", out);
  process.exit(1);
}
