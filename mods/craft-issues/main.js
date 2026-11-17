import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { spaces, agents, panes, focused, theme, exec, shared, home } from "herdr";

// Report an issue from where you work. Write it once, then send it to the agents of the shown
// tab (`hc send`, like Notes) or create it on GitHub with `gh` and hand its number to an agent
// in one click. The context (repo, macOS, a terminal's last lines, local servers, a screenshot)
// is gathered when it's sent, each piece only while its chip is on.
const icon = (name) => `mods/craft-issues/icons/${name}.svg`;
const LINES = 40; // terminal lines an issue carries
const ASK = "Investígalo y propón el arreglo antes de tocar código.";
const KINDS = {
  bug: { label: "Bug", word: "bug", gh: "bug" },
  feature: { label: "Feature", word: "mejora", gh: "enhancement" },
  task: { label: "Task", word: "tarea", gh: null },
};
const CONTEXT = [["repo", "Repo"], ["os", "macOS"], ["terminal", "Terminal"], ["localhost", "Localhost"], ["shot", "Screenshot"]];
const IMAGE = /\.(png|jpe?g|gif|webp|heic)$/i;
const SHOT_NAME = /^(Screenshot|Screen Shot|Captura de pantalla|CleanShot)/i;
const SHOTS = () => `${home()}/Library/Caches/herdr-craft-issues`; // pasted images

