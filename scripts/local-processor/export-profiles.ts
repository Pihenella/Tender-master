import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const mod = await import(resolve(__dirname, "../../src/lib/profiles.ts"));
  const profiles = mod.profiles;

  writeFileSync(
    resolve(__dirname, "profiles.json"),
    JSON.stringify(profiles, null, 2),
    "utf-8"
  );

  console.log("Exported profiles to profiles.json");
}

main();
