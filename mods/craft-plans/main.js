import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, appHome, readTextFile, watchFolder, theme, settings } from "herdr";

// Plans as branches: each unit forks from main, climbs the 7 stages and merges back into main
// once it's fusionado. Read from each package's estado.json on this Mac and, optionally, another
// machine (the newer `actualizado` wins per unit), with GitHub live. It only reads; `plan-estado`
// writes.
const icon = (name) => `mods/craft-plans/icons/${name}.svg`;
const LIVE_MS = 60000; // GitHub and the other machine

// Settings: mods/craft-plans/config.json (see config.example.json).
//   plansDir      the plans folder, relative to home on every machine (default: plan-estado's
//                 ~/.config/plan-estado/config.json "dir", else "plans")
//   otherMachine  a machine from `hc machine ls` whose plans folder is read too, or null
//   repo          "owner/name" on GitHub whose PRs move units forward, or null
const DEFAULTS = { plansDir: null, otherMachine: null, repo: null };
async function readJson(path) {
  try { const text = await readTextFile(path); return text ? JSON.parse(text) : null; } catch { return null; }
}
async function loadConfig() {
  const cfg = { ...DEFAULTS, ...(await readJson(`${appHome()}/mods/craft-plans/config.json`)) };
  if (!cfg.plansDir) cfg.plansDir = (await readJson(`${home()}/.config/plan-estado/config.json`))?.dir || "plans";
  return cfg;
}
const under = (dir) => (dir.startsWith("/") ? dir : dir.startsWith("~/") ? `${home()}/${dir.slice(2)}` : `${home()}/${dir}`);

// The 7 stages a unit's `fase` maps to.
const STAGES = [
  { name: "Plan", fases: ["decidido", "encargo"] },
  { name: "Arranque", fases: ["preparando", "enviado"] },
  { name: "Worker", fases: ["worker", "cierre-worker"] },
  { name: "Revisión", fases: ["revision", "ronda"] },
  { name: "CI", fases: ["ci"] },
  { name: "E2E", fases: ["cola-e2e", "cadena"] },
  { name: "Fusionado", fases: ["fusionado", "visto"] },
];
const LABEL = {
  decidido: "Decidido", encargo: "Encargo listo", preparando: "Preparando el Mac", enviado: "Enviado al orquestador",
  worker: "Worker trabajando", "cierre-worker": "Cierre del worker", revision: "En revisión", ronda: "Ronda de cambios",
  ci: "CI", "cola-e2e": "En cola de e2e", cadena: "Validando la cadena", fusionado: "Fusionado", visto: "Visto",
  bloqueado: "Bloqueado", descartado: "Descartado",
};
const stageOf = (fase) => STAGES.findIndex((s) => s.fases.includes(fase)) + 1; // 0: none

// Main on the left, one lane per unit. Rows from the top: main (where units merge), stages 7 to 1,
// main again (where they fork). The same strokes and curves as the Graph panel.
const LANE_W = 30, ROW_H = 26, HEAD_H = 24, PADX = 4;
const laneColors = (t) => [t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi13, t.ansi11, t.ansi12, t.ansi14];
const mainColor = () => (settings()?.dark !== false ? "#c8f000" : "#57652d"); // Craft's main lane, as in Graph

// Every estado.json under craft-plans in one round trip: a record separator, the folder, the file.
// $1: the plans folder, relative to that machine's home unless absolute.
const READ_PACKAGES = `d="$1"; case "$d" in /*) ;; "~/"*) d="$HOME/\${d#"~/"}" ;; *) d="$HOME/$d" ;; esac
cd "$d" 2>/dev/null || exit 0
for f in */estado.json; do [ -f "$f" ] || continue; printf '\\036%s\\n' "\${f%/estado.json}"; cat "$f"; done`;

function parsePackages(text) {
  const out = [];
  for (const chunk of (text ?? "").split("\x1e").slice(1)) {
    const nl = chunk.indexOf("\n");
    const folder = chunk.slice(0, nl).trim();
    try { out.push({ folder, data: JSON.parse(chunk.slice(nl + 1)) }); }
    catch { out.push({ folder, broken: true }); }
  }
  return out;
}

