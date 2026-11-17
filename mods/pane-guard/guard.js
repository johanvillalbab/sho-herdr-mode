// Kept identical in mods/tab-guard/guard.js and mods/pane-guard/guard.js (a mod can't import
// from another mod's folder): edit one, copy it over the other.
// A dialog that asks before a tab or a pane closes by hand. It names what closes and closes it
// only on the same key again (or its button). Esc, a click beside it or any other key cancels.
// Enter does nothing, so a message being typed can't close anything by accident.
// Opened by a key (mod.open) it targets what's focused; opened by a click it gets props
// { tab } or { pane }. Scripts and agents that run tab.close or pane.close never come here.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, focused, spaces, panes, nextCommand, theme } from "herdr";

const quote = (tab) => (tab.named ? `«${tab.name}»` : `la pestaña ${tab.name}`);

const KINDS = {
  tab: {
    keystroke: "cmd-w",
    key: "⌘W",
    button: "Cerrar pestaña",
    target() {
      const id = props()?.tab ?? focused()?.tab;
      const space = spaces().find((s) => s.tabs.some((t) => t.id === id));
      const tab = space?.tabs.find((t) => t.id === id);
      return tab && { id, tab, lastInSpace: space.tabs.length === 1 };
    },
    title: (x) => `¿Cerrar ${quote(x.tab)}?`,
    detail: (x) => (x.lastInSpace
      ? "Es la última pestaña: también se cierra el espacio. Sus terminales y agentes se terminan."
      : "Sus terminales y agentes se terminan."),
    // The last tab closes its space: Herdr asks about that itself.
    close: (x) => run("tab.close", { id: x.id }),
  },
  pane: {
    keystroke: "cmd-shift-w",
    key: "⌘⇧W",
    button: "Cerrar panel",
    target() {
      const id = props()?.pane ?? focused()?.pane;
      const pane = panes().find((p) => p.pane === id);
      if (!pane) return null;
      const space = spaces().find((s) => s.tabs.some((t) => t.id === pane.tab));
      const tab = space?.tabs.find((t) => t.id === pane.tab);
      const alone = panes().filter((p) => p.tab === pane.tab).length === 1;
      return { id, pane, tab, alone, lastInSpace: alone && space?.tabs.length === 1 };
    },
    title: (x) => `¿Cerrar el panel de ${x.pane.terminal ? x.pane.program?.name ?? x.pane.title : x.pane.title}?`,
    detail: (x) => {
      const ends = x.pane.terminal ? " Su terminal se termina." : "";
      if (!x.alone || !x.tab) return ends.trim();
      const also = x.lastInSpace ? "también se cierran la pestaña y el espacio" : `también se cierra ${quote(x.tab)}`;
      return `Es el único panel de la pestaña: ${also}.${ends}`;
    },
    close: (x) => run("pane.close", { pane: x.id }),
  },
};

export function guard(kindName) {
  const kind = KINDS[kindName];
  return class Guard extends View {
    init(_props, cx) {
      // Kept from when it opened, so a later focus change can't redirect the close.
      this.target = kind.target();
      this.byClick = Boolean(props()?.[kindName]);
      this.done = false;
      if (!this.target) { this.close(); return; }
      this.handle = cx.focus_handle();
      this.handle.focus();
      cx.spawn(async () => {
        for (;;) if ((await nextCommand()) === "confirm") this.confirm();
      });
    }

    close() {
      const overlay = props()?.overlay;
      if (overlay) closeOverlay(overlay);
    }

    cancel() {
      if (this.done) return;
      this.done = true;
      this.close();
    }

    confirm() {
      if (this.done) return;
      this.done = true;
      this.close();
      kind.close(this.target);
    }

    render(_cx) {
      const t = theme();
      if (!this.target) return div();
      const again = this.byClick ? "" : `Presiona ${kind.key} otra vez para confirmar. `;
      const button = (id, label, hint, bg, fg, border, onClick) =>
        h_flex().id(id).h(32).px(12).gap(8).items_center().rounded(8).border_1().border_color(border).bg(bg)
          .text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick)
          .child(label).child(div().text_size(11).opacity(0.7).child(hint));
      return v_flex()
        .id("guard")
        .track_focus(this.handle)
        .on_key_down((e, cx) => {
          cx.stop_propagation();
          if (e.keystroke === kind.keystroke) this.confirm();
          else this.cancel();
        })
        .size_full().min_h(0).p(18).gap(10).rounded(8).bg(t.popover).text_size(13)
        .child(div().truncate().text_size(15).font_semibold().text_color(t.foreground).child(kind.title(this.target)))
        .child(div().flex_1().min_h(0).text_color(t.muted).child(`${again}${kind.detail(this.target)}`))
        .child(h_flex().justify_end().gap(8).text_size(12)
          .child(button("no", "Cancelar", "Esc", t.raised, t.foreground, t.input, () => this.cancel()))
          .child(button("yes", kind.button, kind.key, t.solid, t.solid_foreground, t.solid, () => this.confirm())));
    }
  };
}
