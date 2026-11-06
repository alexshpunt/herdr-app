import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function probe(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_route_probe",
    label: "Browser route probe",
    description: "Record the browser route configured in this test session.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const session = ctx.sessionManager.getSessionId();
      pi.events.emit("plannotator:session-opened", { id: "pn-111111", piSessionId: session, url: "http://localhost:12345" });
      pi.events.emit("plannotator:session-opened", { id: "pn-222222", piSessionId: "another-session", url: "http://localhost:23456" });
      return {
        content: [{ type: "text", text: JSON.stringify({ session, configuredSession: process.env.HERDR_PLANNOTATOR_SESSION_ID, browser: process.env.PLANNOTATOR_BROWSER }) }],
        details: { session, configuredSession: process.env.HERDR_PLANNOTATOR_SESSION_ID, browser: process.env.PLANNOTATOR_BROWSER },
      };
    },
  });
}