const newer = (a, b) => (a ?? "") > (b ?? "");

// One package per folder from both Macs: the newer file gives title, state and artefacts, the
// newer unit wins each unit.
function merge(sources) {
  const out = new Map();
  for (const [mac, list] of sources) {
    for (const p of list) {
      if (p.broken) { if (!out.has(p.folder)) out.set(p.folder, { folder: p.folder, broken: mac, units: [] }); continue; }
      const d = p.data, units = (d.unidades ?? []).map((u) => ({ ...u, from: mac }));
      const cur = out.get(p.folder);
      if (!cur || cur.broken) {
        out.set(p.folder, { folder: p.folder, titulo: d.titulo, estado: d.estado, actualizado: d.actualizado, artefactos: d.artefactos ?? [], units, macs: [mac] });
        continue;
      }
      cur.macs.push(mac);
      const wins = newer(d.actualizado, cur.actualizado);
      const arts = new Map(cur.artefactos.map((a) => [a.url, a]));
      for (const a of d.artefactos ?? []) if (wins || !arts.has(a.url)) arts.set(a.url, a);
      cur.artefactos = [...arts.values()];
      if (wins) Object.assign(cur, { titulo: d.titulo, estado: d.estado, actualizado: d.actualizado });
      for (const u of units) {
        const i = cur.units.findIndex((x) => x.id === u.id);
        if (i < 0) cur.units.push(u);
        else if (newer(u.actualizado, cur.units[i].actualizado)) cur.units[i] = u;
      }
    }
  }
  return [...out.values()];
}

