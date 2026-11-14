import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { BrowserState, Browser } from "herdr-browser";
import { props, theme, panes, terminals, exec, nextLink, notify, shared, setShared } from "herdr";

// A Plannotator review in an embedded browser, on props.url. As an app in an
// agent's pane opened from a button (Annotate diff: registration "review",
// Annotate reply: "last") without a url, it asks that pane's Pi for the review
// first: the Pi publishes how to reach it in its terminal's `herdr.plannotator`
// label, and its Herdr Plannotator integration opens the review here
// (`pane.app.open` of this app again, which arrives from nextLink()).
export default class PlannotatorBrowser extends View {
  init(_props, cx) {
    const url = props()?.url;
    this.browser = url ? BrowserState(url) : null;
    this.url = url ?? null;
    this.waiting = null;
    if (typeof props()?.app !== "string") return;
    if (!url) this.ask(props().registration, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const opened = await nextLink();
        if (opened?.url) this.show(opened.url);
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

  // Asks the pane's Pi for a review of its changes ("review") or its last reply ("last").
  /** @param {string} kind @param {any} cx */
  ask(kind, cx) {
    if (kind !== "review" && kind !== "last") return;
    // Once per app: one restored after a restart doesn't ask again.
    const asked = shared("plannotator.asked") ?? {};
    const id = props().app;
    if (asked[id]) { this.waiting = "No review arrived. Close this and ask again."; return; }
    const live = new Set(panes().flatMap((p) => (p.apps ?? []).map((a) => a.id)));
    setShared("plannotator.asked", { ...Object.fromEntries(Object.keys(asked).filter((a) => live.has(a)).map((a) => [a, true])), [id]: true });
    const pane = panes().find((p) => p.pane === props()?.pane);
    const address = pane?.terminal;
    const terminal = terminals().find((t) => t.address === address);
    let label = null;
    try { label = JSON.parse(terminal?.labels?.["herdr.plannotator"] ?? "null"); } catch { /* Below. */ }
    if (!address || !label?.request || label.pid !== terminal?.foreground?.pid) {
      this.waiting = "No Pi with the Herdr Plannotator integration runs in this pane.";
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
      .when(Boolean(this.browser.error()), el => el.child(div().px(12).py(6).text_color(t.blocked).child(this.browser.error())))
      .child(div().flex_1().min_h(0).child(Browser(this.browser).size_full()));
  }
}
