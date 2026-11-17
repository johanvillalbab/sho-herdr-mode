import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { spaces, theme } from "herdr";

// A note and a to-do list per project. Projects are the person's own, not tied to a space,
// so closing a space never hides a note. The header picks, adds, renames and deletes them.
const icon = (name) => `mods/craft-notes/icons/${name}.svg`;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

export default class Notes extends View {
  init(_props, _cx) {
    this.projects = load("projects", null); // [{ id, name }]
    this.notes = load("pnotes", {}); // projectId -> text
    this.todos = load("ptodos", {}); // projectId -> [{ id, text, done }]
    if (!Array.isArray(this.projects)) this.migrate();
    if (!this.projects.length) this.projects.push({ id: newId(), name: "General" });
    const last = localStorage.getItem("project");
    this.project = this.projects.some((p) => p.id === last) ? last : this.projects[0].id;
    this.persist();

    this.view = localStorage.getItem("view") === "todo" ? "todo" : "notes";
    this.picking = false; // the project list replaces the body
    this.renaming = null; // the project whose name is being edited
    this.deleting = null; // the project asking to confirm its deletion
    this.hover = null; // the row under the pointer, which shows its actions

    this.input = TextareaState.new({ placeholder: "Write a note…", value: this.note() });
    this.input.on("change", () => this.saveNote(this.input.value()));

    this.adding = false;
    this.draft = InputState.new({ placeholder: "Add a to-do…" });
    this.draft.on("submit", (_e, cx) => {
      const text = this.draft.value().trim();
      if (!text) return;
      this.setTodos([...this.items(), { id: newId(), text, done: false }]);
      this.draft.set_value("");
      cx.notify();
    });
    this.draft.on("focus", (_e, cx) => { this.adding = true; cx.notify(); });
    this.draft.on("blur", (_e, cx) => { this.adding = false; cx.notify(); });

    this.naming = false;
    this.newProject = InputState.new({ placeholder: "New project…" });
    this.newProject.on("submit", (_e, cx) => {
      const name = this.newProject.value().trim();
      if (!name) return;
      this.newProject.set_value("");
      this.create(name);
      cx.notify();
    });
    this.newProject.on("focus", (_e, cx) => { this.naming = true; cx.notify(); });
    this.newProject.on("blur", (_e, cx) => { this.naming = false; cx.notify(); });

    this.rename = InputState.new({ placeholder: "Project name" });
    this.rename.on("submit", (_e, cx) => { this.commitRename(); cx.notify(); });
    this.rename.on("blur", (_e, cx) => { this.commitRename(); cx.notify(); });
  }

  // Notes used to belong to spaces. Each old space's note and to-dos become a project, named
  // after the space while it's still open. The old keys stay untouched.
  migrate() {
    const oldNotes = load("notes", {}), oldTodos = load("todos", {});
    const open = new Map(spaces().map((s) => [s.id, s.name]));
    this.projects = [];
    let recovered = 0;
    for (const sid of new Set([...Object.keys(oldNotes), ...Object.keys(oldTodos)])) {
      const id = newId();
      const name = open.get(sid) ?? (++recovered === 1 ? "Recovered notes" : `Recovered notes ${recovered}`);
      this.projects.push({ id, name });
      if (oldNotes[sid]) this.notes[id] = oldNotes[sid];
      if (oldTodos[sid]?.length) this.todos[id] = oldTodos[sid];
    }
  }

  persist() {
    localStorage.setItem("projects", JSON.stringify(this.projects));
    localStorage.setItem("pnotes", JSON.stringify(this.notes));
    localStorage.setItem("ptodos", JSON.stringify(this.todos));
    localStorage.setItem("project", this.project);
  }

  current() { return this.projects.find((p) => p.id === this.project) ?? this.projects[0]; }

  note() { return this.notes[this.project] ?? ""; }

  saveNote(text) {
    if (this.note() === text) return;
    if (text) this.notes[this.project] = text; else delete this.notes[this.project];
    this.persist();
  }

  items() { return this.todos[this.project] ?? []; }

  setTodos(list) {
    if (list.length) this.todos[this.project] = list; else delete this.todos[this.project];
    this.persist();
  }

  toggle(item) { this.setTodos(this.items().map((x) => (x.id === item.id ? { ...x, done: !x.done } : x))); }

  removeTodo(item) {
    this.setTodos(this.items().filter((x) => x.id !== item.id));
    if (this.hover === item.id) this.hover = null;
  }