// The unit as GitHub sees it: its PR (by branch, else by number), and a stage GitHub has
// already passed (a merged PR is fusionado; any PR means the worker got to its close).
function live(u, prs) {
  const byBranch = u.rama ? prs.filter((p) => p.headRefName === u.rama) : [];
  const pr = byBranch.find((p) => p.state === "OPEN") ?? byBranch.find((p) => p.state === "MERGED") ?? byBranch[0]
    ?? (u.pr != null ? prs.find((p) => p.number === Number(u.pr)) : null) ?? null;
  let fase = u.fase, byGitHub = false;
  if (pr && u.fase !== "descartado") {
    const want = pr.state === "MERGED" ? "fusionado" : pr.state === "OPEN" ? "cierre-worker" : null;
    if (want && (u.fase === "bloqueado" ? want === "fusionado" : stageOf(u.fase) < stageOf(want))) { fase = want; byGitHub = true; }
  }
  return { ...u, fase, byGitHub, prInfo: pr, prNumber: pr?.number ?? (u.pr ?? null) };
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const open = (target) => exec("/usr/bin/open", [target]).catch(() => null);

export default class Plans extends View {
  init(_props, cx) {
    this.here = [];
    this.other = [];
    this.prs = [];
    this.gh = null; // null ok, else why it failed
    this.loading = false;
    this.updated = null;
    this.cfg = null;
    cx.spawn(async (cx) => {
      this.cfg = await loadConfig();
      this.refresh(cx, true);
      cx.timer.every(LIVE_MS, (cx) => this.refresh(cx, true));
      // Local edits show at once; a burst of writes is read once.
      for (;;) {
        await watchFolder(under(this.cfg.plansDir));
        if (this.watchPending) continue;
        this.watchPending = true;
        cx.timer.after(400, (cx) => { this.watchPending = false; this.refresh(cx, false); });
      }
    });
  }

  refresh(cx, everything) {
    if (!this.cfg || (this.loading && everything)) return;
    if (everything) this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await Promise.all([this.readHere(), ...(everything ? [this.readOther(), this.readGitHub()] : [])]);
      if (everything) this.loading = false;
      this.updated = Date.now();
      cx.notify();
    });
  }

  async readHere() {
    const r = await exec("/bin/sh", ["-c", READ_PACKAGES, "plans", this.cfg.plansDir], { timeout: 10000 }).catch(() => null);
    this.here = parsePackages(r?.stdout);
  }

  async readOther() {
    if (!this.cfg.otherMachine) { this.other = []; return; }
    const r = await exec("/bin/sh", ["-c", READ_PACKAGES, "plans", this.cfg.plansDir], { on: this.cfg.otherMachine, timeout: 12000 }).catch(() => null);
    if (r && r.code === 0) this.other = parsePackages(r.stdout); // offline: keep what it last said
  }

  async readGitHub() {
    if (!this.cfg.repo) { this.prs = []; this.gh = null; return; }
    const r = await exec("gh", ["pr", "list", "--repo", this.cfg.repo, "--state", "all", "--limit", "100",
      "--json", "number,state,isDraft,mergedAt,headRefName,url"], { timeout: 30000 }).catch((e) => ({ code: -1, stderr: String(e) }));
    if (r.code === 0) {
      try { this.prs = JSON.parse(r.stdout); this.gh = null; return; } catch { /* below */ }
    }
    this.gh = (r.stderr || r.stdout || "").trim().split("\n").pop() || "gh no respondió";
  }

  // One package as branches: each unit forks from main, climbs the 7 stages (solid up to where
  // it is, dashed after) and merges back into main once it's fusionado.
  branchGraph(t, pkg) {
    const units = pkg.units, n = units.length;
    const laneW = n <= 6 ? LANE_W : Math.max(16, Math.floor(240 / (n + 1)));
    const x = (lane) => PADX + lane * laneW + laneW / 2;
    const y = (row) => HEAD_H + row * ROW_H + ROW_H / 2;
    const rowOf = (stage) => 8 - stage;
    const width = PADX * 2 + (n + 1) * laneW, height = HEAD_H + 9 * ROW_H;
    const colors = laneColors(t), main = mainColor();
    const paths = new Map();
    const stroke = (color, dashed, draw) => {
      const key = `${color}${dashed ? "-" : ""}`;
      const p = paths.get(key)?.p ?? (dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5));
      paths.set(key, { p: draw(p), color });
    };
    const line = (xa, ya, xb, yb) => (p) => p.move_to(xa, ya).line_to(xb, yb);
    const curve = (xa, ya, xb, yb) => (p) => { const mid = (ya + yb) / 2; return p.move_to(xa, ya).cubic_bezier_to(xb, yb, xa, mid, xb, mid); };

    stroke(main, false, line(x(0), y(0), x(0), y(8)));
    const lanes = units.map((u, i) => {
      const lane = i + 1, color = colors[i % colors.length], xi = x(lane);
      const pos = stageOf(u.fase) || (u.prInfo ? 3 : 1); // bloqueado keeps where GitHub puts it, else Plan
      const merged = u.fase === "fusionado" || u.fase === "visto", dropped = u.fase === "descartado";
      stroke(color, false, curve(x(0), y(8), xi, y(7)));
      if (pos > 1) stroke(color, false, line(xi, y(7), xi, y(rowOf(pos))));
      if (!dropped) {
        if (pos < 7) stroke(t.dim, true, line(xi, y(rowOf(pos)), xi, y(1)));
        stroke(merged ? color : t.dim, !merged, curve(xi, y(1), x(0), y(0)));
      }
      return { u, lane, color, row: rowOf(pos), merged, dropped, blocked: u.fase === "bloqueado" };
    });

    const dot = (cx, cy, size) => div().absolute().left(cx - size / 2).top(cy - size / 2).size(size).rounded(size / 2);
    const short = (id) => (laneW < 28 ? id.replace(/^\D+/, "") : id);
    const graph = div().relative().flex_none().w(width).h(height).overflow_hidden()
      .children([...paths.values()].map(({ p, color }) => window.paint_path(p.build(), color).absolute().top(0).left(0).size_full()))
      // main's tip is a ring, as HEAD is in Graph; where units fork, a dot.
      .child(dot(x(0), y(0), 10).bg(t.background).border(2).border_color(main))
      .child(dot(x(0), y(8), 7).bg(main))
      .children(lanes.map((l) => {
        const d = dot(x(l.lane), y(l.row), 10);
        if (l.blocked) return d.bg(t.background).border(2).border_color(t.blocked);
        if (l.dropped) return d.bg(t.dim);
        if (l.merged) return d.bg(l.color);
        return d.bg(l.color).loop("opacity", { from: 0.35, to: 1, period: 1400 });
      }))
      .children(lanes.map((l) => div().absolute().left(x(l.lane) - laneW / 2).top(5).w(laneW).text_center()
        .text_size(10.5).font_semibold().text_color(l.color).child(short(l.u.id))));

    const encargo = (u) => (u.encargo ? `${under(this.cfg.plansDir)}/${pkg.folder}/${u.encargo}` : null);
    const row = (r) => {
      const here = lanes.filter((l) => l.row === r);
      const el = h_flex().h(ROW_H).gap(8).items_center().min_w(0);
      if (r === 0) {
        return el.child(div().h(18).px(6).flex().items_center().rounded(5).bg("#c8f000").text_color("#1c1c1c").text_size(11).font_medium().child("main"))
          .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child("aquí llegan al fusionarse"));
      }
      if (r === 8) return el.child(div().text_size(11.5).text_color(t.dim).child("de aquí salen"));
      const stage = 8 - r;
      return el.child(div().min_w(0).truncate().text_size(12).text_color(here.length ? t.foreground : t.muted)
        .child(`${stage} ${STAGES[stage - 1].name}`));
    };
    const legend = v_flex().px(10).pt(4).pb(8).gap(1).border_t(1).border_color(t.border).children(lanes.map((l) => {
      const path = encargo(l.u);
      return h_flex().id(`key-${pkg.folder}-${l.u.id}`).h(26).px(6).mx(-6).gap(7).items_center().rounded(6)
        .when(Boolean(path), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => open(path)).tooltip("Abrir el encargo"))
        .child(div().size(8).flex_none().rounded(4).bg(l.color))
        .child(div().flex_none().text_size(12).font_semibold().child(l.u.id))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(l.u.titulo ?? ""))
        .when(l.u.prNumber != null, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`#${l.u.prNumber}`)))
        .child(div().flex_none().text_size(11).text_color(l.blocked ? t.blocked : t.dim).child(LABEL[l.u.fase] ?? l.u.fase));
    }));

    return v_flex().rounded(8).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
      .child(v_flex().px(10).pt(9).pb(4).gap(2)
        .child(div().truncate().text_size(13).font_semibold().child(pkg.titulo ?? pkg.folder))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(pkg.folder)))
      .child(n === 0
        ? div().px(10).pb(10).text_size(12).text_color(t.dim).child("Sin unidades todavía.")
        : h_flex().px(6).items_start()
          .child(graph)
          .child(v_flex().flex_1().min_w(0).pl(6).pr(4)
            .child(div().h(HEAD_H).flex().items_center().text_size(11).text_color(t.dim).child("Etapa"))
            .children([0, 1, 2, 3, 4, 5, 6, 7, 8].map(row))))
      .when(n > 0, (e) => e.child(legend));
  }

  render(_cx) {
    const t = theme();
    const plans = merge([["here", this.here], ["other", this.other]]).filter((p) => p.broken || p.estado !== "cerrado")
      .map((p) => (p.broken ? p : { ...p, units: p.units.map((u) => live(u, this.prs)) }));
    const status = this.loading ? "Actualizando…" : this.updated ? `Actualizado ${clock(this.updated)}` : "";
    return v_flex().id("plans").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(icon("plans")).size(15).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(13).font_medium().child("Planes"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(status))
        .child(div().id("plans-refresh").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Actualizar")
          .on_click((_e, cx) => this.refresh(cx, true))
          .child(svg(icon("refresh")).size(14))))
      .child(v_flex().id("plans-body").flex_1().min_h(0).px(14).pt(12).pb(16).gap(10).overflow_y_scrollbar()
        .when(Boolean(this.gh), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(`GitHub: ${this.gh}`)))
        .when(plans.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim)
          .child(this.updated ? "No hay planes con estado.json activo." : "Leyendo…")))
        .children(plans.map((p) => (p.broken
          ? v_flex().p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.surface)
            .child(div().text_size(12.5).font_medium().child(p.folder))
            .child(div().text_size(12).text_color(t.blocked).child(`El estado.json de ${p.broken === "other" ? this.cfg.otherMachine : "este Mac"} no se puede leer.`))
          : this.branchGraph(t, p)))));
  }
}
