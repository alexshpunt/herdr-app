import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { workflow, machines, theme, props, closeOverlay } from "herdr";
import { modelChoices, currentModelLabel } from "./models.js";

const icon = name => `mods/workspace-chrome/${name}.svg`;

export default class Workflow extends View {
  init(_props, cx) {
    this.config = null;
    this.catalog = null;
    this.machine = props()?.machine ?? "";
    this.loading = true;
    this.saving = false;
    this.error = null;
    this.notice = null;
    this.picking = null;
    this.machinePicker = false;
    this.query = "";
    this.at = 0;
    this.generation = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "Search models" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => {
      const choice = this.choices()[this.at];
      if (choice) this.choose(choice, cx);
    });
    this.refresh(cx);
    cx.timer.every(4000, (cx) => { if (!this.loading && !this.saving) this.loadCatalog(cx); });
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

  loadCatalog(cx) {
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

  close() { closeOverlay(props().overlay); }

  choices() {
    return modelChoices(this.catalog, this.query, this.picking?.field === "fallbackModel");
  }

  choose(choice, cx) {
    const picker = this.picking;
    if (!picker || this.saving) return;
    const profile = this.config?.profiles.find(profile => profile.id === picker.profile);
    if (!profile) return;
    const args = { profile: profile.id, model: profile.model, [picker.field]: choice.id };
    this.saving = true;
    this.picking = null;
    this.error = null;
    this.notice = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.config = await workflow("set", args);
        this.notice = `${profile.name} saved`;
      } catch (error) { this.error = String(error); }
      this.saving = false;
      cx.notify();
    });
  }

  button(t, id, text, action) {
    return div().id(id).px(10).py(6).rounded(7).border_1().border_color(t.border)
      .bg(t.raised).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover)).on_click(action).child(text);
  }

  field(t, profile, field, label, cx) {
    const fallback = field === "fallbackModel";
    const value = profile[field];
    const open = this.picking?.profile === profile.id && this.picking?.field === field;
    const available = !value || this.catalog?.models?.some(model => model.id === value);
    const enabled = !this.loading && !this.saving && (fallback || (this.catalog?.models?.length ?? 0) > 0);
    return v_flex().w_full().gap(6)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(h_flex().id(`wf-${profile.id}-${field}`).w_full().min_w(0).px(11).py(9).gap(8).items_center()
        .rounded(8).border_1().border_color(open ? t.accent : t.border).bg(t.raised)
        .text_color(enabled ? t.foreground : t.dim)
        .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
          this.picking = open ? null : { profile: profile.id, field };
          this.machinePicker = false;
          this.query = ""; this.at = 0; this.input.set_value("");
          if (this.picking) this.input.focus(); else this.handle.focus();
          cx.notify();
        }))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(13).tooltip(value ?? "No fallback").child(currentModelLabel(this.catalog, value, fallback)))
          .when(Boolean(value && available), el => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(value))))
        .child(svg(icon(open ? "chevron-right" : "chevron-down")).size(13).flex_none()))
      .when(Boolean(value && !available && this.catalog), el => el.child(div().text_size(11).text_color(t.dim)
        .child("Configured model is not in this machine's current Pi picker.")))
      .when(open, el => el.child(this.modelPicker(t, cx)));
  }

  modelPicker(t, cx) {
    const choices = this.choices();
    return v_flex().w_full().min_h(0).rounded(8).border_1().border_color(t.border).bg(t.background)
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(div().px(10).py(7).border_b(1).border_color(t.border)
        .child(Input.new(this.input).h(28).text_size(12.5).text_color(t.foreground)))
      .child(div().h(Math.min(220, Math.max(44, choices.length * 50 + 8))).flex_none().relative()
        .child(v_flex().id("wf-model-list").absolute().inset_0().overflow_y_scroll().p(4)
          .when(choices.length === 0, el => el.child(div().p(10).text_size(12).text_color(t.dim).child("No matching models")))
          .children(choices.map((model, index) => v_flex().id(`wf-model-${index}`).h(50).flex_none().px(8).py(7).gap(2).rounded(5).min_w(0)
            .when(index === this.at, el => el.bg(t.hover))
            .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.choose(model, cx))
            .child(div().truncate().text_size(12.5).text_color(t.foreground).child(model.name))
            .when(Boolean(model.id), el => el.child(div().truncate().text_size(10.5).text_color(t.dim).tooltip(model.id).child(model.id))))))
        .child(Scrollbar.vertical("wf-model-list").absolute().inset_0()));
  }

  machineField(t) {
    const choices = [{ name: "", label: "This computer" }, ...machines().filter(machine => typeof machine.name === "string" && machine.name).map(machine => ({ name: machine.name, label: machine.name, state: machine.layout === "ready" ? "connected" : machine.layout }))];
    return v_flex().w_full().gap(6)
      .child(div().text_size(12).text_color(t.muted).child("Model catalog from"))
      .child(h_flex().id("wf-machine").px(11).py(9).gap(8).items_center().rounded(8).border_1().border_color(t.border)
        .bg(t.raised).text_size(13).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.machinePicker = !this.machinePicker; this.picking = null; cx.notify(); })
        .child(svg(icon("server")).size(14).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(this.machine || "This computer"))
        .child(svg(icon("chevron-down")).size(13)))
      .when(this.machinePicker, el => el.child(v_flex().w_full().p(4).rounded(8).border_1().border_color(t.border).bg(t.background)
        .children(choices.map(machine => div().id(`wf-machine-${machine.name || "local"}`).px(8).py(7).rounded(5).text_size(12.5)
          .text_color(machine.state && machine.state !== "connected" ? t.dim : t.foreground)
          .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
            this.machine = machine.name; this.catalog = null; this.machinePicker = false; this.loadCatalog(cx); cx.notify();
          }).child(machine.label + (machine.state && machine.state !== "connected" ? ` · ${machine.state}` : ""))))));
  }

  render(cx) {
    const t = theme();
    const choices = this.choices();
    const installation = this.catalog?.installation;
    const installationError = installation?.error;
    return v_flex().id("workflow-settings").track_focus(this.handle).size_full().min_h(0).bg(t.popover)
      .border_l(1).border_color(t.border).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          if (this.picking || this.machinePicker) { this.picking = null; this.machinePicker = false; this.handle.focus(); cx.notify(); }
          else this.close();
          cx.stop_propagation();
        } else if (this.picking && choices.length && ["up", "down"].includes(event.key)) {
          this.at = (this.at + (event.key === "down" ? 1 : choices.length - 1)) % choices.length;
          cx.stop_propagation(); cx.notify();
        }
      })
      .child(h_flex().px(22).pt(23).pb(18).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
        .child(svg(icon("layers")).size(19).text_color(t.accent))
        .child(v_flex().flex_1().gap(3).child(div().text_size(19).font_semibold().child("Workflow"))
          .child(div().text_size(12).text_color(t.dim).child("Models for new agents")))
        .child(div().id("wf-close").size(28).rounded(6).flex().items_center().justify_center().text_color(t.muted)
          .cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Close · Esc").on_click(() => this.close())
          .child(svg(icon("x")).size(16))))
      .child(div().flex_1().min_h(0).relative()
        .child(div().id("workflow-content").absolute().inset_0().overflow_y_scroll()
          .child(v_flex().w_full().px(22).py(20).gap(22)
            .child(v_flex().gap(10).child(this.machineField(t))
              .child(div().text_size(11.5).line_height("17px").text_color(t.dim).child("Choices come from a running Pi on this machine. Profiles are shared across machines.")))
            .when(Boolean(this.catalog?.error), el => el.child(div().p(11).rounded(8).bg(t.raised).text_size(12).line_height("17px").text_color(t.muted).child(this.catalog.error)))
            .when(Boolean(installationError), el => el.child(div().text_size(12).text_color(t.muted).child(`Extension installation failed: ${installationError}`)))
            .when(this.loading, el => el.child(div().text_size(13).text_color(t.dim).child("Loading workflow profiles…")))
            .children((this.config?.profiles ?? []).map(profile => v_flex().w_full().gap(14)
              .child(h_flex().items_center().gap(8).child(div().flex_1().text_size(15).font_semibold().child(profile.name))
                .child(div().text_size(10.5).text_color(t.dim).child(`Thinking: ${profile.thinking}`)))
              .child(this.field(t, profile, "model", "Primary model", cx))
              .child(this.field(t, profile, "fallbackModel", "Fallback model", cx))
              .child(div().border_b(1).border_color(t.border).pt(6))))
            .child(div().text_size(12).line_height("18px").text_color(t.dim)
              .child("Fallback is used only when startup fails, before the first successful assistant response. Running agents keep their model."))))
        .child(Scrollbar.vertical("workflow-content").absolute().inset_0()))
      .child(v_flex().px(22).py(15).gap(9).flex_none().border_t(1).border_color(t.border)
        .when(Boolean(this.error), el => el.child(div().text_size(12).line_height("17px").text_color(t.foreground).child(this.error)))
        .child(h_flex().items_center().gap(10)
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.saving ? "Saving…" : this.notice ?? "Changes save automatically"))
          .child(this.button(t, "wf-refresh", "Refresh", (_e, cx) => this.refresh(cx)))));
  }
}