  show(view) {
    this.view = view;
    this.closePicker();
    localStorage.setItem("view", view);
    if (view === "todo") this.draft.focus();
  }

  openPicker() {
    this.picking = true;
    this.renaming = null;
    this.deleting = null;
  }

  closePicker() {
    this.picking = false;
    this.renaming = null;
    this.deleting = null;
  }

  select(id) {
    this.project = id;
    this.input.set_value(this.note());
    this.persist();
    this.closePicker();
  }

  create(name) {
    const p = { id: newId(), name };
    this.projects.push(p);
    this.select(p.id);
    if (this.view === "notes") this.input.focus(); else this.draft.focus();
  }

  startRename(p) {
    this.deleting = null;
    this.renaming = p.id;
    this.rename.set_value(p.name);
    this.rename.focus();
  }

  // Enter and leaving the field both keep the new name; an empty one keeps the old.
  commitRename() {
    const id = this.renaming;
    if (id == null) return;
    this.renaming = null;
    const name = this.rename.value().trim();
    const p = this.projects.find((x) => x.id === id);
    if (p && name && name !== p.name) { p.name = name; this.persist(); }
  }

  removeProject(id) {
    this.projects = this.projects.filter((p) => p.id !== id);
    delete this.notes[id];
    delete this.todos[id];
    this.deleting = null;
    if (!this.projects.length) this.projects.push({ id: newId(), name: "General" });
    if (this.project === id) {
      this.project = this.projects[0].id;
      this.input.set_value(this.note());
    }
    this.persist();
  }

