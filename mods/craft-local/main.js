import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, settings, exec, home, setShared, readTextFile, appHome } from "herdr";

// Under the agents: the CI machine (a Lima VM that runs a GitHub Actions runner) and the
// dev servers listening on this Mac. Click a server to open it, the CI row for Actions;
// a server's stop button, pressed twice, stops it.
// The CI row is optional and personal: mods/craft-local/config.json (see config.example.json)
// names the Lima VM, the repo its runner serves and the runner's label. Without it, no CI row.
const DEFAULTS = { vm: null, repo: null, runnerLabel: null };
async function loadConfig() {
  try {
    const text = await readTextFile(`${appHome()}/mods/craft-local/config.json`);
    return { ...DEFAULTS, ...(text ? JSON.parse(text) : {}) };
  } catch { return { ...DEFAULTS }; }
}

// What counts as a dev server: a runtime or dev tool listening, not an app or an MCP bridge.
const RUNTIME = /^(node|bun|deno|python[\d.]*|ruby|php|java|go|dotnet|uvicorn|gunicorn|hugo|caddy|next-server.*)$/i;
const TOOLS = ["electron-vite", "vite", "next", "astro", "nuxt", "remix", "storybook", "webpack", "parcel", "wrangler",
  "http.server", "uvicorn", "flask", "gunicorn", "rails", "jekyll", "hugo", "serve", "live-server", "nodemon", "tsx"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
const tilde = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);

// "vite" for node_modules/.bin/vite, "http.server" for python -m http.server, else the script.
function toolOf(args) {
  const m = args.indexOf("-m");
  if (m !== -1 && args[m + 1]) return args[m + 1];
  for (const a of args.slice(1)) {
    const name = base(a).replace(/\.(c|m)?js$/, "");
    if (TOOLS.includes(name)) return name;
  }
  const script = args.slice(1).find((a) => !a.startsWith("-"));
  return script ? base(script) : base(args[0]);
}

export default class Local extends View {
  init(_props, cx) {
    this.servers = [];
    this.procs = new Map(); // pid -> { keep, project, tool, cwd } (ps and git once per process)
    this.vm = null; // "Running", "Stopped", ... or null before the first look
    this.runner = null; // { online, busy } or null when GitHub can't say
    this.hover = null; // the port under the pointer, which shows its stop button
    this.confirm = null; // the port whose stop button asks to be pressed again
    this.stopping = new Set(); // ports
    this.failed = new Map(); // port -> why it didn't stop
    this.cfg = { ...DEFAULTS };
    this.scanPorts(cx);
    cx.spawn(async (cx) => { this.cfg = await loadConfig(); this.checkVm(cx); cx.notify(); });
    cx.timer.every(5000, (cx) => this.scanPorts(cx));
    cx.timer.every(10000, (cx) => this.checkVm(cx));
    cx.timer.every(30000, (cx) => this.checkRunner(cx));
  }

