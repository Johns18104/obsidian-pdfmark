import { burnAnnotations } from "../src/burn";
import fs from "fs";

async function main() {
  const src = new Uint8Array(fs.readFileSync("test/harness/sample.pdf"));
  const annots = JSON.parse(fs.readFileSync("test/live-annots.json", "utf8"));
  const out = await burnAnnotations(src, annots);
  fs.writeFileSync("test/live-burned.pdf", out);
  console.log("burnt", annots.length, "annots ->", out.length, "bytes");
}
main().catch((e) => { console.error(e); process.exit(1); });
