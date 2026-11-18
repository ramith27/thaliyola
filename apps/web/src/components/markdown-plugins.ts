/** remark plugins for the Markdown component (pure, so they can be tested without a DOM). */

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

const COMMENT = /^\s*<!--([\s\S]*?)-->\s*$/;

/**
 * The editor's own notes: a table article's sync markers and template hints. Nothing else is hidden, so a comment
 * written into an article can't carry text that agents read (get_article returns the raw Markdown) but people don't.
 */
export const isEditorMarker = (comment: string) => /^\s*<!--\s*(\/?thaliyola:sync|Hint:[\s\S]*?)\s*-->\s*$/.test(comment);

/**
 * How HTML comments read:
 * - "markers" (reading an article): the editor's markers are hidden, any other comment shows as a muted
 *   "Hidden comment" block, so readers see what agents see;
 * - "all" (reviewing a proposal): every comment shows, markers and hints included, since a hint can carry text too.
 * Code blocks are other nodes, so a comment inside one is left alone.
 */
export function htmlComments(mode: "markers" | "all" = "markers") {
  const shown = (text: string, inline: boolean): MdNode => ({
    type: inline ? "emphasis" : "paragraph",
    data: {
      hName: inline ? "span" : "div",
      hProperties: { className: ["md-comment"], title: "Hidden comment: readers of the source and agents see this" },
    },
    children: [{ type: "text", value: text.trim() }],
  });
  const walk = (node: MdNode, inline: boolean) => {
    if (!node.children) return;
    const out: MdNode[] = [];
    for (const c of node.children) {
      const m = c.type === "html" ? COMMENT.exec(c.value ?? "") : null;
      if (!m) {
        walk(c, inline || c.type === "paragraph" || c.type === "heading" || c.type === "tableCell");
        out.push(c);
      } else if (mode === "markers" && isEditorMarker(c.value ?? "")) {
        continue;
      } else {
        out.push(shown(`Hidden comment: ${m[1]!.trim()}`, inline));
      }
    }
    node.children = out;
  };
  return (tree: MdNode) => walk(tree, false);
}