  scanPorts(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: 10000 });
        const listening = new Map(); // port -> { pid, host }
        let pid = null;
        for (const line of r.stdout.split("\n")) {
          if (line[0] === "p") pid = Number(line.slice(1));
          else if (line[0] === "n" && pid) {
            const at = line.lastIndexOf(":");
            const port = Number(line.slice(at + 1)), host = line.slice(1, at);
            if (port && !listening.has(port)) listening.set(port, { pid, host });
          }
        }
        const pids = [...new Set([...listening.values()].map((l) => l.pid))];
        await this.learn(pids.filter((p) => !this.procs.has(p)));
        for (const p of this.procs.keys()) if (!pids.includes(p)) this.procs.delete(p);
        this.servers = [...listening].map(([port, l]) => ({ port, ...l, ...this.procs.get(l.pid) }))
          .filter((s) => s.keep).sort((a, b) => a.port - b.port);
        // The Issues panel can add them to an issue's context.
        const brief = JSON.stringify(this.servers.map((s) => ({ port: s.port, tool: s.tool, project: s.project })));
        if (brief !== this.published) { this.published = brief; setShared("craft-local.servers", JSON.parse(brief)); }
      } catch { /* keep the last list */ }
      this.scanning = false;
      this.scanned = true;
      cx.notify();
    });
  }

  // What each new process runs and where, and the repo it belongs to.
  async learn(pids) {
    if (!pids.length) return;
    const list = pids.join(",");
    const [ps, cwds] = await Promise.all([
      exec("/bin/ps", ["-o", "pid=,command=", "-p", list], { timeout: 5000 }),
      exec("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", list, "-Fn"], { timeout: 5000 }),
    ]);
    const cwd = new Map();
    let pid = null;
    for (const line of cwds.stdout.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && pid) cwd.set(pid, line.slice(1));
    }
    await Promise.all(ps.stdout.split("\n").filter(Boolean).map(async (line) => {
      const [, id, command] = line.trim().match(/^(\d+)\s+(.*)$/) ?? [];
      if (!id) return;
      const args = command.split(/\s+/);
      const keep = RUNTIME.test(base(args[0])) && !/mcp/i.test(command);
      const dir = cwd.get(Number(id)) ?? "";
      // The repo: from where it runs, else from the package its tool comes from.
      const owner = command.match(/(\/\S+?)\/node_modules\//)?.[1];
      const project = keep ? (await this.repo(dir)) ?? (owner && (await this.repo(owner))) ?? base(dir) : "";
      this.procs.set(Number(id), { keep, project, tool: keep ? toolOf(args) : "", cwd: dir, trashed: dir.includes("/.Trash/") });
    }));
    for (const p of pids) if (!this.procs.has(p)) this.procs.set(p, { keep: false });
  }

  // Like Ctrl-C in its terminal, without touching that terminal or the agent that started it:
  // TERM to the listening process and its children, KILL if it's still up 3 seconds later.
  stop(cx, s) {
    this.confirm = null;
    this.stopping.add(s.port);
    this.failed.delete(s.port);
    cx.spawn(async (cx) => {
      try {
        const tree = await this.tree(s.pid);
        const r = await exec("/bin/kill", ["-TERM", ...tree], { timeout: 5000 });
        if (r.code !== 0 && /not permitted/i.test(r.stderr)) throw new Error("Not allowed");
        let alive = true;
        for (let i = 0; i < 6 && alive; i++) {
          await exec("/bin/sleep", ["0.5"]);
          alive = (await exec("/bin/kill", ["-0", String(s.pid)])).code === 0;
        }
        if (alive) await exec("/bin/kill", ["-KILL", ...tree], { timeout: 5000 });
        this.servers = this.servers.filter((x) => x.pid !== s.pid);
      } catch (err) {
        this.failed.set(s.port, err?.message === "Not allowed" ? "Not allowed" : "Couldn't stop");
      }
      this.stopping.delete(s.port);
      cx.notify();
      this.scanPorts(cx);
    });
  }

  // The process and everything it started (electron-vite's Electron, a server's workers).
  async tree(pid) {
    const r = await exec("/bin/ps", ["-A", "-o", "pid=,ppid="], { timeout: 5000 });
    const kids = new Map();
    for (const line of r.stdout.split("\n")) {
      const [p, parent] = line.trim().split(/\s+/).map(Number);
      if (p && parent) kids.set(parent, [...(kids.get(parent) ?? []), p]);
    }
    const out = [];
    const walk = (p) => { out.push(String(p)); for (const k of kids.get(p) ?? []) walk(k); };
    walk(pid);
    return out;
  }

  async repo(dir) {
    if (!dir) return null;
    try {
      const r = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 3000 });
      return r.code === 0 ? base(r.stdout.trim()) : null;
    } catch { return null; }
  }

  checkVm(cx) {
    if (!this.cfg.vm) return;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("limactl", ["list", "--json"], { timeout: 8000 });
        const vm = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((v) => v.name === this.cfg.vm);
        const was = this.vm;
        this.vm = vm?.status ?? "Missing";
        if (this.vm !== "Running") this.runner = null;
        else if (was !== "Running") await this.fetchRunner();
      } catch { this.vm = null; }
      cx.notify();
    });
  }

  // GitHub only knows the runner while the VM is up, so it's asked only then.
  checkRunner(cx) {
    if (!this.cfg.vm || this.vm !== "Running") return;
    cx.spawn(async (cx) => { await this.fetchRunner(); cx.notify(); });
  }

  async fetchRunner() {
    const { repo, vm, runnerLabel } = this.cfg;
    if (!repo) { this.runner = null; return; }
    try {
      const r = await exec("gh", ["api", `repos/${repo}/actions/runners`], { timeout: 15000 });
      const runner = JSON.parse(r.stdout).runners?.find((x) => x.labels?.some((l) => l.name === (runnerLabel ?? vm)));
      this.runner = runner ? { online: runner.status === "online", busy: Boolean(runner.busy) } : null;
    } catch { this.runner = null; }
  }

  // The CI dot: lime and pulsing while a job runs, green when ready, amber when the VM is
  // up but its runner isn't, grey when off.
  ci(t) {
    if (this.vm === null) return { color: t.idle, text: "Checking…" };
    if (this.vm === "Missing") return { color: t.idle, text: "Not found" };
    if (this.vm !== "Running") return { color: t.idle, text: "Off" };
    if (!this.runner) return { color: t.done, text: "On" };
    if (!this.runner.online) return { color: t.blocked, text: "On · runner offline" };
    return this.runner.busy ? { color: t.working, text: "Running a job", pulse: true } : { color: t.done, text: "On · ready" };
  }

  dot(s, on = true) {
    const d = div().size(7).flex_none().rounded(4).border_1().border_color(s.color).when(on, (el) => el.bg(s.color));
    return s.pulse ? d.loop("opacity", { from: 0.3, to: 1, period: 1400 }) : d;
  }

  open(url) { exec("/usr/bin/open", [url]).catch(() => {}); }

  url(s) { return `http://${s.host === "127.0.0.1" ? "127.0.0.1" : "localhost"}:${s.port}`; }

  header(t, label, count) {
    return h_flex().px(16).h(36).pt(12).pb(4).flex_none().items_center().gap(6)
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child(label))
      .when(count !== undefined, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(count))));
  }

  server(t, s) {
    const hovered = this.hover === s.port, asking = this.confirm === s.port, stopping = this.stopping.has(s.port);
    const failed = this.failed.get(s.port);
    const stop = (_e, cx) => cx.stop_propagation();
    // The row opens the server; these two take their own clicks.
    const button = (id, child) => h_flex().id(`${id}-${s.port}`).flex_none().items_center().justify_center().rounded(5)
      .on_mouse_down("left", stop).child(child);
    return h_flex().id(`port-${s.port}`).h(30).px(8).gap(8).flex_none().items_center().rounded(8)
      .hover((st) => st.bg(t.hover))
      .tooltip(`${this.url(s)}  ${tilde(s.cwd)}`)
      .on_hover((on, cx) => {
        if (on) this.hover = s.port;
        else {
          if (this.hover === s.port) this.hover = null;
          if (this.confirm === s.port) this.confirm = null;
          this.failed.delete(s.port);
        }
        cx.notify();
      })
      .on_click(() => this.open(this.url(s)))
      .child(div().w(42).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(t.muted).child(String(s.port)))
      // The project gives way before the buttons do in a narrow sidebar.
      .child(div().min_w(0).max_w(150).truncate().text_color(t.foreground).child(s.project))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(failed ? t.blocked : t.dim)
        .child(stopping ? "Stopping…" : failed ?? s.tool))
      .when(s.trashed && !asking, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child("Trash")))
      .when(asking, (el) => el.child(button("stop-confirm", "Stop").h(20).px(7).text_size(11.5).font_medium()
        .bg(t.blocked).text_color(t.background).tooltip("Stop this server and what it started")
        .on_click((_e, cx) => { cx.stop_propagation(); this.stop(cx, s); cx.notify(); })))
      .when(!asking && hovered && !stopping, (el) => el.child(button("stop", svg("mods/craft-local/icons/stop.svg").size(10)).size(20)
        .text_color(t.dim).hover((st) => st.bg(t.raised).text_color(t.blocked)).tooltip("Stop")
        .on_click((_e, cx) => { cx.stop_propagation(); this.confirm = s.port; this.failed.delete(s.port); cx.notify(); })))
      .when(!asking, (el) => el.child(svg("mods/craft-local/icons/open.svg").size(12).flex_none().text_color(t.dim)));
  }

  render() {
    const t = theme();
    const state = this.ci(t);
    const { vm, repo } = this.cfg;
    const actions = repo ? `https://github.com/${repo}/actions` : null;
    if (narrow()) {
      return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).items_center().pt(12).gap(10)
        .when(Boolean(vm), (el) => el.child(div().id("ci-rail").p(6).rounded(6).hover((s) => s.bg(t.hover)).tooltip(`${vm}: ${state.text}`)
          .when(Boolean(actions), (e) => e.on_click(() => this.open(actions))).child(this.dot(state, this.vm === "Running"))))
        .child(div().id("ports-rail").text_size(11.5).text_color(t.dim)
          .tooltip(this.servers.map((s) => `${s.port} ${s.project}`).join("\n") || "Nothing listening")
          .child(String(this.servers.length)));
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .when(Boolean(vm), (el) => el.child(this.header(t, "CI"))
        .child(v_flex().px(8).flex_none()
          .child(h_flex().id("ci-row").h(30).px(8).gap(8).items_center().rounded(8).hover((s) => s.bg(t.hover))
            .tooltip(repo ? `${vm} · runner for ${repo}` : vm)
            .when(Boolean(actions), (e) => e.on_click(() => this.open(actions)))
            .child(h_flex().w(42).flex_none().child(this.dot(state, this.vm === "Running")))
            .child(div().flex_shrink(0).text_color(t.foreground).child(vm))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(state.pulse ? t.working : t.dim).child(state.text))
            .when(Boolean(actions), (e) => e.child(svg("mods/craft-local/icons/open.svg").size(12).flex_none().text_color(t.dim))))))
      .child(this.header(t, "Localhost", this.servers.length))
      .child(v_flex().id("ports").flex_1().min_h(0).px(8).pb(10).overflow_y_scrollbar()
        .when(this.servers.length === 0, (el) => el.child(div().px(8).text_size(12).text_color(t.dim).child(this.scanned ? "Nothing listening" : "Looking…")))
        .children(this.servers.map((s) => this.server(t, s))));
  }
}
