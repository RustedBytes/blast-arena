// Merges a stylesheet's top-level @media rules: every rule for one query is
// moved into a single block at the end, after all the unconditional rules.
//
// The SCSS keeps each component's responsive rules next to the component,
// which repeats the same @media wrapper dozens of times; this writes each
// query once. The blocks come out in the order of `ORDER` (wider screens
// first, so the narrower ones win where both apply), then any other query
// in the order it first appeared.

import postcss from 'postcss';

/** Queries in cascade order, normalized (no spaces, lower case). */
const ORDER = [
  '(max-width:820px)', // the lobby stacks its cards
  '(max-width:700px),(max-height:500px)', // phones: a compact HUD
  '(max-width:700px)', // phones held upright
  '(max-width:560px)', // narrow screens
  '(max-width:560px)and(max-height:700px)', // small phones
  '(max-width:380px)', // the smallest phones
  '(max-height:500px)', // phones held sideways
  '(min-width:1700px)and(min-height:950px)', // large displays scale the HUD up
  '(min-width:2200px)and(min-height:1250px)',
  '(min-width:3000px)and(min-height:1700px)',
  '(prefers-reduced-motion:reduce)',
];

const normalize = (params) => params.replace(/\s+/g, '').toLowerCase();

/** The stylesheet with its top-level @media rules merged (see above). */
export function mergeMedia(css) {
  const root = postcss.parse(css);
  const groups = new Map();
  root.each((node) => {
    if (node.type !== 'atrule' || node.name !== 'media') return;
    const key = normalize(node.params);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = postcss.atRule({ name: 'media', params: node.params })));
    group.append(node.nodes);
    node.remove();
  });
  const rank = (key) => {
    const i = ORDER.indexOf(key);
    return i < 0 ? ORDER.length : i;
  };
  // A stable sort keeps unknown queries in their order of appearance.
  const sorted = [...groups].sort(([a], [b]) => rank(a) - rank(b));
  for (const [, group] of sorted) root.append(group);
  return root.toString();
}
