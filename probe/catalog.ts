/**
 * Dump the live catalog (GetCliModelConfigs, ide=windsurf) and print every
 * family that looks like SWE, plus the full variant list of the swe-2 family.
 * Never prints credentials.
 */
import { readCredentials } from "../src/credentials.js";
import { loadHttpCatalog, loadCliCatalog } from "../src/models.js";

const creds = readCredentials();
if (!creds) {
  console.error("No credentials at ~/.local/share/devin/credentials.toml");
  process.exit(1);
}

let catalog = null;
try {
  catalog = await loadHttpCatalog(creds.apiKey, creds.apiServerUrl);
  console.log(`# catalog: HTTP (${catalog?.families.length ?? 0} families)`);
} catch (e) {
  console.error("HTTP catalog failed:", e instanceof Error ? e.message : e);
  catalog = await loadCliCatalog();
  console.log(`# catalog: CLI fallback (${catalog?.families.length ?? 0} families)`);
}

if (!catalog) {
  console.error("no catalog");
  process.exit(1);
}

console.log("\n## families containing 'swe' in uid/slug:");
for (const f of catalog.families) {
  const uid = (f.family_uid + " " + f.slug + " " + f.family_label).toLowerCase();
  if (uid.includes("swe")) {
    console.log(`- ${f.family_label} (uid=${f.family_uid}, slug=${f.slug}, ${f.variants.length} variants)`);
  }
}

const swe2 = catalog.families.find((f) => (f.slug || "").includes("swe-2"));
if (swe2) {
  console.log(`\n## swe-2 variants:`);
  for (const v of swe2.variants) {
    console.log(
      `  ${v.model_uid.padEnd(34)} ctx=${v.max_context_tokens ?? "?"} out=${v.max_output_tokens ?? "?"} tier=${v.cost_tier ?? "?"} ${v.is_new ? "[new]" : ""}${v.is_beta ? "[beta]" : ""} ${v.cost_summary ?? ""}`,
    );
  }
} else {
  console.log("\nno swe-2 family; all slugs:", catalog.families.map((f) => f.slug).join(", "));
}
