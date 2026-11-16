import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { BrowserState, Browser } from "herdr-browser";
import { props, theme, panes, terminals, exec, nextLink, notify, shared, setShared } from "herdr";

// A Plannotator review in an embedded browser, on props.url. As an app opened
// for an agent from a button (`app.open`; Annotate diff: app "review", Annotate
// reply: "last") without a url, it asks that agent's Pi for the review first:
// the Pi publishes how to reach it in its terminal's `herdr.plannotator` label,
// and its Herdr Plannotator integration opens the review here (`app.open` of
// this app again, which arrives from nextLink()). Pressing the button again
// asks again.
export default class PlannotatorBrowser extends View {
  init(_props, cx) {
    const url = props()?.url;
    this.browser = url ? BrowserState(url) : null;
    this.url = url ?? null;
    this.waiting = null;
    if (typeof props()?.app !== "string") return;
    if (!url) this.ask(props().app, false, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const opened = await nextLink();
        if (opened?.url) this.show(opened.url);
        else this.ask(opened?.app ?? props().app, true, cx);
        cx.notify();
      }
    });
  }

  /** @param {string} url */
  show(url) {
    this.url = url;
    this.waiting = null;
    try {
      if (this.browser) this.browser.navigate(url);
      else this.browser = BrowserState(url);
    } catch (error) {
      console.error(`Cannot open ${url}: ${error}`);
    }
  }

  // The agent this app was opened for: its `origin` prop, the terminal as on
  // the machine of its space, whose pane ids carry that machine (`vps/p…`).
  agent() {
    const origin = props()?.origin;
    if (typeof origin !== "string" || !origin) return null;
    const pane = String(props()?.pane ?? "");
    const cut = pane.indexOf("/");
    return cut < 0 || origin.includes("/") ? origin : `${pane.slice(0, cut + 1)}${origin}`;
  }

  // Asks the agent's Pi for a review of its changes ("review") or its last
  // reply ("last"). A copy restored after a restart doesn't ask again; the
  // button pressed again (`again`) does.
  /** @param {string} kind @param {boolean} again @param {any} cx */
  ask(kind, again, cx) {
    if (kind !== "review" && kind !== "last") return;
    const asked = shared("plannotator.asked") ?? {};
    const id = props().pane;
    if (asked[id] && !again) { this.waiting = "No review arrived. Press the button again to ask again."; return; }
    const live = new Set(panes().map((p) => p.pane));
    setShared("plannotator.asked", { ...Object.fromEntries(Object.keys(asked).filter((a) => live.has(a)).map((a) => [a, true])), [id]: true });
    const address = this.agent();
    const terminal = terminals().find((t) => t.address === address);
    let label = null;
    try { label = JSON.parse(terminal?.labels?.["herdr.plannotator"] ?? "null"); } catch { /* Below. */ }
    if (!address || !label?.request || !Number.isSafeInteger(label.pid) || label.pid <= 0
      || terminal?.state !== "live" || (label.pid !== terminal?.pid && label.pid !== terminal?.foreground?.pid)) {
      this.waiting = "No Pi with the Herdr Plannotator integration runs for this agent.";
      return;
    }
    const cut = address.indexOf("/");
    const [machine, local] = cut < 0 ? [null, address] : [address.slice(0, cut), address.slice(cut + 1)];
    this.waiting = kind === "review" ? "Asking the agent to annotate its changes…" : "Asking the agent to annotate its last reply…";
    cx.spawn(async (cx) => {
      try {
        const result = await exec(label.node, [label.request, local, kind, ...(label.hc ? [label.hc] : [])], { on: machine ?? undefined, timeout: 60000 });
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
      } catch (error) {
        this.waiting = String(error?.message ?? error);
        notify({ title: kind === "review" ? "Could not annotate the diff" : "Could not annotate the reply", body: this.waiting, level: "error" });
      }
      cx.notify();
    });
  }

  button(t, id, label, action) {
    return div().id(id).px(8).py(4).rounded(4).flex_none()
      .text_color(t.muted).cursor_pointer()
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(label);
  }

  render() {
    const t = theme();
    if (!this.browser) return div().size_full().p(16).text_color(t.muted).child(this.waiting ?? "Open a Plannotator review from an agent to show it here.");
    return v_flex().size_full().bg(t.surface).text_color(t.foreground).text_size(12)
      .child(h_flex().h(38).flex_none().px(8).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(this.button(t, "back", "Back", () => this.browser.back()))
        .child(this.button(t, "reload", "Reload", () => this.browser.reload()))
        .child(this.button(t, "external", "Open externally", (_event, cx) => cx.open_url(this.browser.url())))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.url || "Plannotator")))
      .when(Boolean(this.waiting), el => el.child(div().px(12).py(6).text_color(t.muted).child(this.waiting)))
      .when(Boolean(this.browser.error()), el => el.child(div().px(12).py(6).text_color(t.blocked).child(this.browser.error())))
      .child(div().flex_1().min_h(0).child(Browser(this.browser).size_full()));
  }
}