  // A small icon button that shows on a hovered row, in a slot that keeps the text still.
  action(t, id, name, tip, run) {
    return h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(5)
      .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx); cx.notify(); })
      .child(svg(icon(name)).size(12));
  }

  textButton(t, id, label, color, run) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(12).text_color(color)
      .hover((s) => s.bg(t.raised))
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx); cx.notify(); })
      .child(label);
  }

  // Notes and To-do switch like the top bar's panel buttons.
  switcher(t, id, label, count) {
    const on = this.view === id && !this.picking;
    return h_flex().id(`view-${id}`).h(26).px(8).gap(6).flex_none().items_center().rounded(6).text_size(12.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium())
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.show(id); cx.notify(); })
      .child(label)
      .when(Boolean(count), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(count))));
  }

  projectButton(t) {
    return h_flex().flex_1().min_w(0).child(
      h_flex().id("project").h(26).min_w(0).pl(8).pr(6).gap(5).items_center().rounded(6).text_size(12.5).font_medium()
        .bg(this.picking ? t.selected : t.background).text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (this.picking) this.closePicker(); else this.openPicker(); cx.notify(); })
        .child(div().min_w(0).truncate().child(this.current().name))
        .child(svg(icon("caret-down")).size(12).flex_none().text_color(t.dim)));
  }

  projectRow(t, p) {
    if (this.renaming === p.id) {
      return h_flex().id(`rename-${p.id}`).h(32).px(10).items_center().rounded(8).border_1().border_color(t.accent).cursor_text()
        .child(Input.new(this.rename).flex_1().h_full().text_size(13).text_color(t.foreground));
    }
    if (this.deleting === p.id) {
      return h_flex().id(`delete-${p.id}`).h(32).pl(10).pr(4).gap(2).items_center().rounded(8).bg(t.hover)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`Delete “${p.name}”?`))
        .child(this.textButton(t, `delete-no-${p.id}`, "Cancel", t.muted, () => { this.deleting = null; }))
        .child(this.textButton(t, `delete-yes-${p.id}`, "Delete", t.blocked, () => this.removeProject(p.id)));
    }
    const current = p.id === this.project;
    const hovered = this.hover === p.id;
    const open = (this.todos[p.id] ?? []).filter((x) => !x.done).length;
    return h_flex().id(`project-${p.id}`).h(32).px(6).gap(8).items_center().rounded(8)
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hover = p.id; else if (this.hover === p.id) this.hover = null;
        cx.notify();
      })
      .on_click((_e, cx) => { this.select(p.id); cx.notify(); })
      .child(h_flex().w(14).flex_none().justify_center()
        .when(current, (el) => el.child(svg(icon("check")).size(11).text_color(t.accent))))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(current ? t.foreground : t.muted)
        .when(current, (el) => el.font_medium()).child(p.name))
      .child(h_flex().w(44).h(20).flex_none().items_center().justify_end().gap(4)
        .when(!hovered && open > 0, (el) => el.child(div().pr(4).text_size(11.5).text_color(t.dim).child(String(open))))
        .when(hovered, (el) => el.child(this.action(t, `rename-btn-${p.id}`, "pencil", "Rename", () => this.startRename(p))))
        .when(hovered && this.projects.length > 1, (el) => el.child(
          this.action(t, `delete-btn-${p.id}`, "trash", "Delete", () => { this.renaming = null; this.deleting = p.id; }))));
  }

  pickerView(t) {
    return v_flex().id("projects").flex_1().min_h(0)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (this.renaming != null) this.renaming = null;
        else if (this.deleting != null) this.deleting = null;
        else this.closePicker();
        cx.notify();
      })
      .child(h_flex().id("project-add").mx(14).mt(12).h(34).px(10).gap(8).flex_none().items_center().rounded(8).border_1()
        .border_color(this.naming ? t.accent : t.border).cursor_text()
        .child(svg(icon("plus")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.newProject).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(div().px(14).pt(14).pb(4).text_size(11.5).text_color(t.dim).child("Projects"))
      .child(v_flex().id("project-list").flex_1().min_h(0).px(8).pb(10).overflow_y_scrollbar()
        .children(this.projects.map((p) => this.projectRow(t, p))));
  }

  box(t, done) {
    return h_flex().size(16).mt(2).flex_none().items_center().justify_center().rounded(5).border_1()
      .border_color(done ? t.solid : t.input).bg(done ? t.solid : t.background)
      .when(done, (el) => el.child(svg(icon("check")).size(10).text_color(t.solid_foreground)));
  }

  // A row toggles on click; delete shows on hover.
  todo(t, item) {
    const hovered = this.hover === item.id;
    return h_flex().id(`todo-${item.id}`).px(6).py(5).gap(10).items_start().rounded(8)
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hover = item.id; else if (this.hover === item.id) this.hover = null;
        cx.notify();
      })
      .on_click((_e, cx) => { this.toggle(item); cx.notify(); })
      .child(this.box(t, item.done))
      .child(div().flex_1().min_w(0).text_size(13).text_color(item.done ? t.dim : t.foreground).when(item.done, (el) => el.line_through()).child(item.text))
      .child(h_flex().w(20).h(20).flex_none().justify_end()
        .when(hovered, (el) => el.child(this.action(t, `todo-remove-${item.id}`, "x", "Delete", () => this.removeTodo(item)))));
  }

  todoView(t) {
    const items = this.items();
    const open = items.filter((x) => !x.done), done = items.filter((x) => x.done);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().id("todo-add").mx(14).mt(12).h(34).px(10).gap(8).flex_none().items_center().rounded(8).border_1()
        .border_color(this.adding ? t.accent : t.border).cursor_text()
        .child(svg(icon("plus")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.draft).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("todo-list").flex_1().min_h(0).px(8).pt(8).pb(10).overflow_y_scrollbar()
        .when(!items.length, (el) => el.child(div().px(6).py(5).text_size(12).text_color(t.dim).child("No to-dos yet")))
        .children(open.map((x) => this.todo(t, x)))
        .when(done.length > 0, (el) => el
          .child(h_flex().px(6).pt(open.length ? 12 : 4).pb(4).items_center()
            .child(div().flex_1().text_size(11.5).text_color(t.dim).child(`Done ${done.length}`))
            .child(div().id("todo-clear").h(20).px(6).flex().items_center().rounded(5).text_size(11.5).text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { this.setTodos(open); cx.notify(); })
              .child("Clear")))
          .children(done.map((x) => this.todo(t, x)))));
  }

  render(_cx) {
    const t = theme();
    const notes = this.view === "notes";
    return v_flex().id("notes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
        .child(this.projectButton(t))
        .child(this.switcher(t, "notes", "Notes"))
        .child(this.switcher(t, "todo", "To-do", this.items().filter((x) => !x.done).length)))
      .when(this.picking, (el) => el.child(this.pickerView(t)))
      .when(!this.picking && notes, (el) => el.child(div().id("notes-body").flex_1().min_h(0).px(14).py(12)
        .child(Textarea.new(this.input).size_full().text_size(13).text_color(t.foreground))))
      .when(!this.picking && !notes, (el) => el.child(this.todoView(t)));
  }
}
