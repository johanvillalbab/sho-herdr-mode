// Craft look for the graph: the Human v2.1 roles Craft adds on top of the theme
// (the craft-light and craft-dark themes). The olive accent (lime in dark) leads
// the lanes, lime with ink marks where you are, and selection is an accent tint.
import { settings } from "herdr";

export function craft() {
  const dark = settings()?.dark !== false;
  return {
    accent: dark ? "#c8f000" : "#57652d",
    fill: "#c8f000",
    fillFg: "#1c1c1c",
    selectedBg: dark ? "#c8f00029" : "#57652d29",
  };
}
