// ⌘⇧W asks first (keys.json: "cmd-shift-w": "mod.open:pane-guard", "mod:pane-guard": { "cmd-shift-w": "pane-guard.confirm" }).
// Same dialog as tab-guard, for the focused pane.
import { guard } from "./guard.js";
export default guard("pane");
