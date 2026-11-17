// The Spaces "+": every GitHub repo you can push to, newest push first. Enter opens a space in
// its clone on this Mac (cloning it into ~/Developer when there is none), or goes to the
// space it already has; ⌘↩ also starts Claude Code there. Type to filter, Esc to leave.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, run, exec, home, appHome, theme, props, closeOverlay, pickFolder, readTextFile } from "herdr";

// Where new clones go, under the home folder. mods/craft-repos/config.json can change it:
// { "cloneInto": "Desktop/Builder" } (see config.example.json).
const DEFAULT_CLONE_INTO = "Developer";
async function cloneInto() {
  try {
    const text = await readTextFile(`${appHome()}/mods/craft-repos/config.json`);
    return (text && JSON.parse(text).cloneInto) || DEFAULT_CLONE_INTO;
  } catch { return DEFAULT_CLONE_INTO; }
}
const CLAUDE = ["claude", "--dangerously-skip-permissions"];
const ICONS = "mods/craft-repos/icons";

const repoKey = (url) => url?.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1].toLowerCase() ?? null;
const tilde = (p) => (p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
// A clone in Graveyard is the last choice; otherwise the shallowest one.
const rank = (p) => (/\/Graveyard\//i.test(p) ? 100 : 0) + p.split("/").length;
const firstLine = (s) => (s ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
const load = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? fallback; } catch { return fallback; } };

function ago(iso) {
  const s = (Date.now() - (Date.parse(iso) || 0)) / 1000;
  if (!iso || !(s >= 0)) return "";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)}mo`;
  return `${Math.round(s / 86400 / 365)}y`;
}

export default class Repos extends View {
  init(_props, cx) {
    this.repos = load("repos", []);
    this.clones = load("clones", {}); // "owner/name" in lowercase -> its folders on this Mac
    this.asking = true;
    this.stale = false; // GitHub didn't answer, the list is the last one it gave
    this.error = null;
    this.busy = null; // the repo being cloned
    this.filter = "";
    this.at = 0;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search your repositories…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", (e, cx) => { const r = this.rows()[this.at]; cx.spawn(async (cx) => this.launch(r, Boolean(e.secondary), cx)); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => { await this.askGitHub(); cx.notify(); });
    cx.spawn(async (cx) => { await this.findClones(); cx.notify(); });
  }

  close() {
    closeOverlay(props().overlay);
  }

  async askGitHub() {
    const jq = ".[] | {full: .full_name, name, owner: .owner.login, private, fork, archived, desc: .description, pushed: .pushed_at}";
    const r = await exec("gh", ["api", "user/repos", "--paginate", "-X", "GET", "-f", "per_page=100", "-f", "sort=pushed",
      "-f", "affiliation=owner,collaborator,organization_member", "--jq", jq], { timeout: 30000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    this.asking = false;
    if (r.code !== 0) {
      this.stale = this.repos.length > 0;
      if (!this.stale) this.error = `GitHub didn't answer (${firstLine(r.stderr) || "is gh signed in?"})`;
      return;
    }
    const list = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.full);
    list.sort((a, b) => (a.archived - b.archived) || (Date.parse(b.pushed) || 0) - (Date.parse(a.pushed) || 0));
    this.repos = list;
    this.stale = false;
    localStorage.setItem("repos", JSON.stringify(list));
  }

  async findClones() {
    const r = await exec("/bin/sh", [`${appHome()}/mods/craft-repos/scan.sh`], { timeout: 30000 }).catch(() => null);
    if (r?.code !== 0) return;
    const clones = {};
    for (const line of r.stdout.split("\n")) {
      const [url, folder] = line.split("\t");
      const k = repoKey(url);
      if (k && folder) (clones[k] ??= []).push(folder);
    }
    for (const k in clones) clones[k].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    this.clones = clones;
    localStorage.setItem("clones", JSON.stringify(clones));
  }

  local(r) {
    return this.clones[r.full.toLowerCase()]?.[0] ?? null;
  }

  spaceFor(r, local) {
    const name = r.name.toLowerCase();
    return spaces().find((s) => !s.machine && ((local && s.folder === local) || s.name?.toLowerCase() === name)) ?? null;
  }

  // The owner most repos have: theirs go without the "owner/" in front.
  me() {
    const count = {};
    for (const r of this.repos) count[r.owner] = (count[r.owner] ?? 0) + 1;
    return Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  }

  rows() {
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.repos;
    const hits = this.repos.filter((r) => { const hay = `${r.full} ${r.desc ?? ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
    // Names that start with what was typed come first.
    return [...hits.filter((r) => r.name.toLowerCase().startsWith(words[0])), ...hits.filter((r) => !r.name.toLowerCase().startsWith(words[0]))];
  }

  async clone(r) {
    const base = `${home()}/${await cloneInto()}`;
    const taken = async (p) => (await exec("/bin/test", ["-e", p]).catch(() => null))?.code === 0;
    let target = `${base}/${r.name}`;
    if (await taken(target)) target = `${base}/${r.name}-${r.owner}`;
    if (await taken(target)) throw new Error(`${tilde(target)} already exists`);
    await exec("/bin/mkdir", ["-p", base]);
    const c = await exec("gh", ["repo", "clone", r.full, target], { timeout: 600000 }).catch((e) => ({ code: -1, stderr: String(e) }));
    if (c.code !== 0) throw new Error(firstLine(c.stderr) || "gh repo clone failed");
    const k = r.full.toLowerCase();
    this.clones[k] = [target, ...(this.clones[k] ?? [])];
    localStorage.setItem("clones", JSON.stringify(this.clones));
    return target;
  }

  async launch(r, claude, cx) {
    if (!r || this.busy) return;
    const local = this.local(r), space = this.spaceFor(r, local);
    if (space) {
      run("space.select", { id: space.id });
      if (claude) run("tab.new", { space: space.id, argv: CLAUDE, ...(local ? { folder: local } : {}) });
      return this.close();
    }
    let folder = local;
    if (!folder) {
      this.busy = r.full;
      this.error = null;
      cx.notify();
      try { folder = await this.clone(r); }
      catch (e) { this.busy = null; this.error = `Couldn't clone ${r.full}: ${e.message}`; cx.notify(); return; }
      this.busy = null;
    }
    run("space.new", { name: r.name, folder, machine: "", ...(claude ? { argv: CLAUDE } : {}) });
    this.close();
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.min(this.at, Math.max(0, rows.length - 1));
    const me = this.me();
    const pill = (text, strong) => h_flex().h(18).px(6).flex_none().items_center().rounded(5).text_size(10.5)
      .when(strong, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!strong, (el) => el.border_1().border_color(t.border).text_color(t.dim))
      .child(text);
    const tag = (text) => div().flex_none().text_size(10.5).text_color(t.dim).child(text);

    const row = (r, i) => {
      const on = i === this.at, local = this.local(r), space = this.spaceFor(r, local), busy = this.busy === r.full;
      const action = busy ? "Cloning…" : space ? "Go to space ↩" : local ? "Open space ↩" : "Clone and open ↩";
      return h_flex().id(`repo-${i}`).h(46).flex_none().px(10).gap(10).rounded(8).items_center().cursor_pointer()
        .when(on, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
        .when(r.archived, (el) => el.opacity(0.6))
        .on_click((e, cx) => { this.at = i; cx.spawn(async (cx) => this.launch(r, Boolean(e.modifiers?.platform), cx)); })
        .child(busy
          ? svg("mods/workspace-chrome/spinner.svg").size(15).flex_none().text_color(t.working).spin(900)
          : svg(`${ICONS}/github.svg`).size(15).flex_none().text_color(on ? t.foreground : t.dim))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(6).items_center()
            .child(h_flex().min_w(0).items_center()
              .when(r.owner !== me, (el) => el.child(div().flex_none().text_color(t.dim).child(`${r.owner}/`)))
              .child(div().truncate().text_color(t.foreground).when(Boolean(space), (d) => d.font_semibold()).child(r.name)))
            .when(r.private, (el) => el.child(svg(`${ICONS}/lock.svg`).size(11).flex_none().text_color(t.dim)))
            .when(r.fork, (el) => el.child(tag("fork")))
            .when(r.archived, (el) => el.child(tag("archived"))))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(local ? tilde(local) : r.desc || "Not on this Mac yet")))
        .child(h_flex().flex_none().gap(8).items_center()
          .when(on, (el) => el.child(div().text_size(11).text_color(t.muted).child(action)))
          .when(!on && Boolean(space), (el) => el.child(pill("In Spaces", true)))
          .when(!on && !space && !local, (el) => el.child(pill("Not cloned", false)))
          .child(div().w(26).flex_none().text_size(11).text_color(t.dim).text_right().child(ago(r.pushed))));
    };

    const button = (id, icon, label, action) => h_flex().id(id).h(26).px(8).gap(6).flex_none().items_center().rounded(6)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(svg(icon).size(13)).child(label);

    const status = this.asking ? (this.repos.length ? "Checking GitHub…" : "Asking GitHub…")
      : this.stale ? "Offline, last list" : `${this.repos.length} on GitHub`;
    const empty = this.asking && !this.repos.length ? "Loading your repositories…"
      : this.filter ? "No repository matches" : this.error ? "" : "No repositories";

    return v_flex().id("repos").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return this.close();
        const n = rows.length;
        if (!n) return;
        if (e.key === "down") this.at = (this.at + 1) % n;
        else if (e.key === "up") this.at = (this.at + n - 1) % n;
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(10)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Repositories"))
        .child(div().text_size(11).text_color(t.dim).child(status))
        .child(div().id("repos-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(rows.length
        ? v_flex().id("repo-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).children(rows.map(row))
        : v_flex().flex_1().min_h(0).items_center().justify_center().text_color(t.dim).child(empty))
      .child(h_flex().pt(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().truncate().child("↩ open   ⌘↩ open with Claude Code"))
        .child(button("repos-folder", "mods/workspace-chrome/folder.svg", "Open folder…", (_e, cx) => cx.spawn(async () => {
          const folder = await pickFolder({ prompt: "Open as space" });
          if (!folder) return;
          run("space.new", { folder, machine: "" });
          this.close();
        })))
        .child(button("repos-empty", "mods/workspace-chrome/plus.svg", "Empty space", () => { this.close(); run("space.new"); })));
  }
}
