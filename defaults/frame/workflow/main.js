import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { workflow, machines, spaces, theme, props, closeOverlay } from "herdr";
import { modelChoices, currentModelLabel } from "./models.js";

const icon = name => `mods/workspace-chrome/${name}.svg`;
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"]
  .map(id => ({ id, name: id === "xhigh" ? "Extra high" : id[0].toUpperCase() + id.slice(1) }));

export default class Workflow extends View {
  init(_props, cx) {
    this.config = null;
    this.catalog = null;
    // The dock is told the selected space's machine; a side panel section follows
    // the selected space until the person picks a machine.
    this.machine = (this.docked() ? props()?.machine : this.spaceMachine()) ?? "";
    this.machineChosen = this.docked();
    this.loading = true;
    this.saving = false;
    this.saves = 0;
    this.error = null;
    this.picking = null;
    this.machinePicker = false;
    this.query = "";
    this.at = 0;
    this.generation = 0;
    this.handle = cx.focus_handle();
    // A side panel section leaves the keyboard where it is; the dock takes it.
    if (this.docked()) this.handle.focus();
    this.input = InputState.new({ placeholder: "Search models" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => {
      const choice = this.choices()[this.at];
      if (choice) this.choose(choice, cx);
    });
    this.refresh(cx);
    // The side panel keeps this copy alive: pick up profile changes made elsewhere (workflow.set) too.
    cx.timer.every(4000, (cx) => { if (!this.loading && !this.saving) { this.loadConfig(cx); this.loadCatalog(cx); } });
  }

  refresh(cx) {
    if (this.saving) return;
    this.loading = true;
    this.error = null;
    cx.spawn(async cx => {
      try { this.config = await workflow("get"); }
      catch (error) { this.error = String(error); }
      this.loading = false;
      cx.notify();
      this.loadCatalog(cx);
    });
  }

  loadConfig(cx) {
    const saves = this.saves;
    cx.spawn(async cx => {
      try {
        const config = await workflow("get");
        // A save that started meanwhile wins: its reply sets the profiles.
        if (!this.saving && saves === this.saves) { this.config = config; cx.notify(); }
      } catch (error) { this.error = String(error); cx.notify(); }
    });
  }

  spaceMachine() { return spaces().find(space => space.active)?.machine ?? ""; }

  loadCatalog(cx) {
    // The section starts before the spaces load and follows later switches.
    if (!this.machineChosen && this.spaceMachine() !== this.machine) { this.machine = this.spaceMachine(); this.catalog = null; }
    const generation = ++this.generation;
    const machine = this.machine;
    cx.spawn(async cx => {
      try {
        const catalog = await workflow("models", { machine });
        if (generation === this.generation) this.catalog = catalog;
      } catch (error) {
        if (generation === this.generation) this.catalog = { models: [], error: String(error) };
      }
      cx.notify();
    });
  }

  // Opened as a dock where the layout has no side panel; otherwise a side panel section.
  docked() { return Boolean(props()?.overlay); }

  close() { if (this.docked()) closeOverlay(props().overlay); }

  choices() {
    return this.picking?.field === "thinking"
      ? thinkingLevels
      : modelChoices(this.catalog, this.query, this.picking?.field === "fallbackModel");
  }

  choose(choice, cx) {
    const picker = this.picking;
    if (!picker || this.saving) return;
    const profile = this.config?.profiles.find(profile => profile.id === picker.profile);
    if (!profile) return;
    const args = { profile: profile.id, model: profile.model, [picker.field]: choice.id };
    this.saving = true;
    this.saves += 1;
    this.picking = null;
    this.error = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.config = await workflow("set", args);
      } catch (error) { this.error = String(error); }
      this.saving = false;
      cx.notify();
    });
  }

  field(t, profile, field, label) {
    const thinking = field === "thinking";
    const fallback = field === "fallbackModel";
    const value = profile[field];
    const open = this.picking?.profile === profile.id && this.picking?.field === field;
    const available = thinking || !value || this.catalog?.models?.some(model => model.id === value);
    const enabled = !this.loading && !this.saving && (thinking || fallback || (this.catalog?.models?.length ?? 0) > 0);
    const name = thinking
      ? thinkingLevels.find(level => level.id === value)?.name ?? value
      : currentModelLabel(this.catalog, value, fallback);
    return v_flex().w_full().min_w(0).gap(4)
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().w(56).flex_none().text_size(11).text_color(t.dim).child(label))
        .child(h_flex().id(`wf-${profile.id}-${field}`).flex_1().min_w(0).h(26).px(7).gap(6).items_center()
          .rounded(4).border_1().border_color(open ? t.accent : t.border).bg(t.raised)
          .text_color(enabled ? t.foreground : t.dim).tooltip(value ?? "No fallback")
          .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
            this.picking = open ? null : { profile: profile.id, field };
            this.machinePicker = false;
            this.query = ""; this.at = 0; this.input.set_value("");
            if (this.picking && thinking) {
              this.at = Math.max(0, thinkingLevels.findIndex(level => level.id === value));
              this.handle.focus();
            } else if (this.picking) this.input.focus();
            else this.handle.focus();
            cx.notify();
          }))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(name))
          .child(svg(icon(open ? "chevron-right" : "chevron-down")).size(11).flex_none())))
      .when(Boolean(value && !available && this.catalog), el => el.child(div().pl(64).text_size(10).text_color(t.dim)
        .child("Not in this machine's Pi picker")))
      .when(open, el => el.child(this.modelPicker(t)));
  }

  modelPicker(t) {
    const thinking = this.picking?.field === "thinking";
    const choices = this.choices();
    const rowHeight = thinking ? 26 : 38;
    return v_flex().w_full().min_w(0).flex_none().rounded(4).border_1().border_color(t.border).bg(t.background)
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .when(!thinking, el => el.child(div().px(6).py(4).flex_none().border_b(1).border_color(t.border)
        .child(Input.new(this.input).h(22).text_size(11.5).text_color(t.foreground))))
      .child(div().h(Math.min(180, Math.max(32, choices.length * rowHeight + 6))).flex_none().relative()
        .child(v_flex().id("wf-model-list").absolute().inset_0().overflow_y_scroll().p(3).pr(10)
          .when(choices.length === 0, el => el.child(div().p(5).text_size(11).line_height("15px").text_color(t.dim).child("No matching models")))
          .children(choices.map((choice, index) => v_flex().id(`wf-model-${index}`).h(rowHeight).flex_none().px(6).py(3).gap(1).justify_center().rounded(3).min_w(0)
            .when(index === this.at, el => el.bg(t.hover))
            .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.choose(choice, cx))
            .child(div().truncate().text_size(11.5).line_height("15px").text_color(t.foreground).child(choice.name))
            .when(Boolean(choice.id && !thinking), el => el.child(div().truncate().text_size(10).line_height("12px").text_color(t.dim).tooltip(choice.id).child(choice.id))))))
        .child(Scrollbar.vertical("wf-model-list").mode("always").absolute().inset_0()));
  }

  machineField(t) {
    const choices = [{ name: "", label: "This computer" }, ...machines().filter(machine => typeof machine.name === "string" && machine.name).map(machine => ({ name: machine.name, label: machine.name, state: machine.layout === "ready" ? "connected" : machine.layout }))];
    const enabled = !this.saving;
    return v_flex().w_full().min_w(0).gap(4)
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().w(56).flex_none().text_size(11).text_color(t.dim).tooltip("Machine providing the live Pi model catalog").child("Models"))
        .child(h_flex().id("wf-machine").flex_1().min_w(0).h(26).px(7).gap(6).items_center().rounded(4).border_1().border_color(t.border)
          .bg(t.raised).text_size(12).text_color(enabled ? t.foreground : t.dim)
          .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { this.machinePicker = !this.machinePicker; this.picking = null; this.handle.focus(); cx.notify(); }))
          .child(svg(icon("server")).size(12).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(this.machine || "This computer"))
          .child(svg(icon("chevron-down")).size(11).flex_none())))
      .when(this.machinePicker, el => el.child(div().h(Math.min(156, choices.length * 26 + 6)).flex_none().relative().rounded(4).border_1().border_color(t.border).bg(t.background)
        .child(v_flex().id("wf-machine-list").absolute().inset_0().overflow_y_scroll().p(3).pr(10)
          .children(choices.map(machine => div().id(`wf-machine-${machine.name || "local"}`).h(26).flex_none().px(6).flex().items_center().rounded(3).text_size(11.5)
            .text_color(machine.state && machine.state !== "connected" ? t.dim : t.foreground)
            .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
              if (this.saving) return;
              this.machine = machine.name; this.machineChosen = true; this.catalog = null; this.machinePicker = false; this.loadCatalog(cx); cx.notify();
            }).child(div().min_w(0).truncate().child(machine.label + (machine.state && machine.state !== "connected" ? ` · ${machine.state}` : ""))))))
        .child(Scrollbar.vertical("wf-machine-list").mode("always").absolute().inset_0())));
  }

  render() {
    const t = theme();
    const choices = this.choices();
    const installationError = this.catalog?.installation?.error;
    const docked = this.docked();
    const body = v_flex().w_full().min_w(0).px(docked ? 12 : 16).pt(docked ? 6 : 2).pb(docked ? 12 : 4).gap(18)
      .child(this.machineField(t))
      .when(Boolean(this.error), el => el.child(div().text_size(11).line_height("16px").text_color(t.foreground).child(this.error)))
      .when(Boolean(this.catalog?.error), el => el.child(div().text_size(10.5).line_height("15px").text_color(t.muted).child(this.catalog.error)))
      .when(Boolean(installationError), el => el.child(div().text_size(10.5).line_height("15px").text_color(t.muted).child(`Extension installation failed: ${installationError}`)))
      .when(this.loading, el => el.child(div().text_size(11).text_color(t.dim).child("Loading profiles…")))
      .children((this.config?.profiles ?? []).map(profile => v_flex().w_full().min_w(0).gap(6)
        .child(div().pb(2).text_size(12).font_semibold().child(profile.name))
        .child(this.field(t, profile, "model", "Primary"))
        .child(this.field(t, profile, "fallbackModel", "Fallback"))
        .child(this.field(t, profile, "thinking", "Thinking"))));
    const root = v_flex().id("workflow-settings").track_focus(this.handle).w_full().min_w(0).text_color(t.foreground).text_size(12)
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          if (this.picking || this.machinePicker) { this.picking = null; this.machinePicker = false; this.handle.focus(); cx.notify(); }
          else this.close();
          cx.stop_propagation();
        } else if (this.picking && choices.length && ["up", "down"].includes(event.key)) {
          this.at = (this.at + (event.key === "down" ? 1 : choices.length - 1)) % choices.length;
          cx.stop_propagation(); cx.notify();
        } else if (this.picking?.field === "thinking" && event.key === "enter") {
          const choice = choices[this.at];
          if (choice) this.choose(choice, cx);
          cx.stop_propagation();
        }
      });
    // In the side panel the section is as tall as its fields; the panel scrolls and titles it.
    if (!docked) return root.child(body);
    return root.size_full().min_h(0).bg(t.chrome).border_l(1).border_color(t.border)
      .child(h_flex().h(32).px(12).gap(7).items_center().flex_none()
        .child(svg(icon("layers")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().text_size(12).font_semibold().child("Workflow"))
        .when(this.saving, el => el.child(div().text_size(10).text_color(t.dim).child("Saving…")))
        .child(div().id("wf-close").size(22).flex_none().rounded(4).flex().items_center().justify_center().text_color(t.muted)
          .cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Close · Esc").on_click(() => this.close())
          .child(svg(icon("x")).size(12))))
      .child(div().flex_1().min_h(0).relative()
        .child(div().id("workflow-content").absolute().inset_0().overflow_y_scroll().child(body))
        .child(Scrollbar.vertical("workflow-content").mode("always").absolute().inset_0()));
  }
}
