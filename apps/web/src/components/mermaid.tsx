import { useEffect, useId, useState } from "react";

let loader: Promise<typeof import("mermaid").default> | null = null;
const isDark = () =>
  document.documentElement.getAttribute("data-theme") === "dark" ||
  (document.documentElement.getAttribute("data-theme") !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);

/** A Mermaid diagram, rendered on demand (the library loads only on pages that have one), in strict security mode. */
export function MermaidDiagram({ code }: { code: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loader ??= import("mermaid").then((m) => m.default);
    loader
      .then(async (mermaid) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default", fontFamily: "inherit" });
        const out = await mermaid.render(id, code);
        if (!cancelled) setSvg(out.svg);
      })
      .catch((e) => !cancelled && setError(String((e as Error).message ?? e).split("\n")[0]!));
    return () => {
      cancelled = true;
    };
  }, [code, id]);
  if (error)
    return (
      <div className="mermaid-error">
        <p className="small warn">This diagram couldn't be drawn: {error}</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  if (!svg) return <div className="mermaid-diagram loading" aria-busy="true" />;
  // Mermaid sanitises its own SVG output in strict mode.
  return <div className="mermaid-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
