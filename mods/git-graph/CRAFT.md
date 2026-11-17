# Craft changes to git-graph

Installed from github.com/rabeeh-ta/herdr-git-graph (v0.3.3, commit 0da8862) and
adapted to Craft's look. An update replaces this folder, so reapply these after one.

1. `craft.js` (new): Craft's roles (Human v2.1 palette): accent `#57652d`
   light / `#c8f000` dark, lime fill `#c8f000` with ink `#1c1c1c`, selection tint
   `#57652d29` light / `#c8f00029` dark.
2. `graph.js`:
   - imports `craft` from `./craft.js`;
   - `laneColors`: Craft's accent first, then ansi4, ansi5, ansi3, ansi6, ansi1, ansi12,
     ansi13, ansi11, ansi14, ansi2, ansi9 (green moved back: it reads too close to olive);
   - `label()`: the checked-out branch and a detached HEAD are lime with ink text;
   - selected commit row, active picker row and the current Manygit repo use the
     Craft selection tint instead of `t.selected`;
   - header title "Graph" instead of "Git".
3. `icons/`: Lucide swapped for Phosphor (MIT, `LICENSE-phosphor.txt`), same file
   names. Bold for icons drawn at 12px or less (check, cloud, commit, branch, folder,
   tag), regular for the rest. back=caret-left, push=arrow-up, fetch=arrow-down,
   revert=arrow-counter-clockwise, reset=arrow-u-up-left, rebase=arrows-down-up,
   merge=git-merge, cherry=cherries, stash=archive, rename=pencil-simple,
   graph=git-fork, refresh=arrows-clockwise, settings=gear-six.

Outside this folder: `mods/craft-tabs` (clone of `tabs` with the Graph button and
`togglePanel`, per the repo's docs/top-bar.md), `layouts/main-craft.json` (tabs block
uses `craft-tabs`, `panel-body` has a `graph` block) and `keys.json`
`"layout:main-craft": { "cmd-g": "craft-tabs.graph" }`.
