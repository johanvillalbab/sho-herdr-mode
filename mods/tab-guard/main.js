// ⌘W asks first (keys.json: "cmd-w": "mod.open:tab-guard", "mod:tab-guard": { "cmd-w": "tab-guard.confirm" }).
// The tab bar's ✕ opens it too, with props { tab }. The dialog lives in guard.js, shared with pane-guard.
import { guard } from "./guard.js";
export default guard("tab");