const tilde = (p) => (p && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;

function shown() {
  const space = spaces().find((s) => s.active);
  return { space, tab: space?.tabs.find((t) => t.active) };
}

// Where the issue comes from: the focused terminal's folder, as Graph reads it.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}

function statusDot(t, status) {
  if (status !== "working" && status !== "blocked" && status !== "done") return null;
  const dot = div().size(6).flex_none().rounded(3).bg(t[status]);
  return status === "working" ? dot.loop("opacity", { from: 0.3, to: 1, period: 1400 }) : dot;
}

// hc and gh print why they refused; JSON from hc, a last line from gh.
function reason(r) {
  for (const out of [r.stdout, r.stderr]) {
    try { const m = JSON.parse(out)?.error?.message; if (m) return m; } catch { /* not JSON */ }
  }
  return (r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`;
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Terminal text leaves this Mac: tokens and keys are hidden, the home folder becomes ~.
const SECRETS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
function redact(text) {
  let out = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  for (const re of SECRETS) out = out.replace(re, "[oculto]");
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[oculto]");
  out = out.replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"']{6,}\3/gi, "$1$2$3[oculto]$3");
  return out.split(home()).join("~");
}

function lastLines(text, n) {
  const lines = text.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  return lines.slice(-n).join("\n");
}

// A code fence longer than any run of backticks inside.
function fence(text) {
  const run = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(run + 1);
}

export default class Issues extends View {
  init(_props, cx) {
    const draft = JSON.parse(localStorage.getItem("draft") ?? "{}");
    this.kind = KINDS[draft.kind] ? draft.kind : "bug";
    this.ctx = { repo: true, os: true, terminal: false, localhost: false, ...JSON.parse(localStorage.getItem("context") ?? "{}"), shot: false };
    this.editing = null; // the field with the keyboard
    this.off = new Set(); // agents left out of sends
    this.term = null; // the terminal whose lines go along; null: the first one offered
    this.shot = null; // { path, at, from: "paste" | "drop" | "folder" }
    this.info = { cwd: null }; // where the issue comes from: root, branch, sha, dirty, repo, url, labels
    this.repos = new Map(); // git root -> { repo, url, labels, at } from gh
    this.os = "";
    this.sending = null; // "agent" | "github"
    this.sentAt = 0;
    this.result = null; // { ok, text }
    this.created = null; // { number, url, repo, title, shot }: the last issue made on GitHub
    this.f = {};
    this.f.title = InputState.new({ placeholder: "What's wrong, in one line", value: draft.title ?? "" });
    this.f.what = TextareaState.new({ placeholder: "What you see, and where", value: draft.what ?? "" });
    this.f.steps = TextareaState.new({ placeholder: "1. …", value: draft.steps ?? "" });
    this.f.expected = TextareaState.new({ placeholder: "", value: draft.expected ?? "" });
    this.f.what.set_auto_grow(3, 12);
    this.f.steps.set_auto_grow(2, 8);
    this.f.expected.set_auto_grow(2, 8);
    this.filled = this.ready();
    for (const [name, state] of [["title", this.f.title], ["what", this.f.what], ["steps", this.f.steps], ["expected", this.f.expected]]) {
      state.on("change", (_e, cx) => {
        this.saveDraft();
        if (this.ready() !== this.filled) { this.filled = this.ready(); cx.notify(); }
      });
      state.on("focus", (_e, cx) => { this.editing = name; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.editing === name) this.editing = null; cx.notify(); });
      state.on("paste_other", (_e, cx) => this.pasteImage(cx));
    }
    this.f.title.on("submit", () => this.f.what.focus());
    cx.spawn(async (cx) => {
      const r = await exec("/usr/bin/sw_vers", ["-productVersion"]).catch(() => null);
      this.os = r?.stdout.trim() ?? "";
      // Pasted images older than a week have done their job.
      await exec("/usr/bin/find", [SHOTS(), "-type", "f", "-mtime", "+7", "-delete"]).catch(() => null);
      cx.notify();
    });
    // The branch and uncommitted count move while you work; gh is asked once per repo.
    cx.timer.every(15000, (cx) => { if (this.info.cwd) this.probe(cx, this.info); });
    cx.timer.every(4000, (cx) => { if (this.ctx.shot && this.shot?.from !== "paste" && this.shot?.from !== "drop") this.findShot(cx); });
  }

  ready() { return Boolean(this.f.title.value().trim() && this.f.what.value().trim()); }

  saveDraft() {
    const v = (s) => s.value();
    const draft = { kind: this.kind, title: v(this.f.title), what: v(this.f.what), steps: v(this.f.steps), expected: v(this.f.expected) };
    localStorage.setItem("draft", JSON.stringify(draft));
  }

  saveContext() {
    const { shot: _shot, ...rest } = this.ctx; // a screenshot belongs to one issue
    localStorage.setItem("context", JSON.stringify(rest));
  }

  clearDraft() {
    for (const s of [this.f.title, this.f.what, this.f.steps, this.f.expected]) s.set_value("");
    this.shot = null;
    this.ctx.shot = false;
    this.filled = false;
    this.saveDraft();
  }

  // ---- Where it comes from ----

  probe(cx, where) {
    const key = `${where.on ?? ""}|${where.cwd}`;
    this.want = { key, where };
    if (this.probing) return; // the running look checks `want` again when it ends
    this.probing = true;
    cx.spawn(async (cx) => {
      let info;
      try { info = await this.look(where); } catch { info = { cwd: where.cwd, on: where.on, root: null }; }
      this.probing = false;
      if (this.want.key === key) { this.info = info; cx.notify(); } else this.probe(cx, this.want.where);
    });
  }

  async look({ cwd, on }) {
    const info = { cwd, on, root: null };
    if (!cwd) return info;
    const git = (args) => exec("git", args, { cwd, on, timeout: 8000 });
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return info;
    info.root = top.stdout.trim();
    const [branch, sha, status] = await Promise.all([git(["branch", "--show-current"]), git(["rev-parse", "--short", "HEAD"]), git(["status", "--porcelain"])]);
    info.branch = branch.stdout.trim() || null; // null: a detached HEAD
    info.sha = sha.code === 0 ? sha.stdout.trim() : null;
    info.dirty = status.stdout.split("\n").filter(Boolean).length;
    let gh = this.repos.get(info.root);
    // A repo gh couldn't place (offline, no GitHub remote) is asked again after two minutes.
    if (!gh || (!gh.repo && Date.now() - gh.at > 120000)) {
      gh = { repo: null, at: Date.now() };
      const r = await exec("gh", ["repo", "view", "--json", "nameWithOwner,url"], { cwd: info.root, on, timeout: 20000 }).catch(() => null);
      try { if (r?.code === 0) { const j = JSON.parse(r.stdout); gh = { ...gh, repo: j.nameWithOwner, url: j.url }; } } catch { /* not a repo gh knows */ }
      if (gh.repo) {
        const l = await exec("gh", ["label", "list", "--repo", gh.repo, "--limit", "200", "--json", "name", "--jq", ".[].name"], { on, timeout: 20000 }).catch(() => null);
        gh.labels = l?.code === 0 ? l.stdout.split("\n").filter(Boolean) : [];
      }
      this.repos.set(info.root, gh);
    }
    return { ...info, repo: gh.repo, url: gh.url, labels: gh.labels ?? [] };
  }

  // Terminals of the shown space: the shown tab's first, plain terminals before agents.
  candidates() {
    const { space, tab } = shown();
    if (!space) return [];
    const ids = space.tabs.map((x) => x.id);
    const rank = (p) => (p.tab === tab?.id ? 0 : 2) + (p.status || p.program?.agent ? 1 : 0);
    return panes().filter((p) => p.terminal && ids.includes(p.tab)).sort((a, b) => rank(a) - rank(b)).slice(0, 6);
  }

  chosen(list = this.candidates()) { return list.find((p) => p.terminal === this.term) ?? list[0] ?? null; }

  // "Vite", or "Claude Code · Orquestador" when another terminal has the same name.
  termLabel(p, list) {
    const tabs = shown().space?.tabs ?? [];
    const name = (x) => x.program?.name ?? "Terminal";
    const same = list.filter((x) => name(x) === name(p));
    if (same.length < 2) return name(p);
    const here = same.filter((x) => x.tab === p.tab);
    const n = here.length > 1 ? ` ${here.findIndex((x) => x.terminal === p.terminal) + 1}` : "";
    const i = tabs.findIndex((tb) => tb.id === p.tab), tab = tabs[i]?.name ?? "";
    return `${name(p)}${n} · ${/^tb\d+$/.test(tab) ? `tab ${i + 1}` : tab}`;
  }

  // ---- Screenshot ----

  // Where captures land: CleanShot's history (a capture you only copied lives there too) and
  // save folder, then macOS's screenshot folder. Read again every few minutes, in case they move.
  async shotFolders() {
    if (this.folders && Date.now() - this.folders.at < 300000) return this.folders.list;
    const read = async (domain, key) => (await exec("/usr/bin/defaults", ["read", domain, key]).catch(() => null))?.stdout.trim() || null;
    const abs = (p) => p.replace(/^~(?=\/|$)/, home()).replace(/\/$/, "");
    const [clean, mac] = await Promise.all([read("pl.maketheweb.cleanshotx", "exportPath"), read("com.apple.screencapture", "location")]);
    const list = [
      { dir: `${home()}/Library/Application Support/CleanShot/media`, depth: "2", any: true },
      ...(clean ? [{ dir: abs(clean), depth: "1", any: true }] : []),
      { dir: abs(mac || "~/Desktop"), depth: "1", any: false }, // may be a busy folder: screenshots by name only
    ];
    this.folders = { list, at: Date.now() };
    return list;
  }

  // The newest capture from the last day. While Screenshot is on it follows new captures,
  // until you paste or drop one yourself.
  findShot(cx) {
    if (this.finding) return;
    this.finding = true;
    cx.spawn(async (cx) => {
      try {
        const found = [];
        for (const { dir, depth, any } of await this.shotFolders()) {
          const r = await exec("/usr/bin/find", [dir, "-maxdepth", depth, "-type", "f", "-mtime", "-1",
            "(", "-iname", "*.png", "-o", "-iname", "*.jpg", "-o", "-iname", "*.jpeg", ")",
            "-exec", "/usr/bin/stat", "-f", "%m\t%N", "{}", "+"], { timeout: 8000 }).catch(() => null);
          for (const line of r?.stdout.split("\n") ?? []) {
            const [m, path] = line.split("\t");
            if (path && (any || SHOT_NAME.test(base(path)))) found.push({ path, at: Number(m) * 1000 });
          }
        }
        const newest = found.sort((a, b) => b.at - a.at)[0];
        const yours = this.shot && this.shot.from !== "capture";
        if (newest && !yours && this.ctx.shot && newest.path !== this.shot?.path) {
          this.shot = { ...newest, from: "capture" };
          cx.notify();
        }
      } finally {
        this.finding = false;
      }
    });
  }

  pasteImage(cx) {
    cx.spawn(async (cx) => {
      const path = `${SHOTS()}/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      await exec("/bin/mkdir", ["-p", SHOTS()]).catch(() => null);
      const script = ["try", "set png to the clipboard as «class PNGf»", "on error", 'return "none"', "end try",
        `set fh to open for access POSIX file "${path}" with write permission`, "write png to fh", "close access fh", 'return "ok"'];
      const r = await exec("/usr/bin/osascript", script.flatMap((l) => ["-e", l]), { timeout: 10000 }).catch(() => null);
      if (r?.stdout.trim() === "ok") { this.shot = { path, at: Date.now(), from: "paste" }; this.ctx.shot = true; }
      else this.result = { ok: false, text: "No image in the clipboard" };
      cx.notify();
    });
  }

  toggleContext(id, cx) {
    this.ctx[id] = !this.ctx[id];
    this.saveContext();
    if (id === "shot" && this.ctx.shot && !this.shot) this.findShot(cx);
  }

  // ---- What goes out ----

  // Fresh at send time: the branch or the last lines may have moved since the preview.
  async gather() {
    const where = this.info.cwd ? await this.look(this.info).catch(() => this.info) : this.info;
    const lines = [];
    if (this.ctx.repo) {
      if (where.root) {
        const at = where.branch ? `rama \`${where.branch}\` @ \`${where.sha}\`` : `commit \`${where.sha}\` sin rama`;
        const dirty = where.dirty ? `, ${where.dirty} ${where.dirty === 1 ? "archivo" : "archivos"} sin commit` : "";
        lines.push(`- ${where.repo ? `\`${where.repo}\`` : `\`${tilde(where.root)}\``}, ${at}${dirty}`);
      } else if (where.cwd) lines.push(`- Carpeta \`${tilde(where.cwd)}\`, sin git`);
    }
    if (this.ctx.os && this.os) lines.push(`- macOS ${this.os}`);
    if (this.ctx.localhost) {
      const list = shared("craft-local.servers") ?? [];
      lines.push(list.length
        ? `- Servidores locales ${list.map((s) => `\`${s.port}\` ${s.tool}${s.project ? ` (${s.project})` : ""}`).join(", ")}`
        : "- Sin servidores locales en marcha");
    }
    let terminal = null;
    const p = this.ctx.terminal ? this.chosen() : null;
    if (p) {
      const r = await exec("hc", ["read", p.terminal, "--lines", String(LINES * 3)], { timeout: 10000 });
      if (r.code !== 0) throw new Error(`Couldn't read ${this.termLabel(p, this.candidates())}: ${reason(r)}`);
      terminal = { name: this.termLabel(p, this.candidates()), text: redact(lastLines(r.stdout, LINES)) };
    }
    let shot = this.ctx.shot ? this.shot?.path ?? null : null;
    // A copy of its own: CleanShot can prune its history before the agent reads it.
    if (shot && !shot.startsWith(SHOTS())) {
      const copy = `${SHOTS()}/issue-${new Date().toISOString().replace(/[:.]/g, "-")}${(shot.match(IMAGE)?.[0] ?? ".png").toLowerCase()}`;
      await exec("/bin/mkdir", ["-p", SHOTS()]).catch(() => null);
      if ((await exec("/bin/cp", [shot, copy]).catch(() => null))?.code === 0) shot = copy;
    }
    return { where, lines, terminal, shot };
  }

  compose(target, c) {
    const v = (s) => s.value().trim();
    const bug = this.kind === "bug";
    const sec = (h, text) => (text ? `## ${h}\n\n${text}` : "");
    const lines = [...c.lines];
    if (target === "agent") {
      if (c.where.root && this.ctx.repo) lines.push(`- Carpeta \`${tilde(c.where.root)}\``);
      if (c.shot) lines.push(`- Captura \`${c.shot}\``);
    }
    let term = "";
    if (c.terminal) {
      const f = fence(c.terminal.text), head = `Terminal ${c.terminal.name}, últimas ${LINES} líneas`;
      const code = `${f}\n${c.terminal.text}\n${f}`;
      term = target === "github" ? `<details><summary>${head}</summary>\n\n${code}\n\n</details>` : `${head}\n\n${code}`;
    }
    const body = [
      sec("Qué pasa", v(this.f.what)),
      bug ? sec("Cómo reproducirlo", v(this.f.steps)) : "",
      sec(bug ? "Qué esperaba" : "Criterio de hecho", v(this.f.expected)),
      sec("Contexto", [lines.join("\n"), term].filter(Boolean).join("\n\n")),
    ].filter(Boolean).join("\n\n");
    if (target === "github") return body;
    return [`Issue nuevo (${KINDS[this.kind].word}), sin abrir en GitHub.`, `# ${v(this.f.title)}`, body, ASK].join("\n\n");
  }

  recipients() {
    const { tab } = shown();
    return tab ? agents().filter((a) => a.tab === tab.id) : [];
  }

  picked() { return this.recipients().filter((a) => !this.off.has(a.address)); }

  label(a, list) {
    const name = (x) => x.program?.name ?? x.app ?? x.address;
    const same = list.filter((b) => name(b) === name(a));
    return same.length > 1 ? `${name(a)} ${same.indexOf(a) + 1}` : name(a);
  }

  async deliver(text) {
    const list = this.recipients();
    const to = list.filter((a) => !this.off.has(a.address));
    const failed = [];
    await Promise.all(to.map(async (a) => {
      try {
        const r = await exec("hc", ["send", "--json", a.address, text], { timeout: 20000 });
        if (r.code !== 0) failed.push({ a, why: reason(r) });
      } catch (err) {
        failed.push({ a, why: String(err?.message ?? err) });
      }
    }));
    const sent = to.filter((a) => !failed.some((f) => f.a === a));
    const ok = sent.length === 1 ? `Sent to ${this.label(sent[0], list)}` : sent.length ? `Sent to ${sent.length} agents` : "";
    const bad = failed.length ? `${failed.map((f) => this.label(f.a, list)).join(", ")}: ${failed[0].why}` : "";
    return { ok: !failed.length, any: sent.length > 0, text: [ok, bad].filter(Boolean).join(" · ") };
  }

  // ⌘↩ can arrive twice; one press sends once.
  begin(kind) {
    if (this.sending || Date.now() - this.sentAt < 500) return false;
    this.sending = kind;
    this.sentAt = Date.now();
    this.result = null;
    return true;
  }

  sendAgent(cx) {
    if (!this.ready() || !this.picked().length || !this.begin("agent")) return;
    cx.spawn(async (cx) => {
      try {
        const res = await this.deliver(this.compose("agent", await this.gather()));
        this.result = res;
        if (res.any) this.clearDraft();
      } catch (err) {
        this.result = { ok: false, text: String(err?.message ?? err) };
      }
      this.sending = null;
      cx.notify();
    });
    cx.notify();
  }

  createIssue(cx) {
    if (!this.ready() || !this.info.repo || !this.begin("github")) return;
    cx.spawn(async (cx) => {
      try {
        const c = await this.gather();
        const repo = c.where.repo ?? this.info.repo, title = this.f.title.value().trim();
        const args = ["issue", "create", "--repo", repo, "--title", title, "--body", this.compose("github", c)];
        const label = KINDS[this.kind].gh;
        if (label && (c.where.labels ?? []).includes(label)) args.push("--label", label);
        const r = await exec("gh", args, { cwd: c.where.root ?? undefined, on: c.where.on, timeout: 60000 });
        if (r.code !== 0) throw new Error(reason(r));
        const url = r.stdout.trim().split("\n").pop();
        this.created = { number: url.match(/\/issues\/(\d+)/)?.[1] ?? "?", url, repo, title, shot: c.shot };
        this.clearDraft();
      } catch (err) {
        this.result = { ok: false, text: String(err?.message ?? err) };
      }
      this.sending = null;
      cx.notify();
    });
    cx.notify();
  }

  // The issue's number, not its text: the agent reads it with gh, and the fix can close it.
  sendCreated(cx) {
    const c = this.created;
    if (!c || !this.picked().length || !this.begin("agent")) return;
    const text = [
      `Lee el issue #${c.number} de ${c.repo} con \`gh issue view ${c.number} --repo ${c.repo}\` (${c.url}).`,
      c.shot ? `La captura no está en el issue. Está en \`${c.shot}\`.` : "",
      ASK,
    ].filter(Boolean).join("\n\n");
    cx.spawn(async (cx) => {
      this.result = await this.deliver(text);
      this.sending = null;
      cx.notify();
    });
    cx.notify();
  }

  // ---- Drawing ----

  kindPill(t, id) {
    const on = this.kind === id;
    return h_flex().id(`kind-${id}`).h(26).px(9).flex_none().items_center().rounded(6).text_size(12.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium())
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.kind = id; this.saveDraft(); cx.notify(); })
      .child(KINDS[id].label);
  }

  field(t, id, label, state, control, optional) {
    const on = this.editing === id;
    return v_flex().gap(6)
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().font_medium().text_color(t.muted).child(label))
        .when(optional, (el) => el.child(div().text_color(t.dim).child("optional"))))
      .child(div().id(`field-${id}`).w_full().rounded(8).border_1().border_color(on ? t.accent : t.border).cursor_text()
        .when(id === "title", (el) => el.h(34).px(10).flex().items_center())
        .when(id !== "title", (el) => el.px(10).py(8))
        .on_click(() => state.focus())
        .child(control));
  }

  chip(t, a, list) {
    const on = !this.off.has(a.address);
    const p = a.program;
    const pic = p?.icon ? (p.tint ? svg(p.icon).size(14).text_color(on ? t.muted : t.dim) : image(p.icon).size(14)) : null;
    return h_flex().id(`to-${a.address}`).h(26).pl(8).pr(7).gap(6).flex_none().items_center().rounded(7).border_1()
      .border_color(on ? t.input : t.border).bg(on ? t.raised : t.background).text_size(12).text_color(on ? t.foreground : t.dim)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (on) this.off.add(a.address); else this.off.delete(a.address); cx.notify(); })
      .when(Boolean(pic), (el) => el.child(div().flex_none().when(!on, (d) => d.opacity(0.5)).child(pic)))
      .child(div().max_w(140).truncate().child(this.label(a, list)))
      .when(Boolean(statusDot(t, a.status)), (el) => el.child(statusDot(t, a.status)))
      .child(h_flex().w(12).flex_none().justify_center().when(on, (el) => el.child(svg(icon("check")).size(11).text_color(t.accent))));
  }

  contextChip(t, id, name) {
    const on = Boolean(this.ctx[id]);
    return h_flex().id(`ctx-${id}`).h(26).pl(9).pr(7).gap(6).flex_none().items_center().rounded(7).border_1()
      .border_color(on ? t.input : t.border).bg(on ? t.raised : t.background).text_size(12).text_color(on ? t.foreground : t.dim)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.toggleContext(id, cx); cx.notify(); })
      .child(name)
      .child(h_flex().w(12).flex_none().justify_center().when(on, (el) => el.child(svg(icon("check")).size(11).text_color(t.accent))));
  }

  iconButton(t, id, name, tip, run) {
    return h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { run(cx); cx.notify(); })
      .child(svg(icon(name)).size(12));
  }

  details(t) {
    const out = [];
    const line = (text, color = t.dim) => div().min_w(0).truncate().text_color(color).child(text);
    const info = this.info;
    if (this.ctx.repo) {
      if (info.cwd && info.root === undefined) out.push(line("Looking…"));
      else if (info.root) {
        const where = `${info.repo ?? tilde(info.root)} · ${info.branch ?? "detached"}${info.sha ? ` @ ${info.sha}` : ""}`;
        out.push(line(`${where}${info.dirty ? ` · ${info.dirty} uncommitted` : ""}${info.repo ? "" : " · not on GitHub"}`));
      } else out.push(line("No git repo in this terminal's folder", t.blocked));
    }
    if (this.ctx.os && this.os) out.push(line(`macOS ${this.os}`));
    if (this.ctx.terminal) {
      const list = this.candidates(), pick = this.chosen(list);
      out.push(!list.length ? line("No terminals in this space") : h_flex().flex_wrap().gap(4).items_center()
        .child(div().pr(2).child(`Last ${LINES} lines of`))
        .children(list.map((p) => {
          const on = p === pick;
          return h_flex().id(`term-${p.terminal}`).h(22).px(7).items_center().rounded(6).max_w(140)
            .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
            .tooltip(p.title || p.terminal)
            .on_click((_e, cx) => { this.term = p.terminal; cx.notify(); })
            .child(div().truncate().child(this.termLabel(p, list)));
        })));
    }
    if (this.ctx.localhost) {
      const list = shared("craft-local.servers");
      out.push(line(list == null ? "Localhost isn't running" : list.length ? list.map((s) => `${s.port} ${s.tool}`).join(" · ") : "No local servers"));
    }
    if (this.ctx.shot) {
      out.push(this.shot
        ? h_flex().gap(6).items_center()
          .child(svg(icon("image")).size(13).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(`${this.shot.from === "paste" ? "Pasted image" : this.shot.from === "drop" ? base(this.shot.path) : /CleanShot/.test(this.shot.path) ? "CleanShot capture" : "Screenshot"} · ${ago(this.shot.at)} · agent only`))
          .child(this.iconButton(t, "shot-clear", "x", "Remove", () => { this.shot = null; this.ctx.shot = false; }))
        : h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().child("Take one with CleanShot, paste it (⌘V) or drop it"))
          .child(div().id("shot-paste").h(22).px(7).flex().flex_none().items_center().rounded(6).border_1().border_color(t.input)
            .text_color(t.foreground).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.pasteImage(cx))
            .child("Paste")));
    }
    return out;
  }

  createdCard(t, canSend) {
    const c = this.created;
    return h_flex().id("created").h(36).pl(10).pr(4).gap(8).items_center().rounded(8).bg(t.raised).border_1().border_color(t.border)
      .child(svg(icon("check")).size(11).flex_none().text_color(t.done))
      .child(div().flex_none().text_size(12.5).font_medium().child(`#${c.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.title))
      .child(this.iconButton(t, "created-open", "open", "Open on GitHub", () => { exec("/usr/bin/open", [c.url]).catch(() => null); }))
      .child(h_flex().id("created-send").h(26).px(8).gap(5).flex_none().items_center().rounded(6).border_1().border_color(t.input)
        .text_size(12).text_color(t.foreground)
        .when(!canSend, (el) => el.opacity(0.4))
        .when(canSend, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.sendCreated(cx)))
        .tooltip(canSend ? "Send the issue number to the agents in this tab" : "No agents picked in this tab")
        .child(svg(icon("send")).size(12))
        .child("Send to agent"))
      .child(this.iconButton(t, "created-close", "x", "Dismiss", () => { this.created = null; }));
  }

  render(cx) {
    const t = theme();
    const { space, tab } = shown();
    if ((tab?.id ?? null) !== this.shownTab) { this.shownTab = tab?.id ?? null; this.result = null; }
    const where = location(), key = `${where.on ?? ""}|${where.cwd}`;
    if (key !== this.seen) {
      this.seen = key;
      this.info = { cwd: where.cwd, on: where.on, root: where.cwd ? undefined : null };
      if (where.cwd) this.probe(cx, where);
    }
    const info = this.info;
    const list = this.recipients(), picked = list.filter((a) => !this.off.has(a.address));
    const filled = this.ready(), busy = Boolean(this.sending), bug = this.kind === "bug";
    const canAgent = filled && picked.length > 0 && !busy;
    const canGitHub = filled && Boolean(info.repo) && !busy;
    const place = info.repo ? `${info.repo.split("/")[1]} · ${info.branch ?? info.sha ?? ""}`
      : info.root ? `${base(info.root)} · ${info.branch ?? info.sha ?? ""}` : space?.name ?? "";

    const github = h_flex().id("issue-github").h(30).px(11).gap(6).flex_1().justify_center().items_center().rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_color(t.foreground).text_size(12.5).font_medium()
      .when(!canGitHub, (el) => el.opacity(0.4))
      .when(canGitHub, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.createIssue(cx)))
      .tooltip(!filled ? "Write a title and what happens" : !info.repo ? "This terminal's folder isn't a GitHub repo" : "Create the issue on GitHub (⌘⇧↩)")
      .child(svg(icon("github")).size(14))
      .child(this.sending === "github" ? "Creating…" : "Create on GitHub");
    const send = h_flex().id("issue-send").h(30).px(12).gap(6).flex_1().justify_center().items_center().rounded(8)
      .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium()
      .when(!canAgent, (el) => el.opacity(0.4))
      .when(canAgent, (el) => el.cursor_pointer().on_click((_e, cx) => this.sendAgent(cx)))
      .tooltip(!filled ? "Write a title and what happens" : !picked.length ? "No agents picked in this tab" : "Send it to the agents in this tab")
      .child(svg(icon("send")).size(14))
      .child(this.sending === "agent" ? "Sending…" : "Send to agent")
      .child(div().text_size(11).opacity(0.55).child("⌘↩"));

    return v_flex().id("issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key !== "enter" || !(e.modifiers.platform || e.modifiers.control)) return;
        cx.stop_propagation();
        if (e.modifiers.shift) this.createIssue(cx); else this.sendAgent(cx);
      })
      .on_drop((e, cx) => {
        const path = e.paths.find((p) => IMAGE.test(p));
        if (!path) return;
        this.shot = { path, at: Date.now(), from: "drop" };
        this.ctx.shot = true;
        cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(icon("issues")).size(15).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(13).font_medium().child("Issues"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(place)))
      .child(v_flex().id("issue-form").flex_1().min_h(0).px(14).pt(12).pb(14).gap(14).overflow_y_scrollbar()
        .child(h_flex().gap(2).children(Object.keys(KINDS).map((id) => this.kindPill(t, id))))
        .child(this.field(t, "title", "Title", this.f.title, Input.new(this.f.title).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(this.field(t, "what", "What happens", this.f.what, Textarea.new(this.f.what).w_full().text_size(13).text_color(t.foreground)))
        .when(bug, (el) => el.child(this.field(t, "steps", "Steps to reproduce", this.f.steps, Textarea.new(this.f.steps).w_full().text_size(13).text_color(t.foreground), true)))
        .child(this.field(t, "expected", bug ? "Expected" : "Done when", this.f.expected, Textarea.new(this.f.expected).w_full().text_size(13).text_color(t.foreground), true))
        .child(v_flex().gap(8)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Context"))
          .child(h_flex().flex_wrap().gap(6).children(CONTEXT.map(([id, name]) => this.contextChip(t, id, name))))
          .child(v_flex().gap(6).text_size(11.5).text_color(t.dim).children(this.details(t)))))
      .child(v_flex().flex_none().px(14).pt(10).pb(12).gap(10).border_t(1).border_color(t.border)
        .child(div().text_size(11.5).text_color(t.dim).child(list.length ? "Send to the agents in this tab" : "No agents in this tab"))
        .when(list.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(list.map((a) => this.chip(t, a, list)))))
        .when(Boolean(this.created), (el) => el.child(this.createdCard(t, picked.length > 0 && !busy)))
        .when(Boolean(this.result), (el) => el.child(h_flex().min_h(18).gap(5).items_center().text_size(12)
          .text_color(this.result.ok ? t.dim : t.blocked)
          .when(this.result.ok, (el) => el.child(svg(icon("check")).size(11).flex_none().text_color(t.done)))
          .child(div().min_w(0).truncate().child(this.result.text))))
        .child(h_flex().gap(8).items_center().child(github).child(send)));
  }
}
