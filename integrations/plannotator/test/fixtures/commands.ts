import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { requestCommand } from "../../ipc.mjs";

// Plannotator's commands, recorded instead of opening a review, and a tool
// that asks for them the way Herdr's tab bar does.
export default function commands(pi: ExtensionAPI) {
  const ran: string[] = [];
  for (const name of ["plannotator-review", "plannotator-last"]) {
    pi.registerCommand(name, { description: name, handler: async () => { ran.push(name); } });
  }
  pi.registerTool({
    name: "annotation_request_probe",
    label: "Annotation request probe",
    description: "Ask this Pi for Plannotator commands through its terminal label.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const request = fileURLToPath(new URL("../../request.mjs", import.meta.url));
      const labels = () => JSON.parse(readFileSync(process.env.FAKE_HC_STATE!, "utf8")).labels;
      for (let i = 0; i < 50; i++) {
        try { if (labels()["herdr.plannotator"]) break; } catch { /* not written yet */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const label = JSON.parse(labels()["herdr.plannotator"]);
      const runs = [];
      // As Herdr runs it: a PATH without hc, and hc named by the label. This
      // hc is a Node script, so the PATH keeps the folder of this Node (CI's
      // is not in /usr/bin).
      const bare = { ...process.env, PATH: [path.dirname(label.node), "/usr/bin", "/bin"].join(path.delimiter) };
      const { execFile } = await import("node:child_process");
      const run = (args: string[]) => new Promise<{ code: number; stderr: string }>(resolve =>
        execFile(label.node, [request, ...args], { env: bare }, (error, _out, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stderr })));
      for (const command of ["review", "last", "other"]) {
        const child = await run(["t1", command, label.hc]);
        runs.push({ command, code: child.code, stderr: child.stderr.trim() });
      }
      for (let i = 0; i < 50 && ran.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
      const wrongToken = await requestCommand("review", { ...label, token: "another-token" });
      const details = { session: ctx.sessionManager.getSessionId(), label: { ...label, token: typeof label.token }, runs, ran, wrongToken };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
