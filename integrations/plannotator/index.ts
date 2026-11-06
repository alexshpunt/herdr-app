import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeReview, resolveApp, runJson } from "./open.mjs";

/** Route Plannotator's supported browser hook without changing its Ask AI bridge. */
export default function herdrPlannotator(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let session: string | undefined;
  const reviews = new Set<string>();
  const prior = { browser: process.env.PLANNOTATOR_BROWSER, session: process.env.HERDR_PLANNOTATOR_SESSION_ID, node: process.env.HERDR_PLANNOTATOR_NODE, remote: process.env.PLANNOTATOR_REMOTE };
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), process.platform === "win32" ? "open.cmd" : "open.mjs");
  let managed = false;

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    session = ctx.sessionManager.getSessionId();
    if (process.env.HERDR_PLANNOTATOR_MODE === "disabled" || prior.browser !== undefined) return;
    process.env.HERDR_PLANNOTATOR_SESSION_ID = session;
    process.env.HERDR_PLANNOTATOR_NODE = process.execPath;
    process.env.PLANNOTATOR_BROWSER = helper;
    managed = true;
    // WSL and its Windows host share localhost. An SSH transport into that WSL
    // core must not disable Plannotator's in-process Ask this session provider.
    if (prior.remote === undefined && process.env.HC_TERMINAL_ID && /microsoft/i.test(release())) {
      try {
        const api = await runJson(await resolveApp(), ["--browser-api"]);
        if (api.version === 1) process.env.PLANNOTATOR_REMOTE = "0";
      } catch { /* An unmodified/missing app keeps Plannotator's remote policy. */ }
    }
  });

  pi.events.on("plannotator:session-opened", data => {
    const event = data as { piSessionId?: string; url?: string };
    if (event.piSessionId === session && typeof event.url === "string") reviews.add(event.url);
  });
  pi.events.on("plannotator:session-closed", data => {
    const event = data as { piSessionId?: string; url?: string };
    if (event.piSessionId !== session || typeof event.url !== "string") return;
    reviews.delete(event.url);
    void closeReview(session, event.url).catch(error => {
      try { context?.ui.notify(`Plannotator pane cleanup failed: ${error.message}`, "warning"); } catch { console.error(error); }
    });
  });
  pi.on("session_shutdown", async () => {
    await Promise.allSettled([...reviews].map(url => closeReview(session, url)));
    context = undefined;
    if (!managed) return;
    for (const [key, value] of [["PLANNOTATOR_BROWSER", prior.browser], ["HERDR_PLANNOTATOR_SESSION_ID", prior.session], ["HERDR_PLANNOTATOR_NODE", prior.node], ["PLANNOTATOR_REMOTE", prior.remote]]) {
      if (value === undefined) delete process.env[key as string]; else process.env[key as string] = value;
    }
  });
}
