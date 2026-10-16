import { useEffect, useRef, useState } from "react";
import { api, fetchAssetBlob, fileToBase64, type AssetInfo } from "../api";
import { ErrorBox } from "./ui";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/json,application/pdf,text/plain,text/markdown,.md";

/** Object URL for an asset, revoked when the component unmounts. */
function useAssetUrl(id: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!id) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAssetBlob(id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return { url, failed };
}

/** `![alt](asset:<id>)` in markdown. */
export function AssetImage({ id, alt }: { id: string; alt: string }) {
  const { url, failed } = useAssetUrl(id);
  if (failed) return <span className="muted small">[missing image]</span>;
  return url ? <img src={url} alt={alt} /> : <span className="asset-placeholder" />;
}

function Thumb({ asset }: { asset: AssetInfo }) {
  const isImage = asset.mime.startsWith("image/");
  const { url } = useAssetUrl(isImage ? asset.id : undefined);
  return isImage ? (
    url ? <img src={url} alt={asset.alt_text || asset.filename} /> : <span className="asset-placeholder" />
  ) : (
    <span className="asset-file">{asset.filename.split(".").pop()?.toUpperCase() ?? "FILE"}</span>
  );
}

async function download(asset: AssetInfo) {
  const blob = await fetchAssetBlob(asset.id);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Attachments({ targetId, assets, onChange }: { targetId: string; assets: AssetInfo[]; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const mime = file.type || (file.name.endsWith(".md") ? "text/markdown" : "application/octet-stream");
      await api("/assets", { method: "POST", body: { target_id: targetId, filename: file.name, mime, data_base64: await fileToBase64(file), alt_text: alt || undefined } });
      setAlt("");
      onChange();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/assets/${id}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      setError(e as Error);
    }
  }

  return (
    <section className="side-block">
      <h3>Files</h3>
      {assets.length > 0 && (
        <ul className="plain assets">
          {assets.map((a) => (
            <li key={a.id}>
              <button className="asset-thumb" onClick={() => download(a)} title={`Open ${a.filename}`}>
                <Thumb asset={a} />
              </button>
              <div className="asset-meta">
                <span className="small">{a.filename}</span>
                {a.alt_text && <span className="muted small">{a.alt_text}</span>}
                <span className="asset-actions">
                  {a.mime.startsWith("image/") && (
                    <button
                      className="link-btn small"
                      onClick={() => {
                        void navigator.clipboard?.writeText(`![${a.alt_text || a.filename}](asset:${a.id})`);
                        setCopied(a.id);
                      }}
                    >
                      {copied === a.id ? "Copied" : "Copy markdown"}
                    </button>
                  )}
                  <button className="link-btn small danger" onClick={() => remove(a.id)}>
                    Remove
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Description (optional)" className="small-input" aria-label="File description" />
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <button className="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : "Attach screenshot or file"}
      </button>
      <p className="muted small">Images are not scanned for secrets. Don't upload screenshots that show any.</p>
      <ErrorBox error={error} />
    </section>
  );
}
