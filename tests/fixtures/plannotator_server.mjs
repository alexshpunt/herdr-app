// Research-only server using the released Plannotator UI and real API routes.
// Pass an npm prefix containing @plannotator/pi-extension@0.28.55 and jiti@2.7.0.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = resolve(process.argv[2]);
const packageRoot = join(prefix, "node_modules/@plannotator/pi-extension");
const { createJiti } = await import(pathToFileURL(join(prefix, "node_modules/jiti/lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url);
const { startPlanReviewServer } = await jiti.import(join(packageRoot, "server/serverPlan.ts"));
process.env.PI_CODING_AGENT_DIR = resolve(".tmp/plannotator-agent");
process.env.PLANNOTATOR_PORT = "9461";
const server = await startPlanReviewServer({
  plan: "# Navigation experiment\n\n[Fixture B](http://127.0.0.1:8956/b.html)\n\nThis is disposable research content.\n",
  htmlContent: readFileSync(join(packageRoot, "plannotator.html"), "utf8"),
  sharingEnabled: false,
});
console.log(JSON.stringify({ url: server.url, port: server.port, version: "0.28.55" }));
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
process.on("SIGINT", () => { server.stop(); process.exit(0); });
