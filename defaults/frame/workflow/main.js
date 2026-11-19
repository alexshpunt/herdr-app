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
    this.input = InputState.new({ placeholder: "Search or enter provider/model" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => {
      const choice = this.choices()[this.at];
      if (choice) this.choose(choice, cx);
    });
    // One text field edits a profile's name or description in place, or names a new profile.
    this.editing = null; // { profile, field: "name" | "description" } or { field: "new" }
    this.removing = null; // id of the profile whose removal waits for confirmation
    this.textFocused = false;
    // A placeholder belongs to its state, so each kind of field has its own.
    this.texts = {
      name: InputState.new({ placeholder: "Profile name" }),
      description: InputState.new({ placeholder: "When to use this profile" }),
      new: InputState.new({ placeholder: "Profile name, such as Reviews" }),
    };
    for (const [field, text] of Object.entries(this.texts)) {
      text.on("submit", (_e, cx) => { if (this.editing?.field === field) this.finishEdit(cx); });
      text.on("focus", (_e, cx) => { this.textFocused = true; cx.notify(); });
      // Leaving the field keeps what was typed, as the other fields save on selection.
      text.on("blur", (_e, cx) => {
        this.textFocused = false;
        if (this.editing?.field === field) this.finishEdit(cx); else cx.notify();
      });
    }
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
    this.picking = null;
    this.handle.focus();
    this.save("set", { profile: profile.id, [picker.field]: choice.id }, cx);
  }

  // Every change goes through the app, which answers with the whole saved table.
  // Changes run in order: an edit committed while another saves is not lost.
  save(action, args, cx, then) {
    this.pending = (this.pending ?? 0) + 1;
    this.saving = true;
    this.saves += 1;
    this.error = null;
    const previous = this.queue ?? Promise.resolve();
    this.queue = new Promise(done => cx.spawn(async cx => {
      await previous;
      try {
        this.config = await workflow(action, args);
        then?.(cx);
      } catch (error) { this.error = String(error); }
      this.pending -= 1;
      this.saving = this.pending > 0;
      cx.notify();
      done();
    }));
    cx.notify();
  }

  edit(editing, value, cx) {
    // Moving to another field keeps what the first one got.
    if (this.editing) this.finishEdit(cx);
    this.editing = editing;
    this.picking = null;
    this.machinePicker = false;
    this.removing = null;
    const text = this.texts[editing.field];
    text.set_value(value);
    if (value) text.set_selected_range({ start: 0, end: value.length });
    text.focus();
    cx.notify();
  }

  cancelEdit(cx) {
    this.editing = null;
    this.handle.focus();
    cx.notify();
  }

  finishEdit(cx) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const value = this.texts[editing.field].value().trim();
    this.handle.focus();
    if (editing.field === "new") { if (value) this.addProfile(value, cx); else cx.notify(); return; }
    const profile = this.config?.profiles.find(profile => profile.id === editing.profile);
    // An emptied name keeps the old one; an emptied description clears it.
    if (!profile || value === (profile[editing.field] ?? "") || (editing.field === "name" && !value)) { cx.notify(); return; }
    this.save("set", { profile: profile.id, [editing.field]: value }, cx);
  }

  // The id follows the name in lowercase kebab-case and stays unique.
  newId(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
    const taken = new Set((this.config?.profiles ?? []).map(profile => profile.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  addProfile(name, cx) {
    // Start from a model this machine offers, else from an existing profile's; the picker opens to change it.
    const model = this.catalog?.models?.[0]?.id ?? this.config?.profiles?.[0]?.model;
    if (!model) { this.error = "No Pi model is known on this machine yet, so the new profile has nothing to start with. Start or reload Pi here, then add it again."; cx.notify(); return; }
    const id = this.newId(name);
    this.save("add", { id, name, model }, cx, () => {
      this.picking = { profile: id, field: "model" };
      this.query = ""; this.at = 0; this.input.set_value("");
      this.input.focus();
    });
  }

  removeProfile(profile, cx) {
    this.removing = null;
    this.handle.focus();
    this.save("remove", { profile: profile.id }, cx);
  }

  field(t, profile, field, label) {
    const thinking = field === "thinking";
    const fallback = field === "fallbackModel";
    const value = profile[field];
    const open = this.picking?.profile === profile.id && this.picking?.field === field;
    const available = thinking || !value || this.catalog?.models?.some(model => model.id === value);
    const enabled = !this.loading && !this.saving;
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
        .child("Not in this catalog; checked when the agent starts")))
      .when(open, el => el.child(this.modelPicker(t)));
  }

  // The in-place text field, styled like the pickers' buttons.
  textField(t, field) {
    return Input.new(this.texts[field]).w_full().min_w(0).h(26).px(7).rounded(4).border_1()
      .border_color(this.textFocused ? t.accent : t.border).bg(t.raised).text_size(12).text_color(t.foreground);
  }

  smallButton(t, id, label, onClick, danger) {
    return div().id(id).h(24).px(9).flex().items_center().flex_none().rounded(4).border_1().border_color(t.border).bg(t.raised)
      .text_size(11.5).text_color(danger ? t.blocked : t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click(onClick).child(label);
  }

  profile(t, profile) {
    const editing = field => this.editing?.profile === profile.id && this.editing?.field === field;
    const removing = this.removing === profile.id;
    const enabled = !this.loading;
    const header = editing("name")
      ? h_flex().id(`wf-${profile.id}-name-input`).w_full().min_w(0).child(this.textField(t, "name"))
      : h_flex().w_full().min_w(0).h(20).gap(4).items_center()
        .child(div().id(`wf-${profile.id}-name`).flex_1().min_w(0).truncate().text_size(12).font_semibold().tooltip(`Rename · id ${profile.id}`)
          .when(enabled, el => el.cursor_text().on_click((_e, cx) => this.edit({ profile: profile.id, field: "name" }, profile.name, cx)))
          .child(profile.name))
        .child(div().id(`wf-${profile.id}-remove`).size(20).flex_none().rounded(4).flex().items_center().justify_center()
          .text_color(removing ? t.foreground : t.dim).when(removing, el => el.bg(t.hover))
          .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.removing = removing ? null : profile.id; this.picking = null; this.handle.focus(); cx.notify(); }))
          .tooltip("Remove profile")
          .child(svg(icon("x")).size(11)));
    const description = editing("description")
      ? h_flex().id(`wf-${profile.id}-description-input`).w_full().min_w(0).child(this.textField(t, "description"))
      : div().id(`wf-${profile.id}-description`).w_full().min_w(0).text_size(11).line_height("15px")
        .text_color(profile.description ? t.muted : t.dim)
        .when(enabled, el => el.cursor_text().hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.edit({ profile: profile.id, field: "description" }, profile.description ?? "", cx)))
        .tooltip("Agents read this to choose a profile")
        .child(profile.description || "Add when to use it");
    return v_flex().w_full().min_w(0).gap(6)
      .child(v_flex().w_full().min_w(0).gap(2).child(header).child(description))
      .when(removing, el => el.child(v_flex().w_full().min_w(0).gap(8).p(8).rounded(4).border_1().border_color(t.border).bg(t.background)
        .child(div().text_size(11).line_height("15px").text_color(t.muted)
          .child(`Remove ${profile.name}? Agents already started with it keep their model.`))
        .child(h_flex().gap(6).justify_end()
          .child(this.smallButton(t, `wf-${profile.id}-remove-cancel`, "Cancel", (_e, cx) => { this.removing = null; cx.notify(); }))
          .child(this.smallButton(t, `wf-${profile.id}-remove-confirm`, "Remove", (_e, cx) => this.removeProfile(profile, cx), true)))))
      .child(this.field(t, profile, "model", "Primary"))
      .child(this.field(t, profile, "fallbackModel", "Fallback"))
      .child(this.field(t, profile, "thinking", "Thinking"));
  }

  addControl(t) {
    if (this.editing?.field === "new") return v_flex().id("wf-new").w_full().min_w(0).gap(4)
      .child(this.textField(t, "new"))
      .child(div().text_size(10).text_color(t.dim).child("Enter adds it, Esc cancels"));
    return h_flex().id("wf-add").h(26).px(7).gap(6).items_center().self_start().rounded(4).text_size(12).text_color(t.muted)
      .when(!this.loading, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.edit({ field: "new" }, "", cx)))
      .child(svg(icon("plus")).size(12).flex_none())
      .child(div().child("Add profile"));
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
          .when(choices.length === 0, el => el.child(div().p(5).text_size(11).line_height("15px").text_color(t.dim).child("No matches. Enter provider/model to use it.")))
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
        .child(div().w(56).flex_none().text_size(11).text_color(t.dim).tooltip("Machine providing Pi settings and models").child("Models"))
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
      .when(Boolean(this.catalog?.loading), el => el.child(div().text_size(10.5).text_color(t.dim).child("Reading Pi models…")))
      .when(Boolean(this.catalog?.diagnostics?.length), el => el.child(div().text_size(10.5).line_height("15px").text_color(t.muted).child(this.catalog.diagnostics.map(item => item.message).join("\n"))))
      .when(Boolean(installationError), el => el.child(div().text_size(10.5).line_height("15px").text_color(t.muted).child(`Extension installation failed: ${installationError}`)))
      .when(this.loading, el => el.child(div().text_size(11).text_color(t.dim).child("Loading profiles…")))
      .children((this.config?.profiles ?? []).map(profile => this.profile(t, profile)))
      .when(Boolean(this.config && !this.config.profiles.length), el => el.child(div().text_size(11).line_height("16px").text_color(t.dim)
        .child("No profiles yet. Agents need one to start other agents.")))
      .when(Boolean(this.config), el => el.child(this.addControl(t)));
    const root = v_flex().id("workflow-settings").track_focus(this.handle).w_full().min_w(0).text_color(t.foreground).text_size(12)
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          // Esc leaves an edit without saving it and cancels a pending removal.
          if (this.editing) this.cancelEdit(cx);
          else if (this.removing) { this.removing = null; cx.notify(); }
          else if (this.picking || this.machinePicker) { this.picking = null; this.machinePicker = false; this.handle.focus(); cx.notify(); }
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
