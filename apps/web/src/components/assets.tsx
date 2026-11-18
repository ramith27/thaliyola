import { useEffect, useState, type FormEvent } from "react";
import { api, fetchAssetBlob, fileToBase64, type AssetInfo } from "../api";
import { Button, Callout, Card, Dialog, ErrorState, Field, FileDrop, IconButton, OverflowMenu, TextInput, useConfirm, useToast } from "./kit";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/json,application/pdf,text/plain,text/markdown,.md";

/** The static site export ships assets as files; it registers where each one is. */
let staticAssets: Record<string, string> | null = null;
export function setStaticAssets(map: Record<string, string>) {
  staticAssets = map;
}

/** Object URL for an asset, revoked when the component unmounts. */
function useAssetUrl(id: string | undefined) {
  const [url, setUrl] = useState<string | null>(id && staticAssets ? (staticAssets[id] ?? null) : null);
  const [failed, setFailed] = useState(!!(id && staticAssets && !staticAssets[id]));
  useEffect(() => {
    if (!id || staticAssets) return;
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

/** `![alt](asset:<id>)` in markdown. Also used by the static viewer: no kit dialogs or boot here. */
export function AssetImage({ id, alt }: { id: string; alt: string }) {
  const { url, failed } = useAssetUrl(id);
  if (failed) return <span className="muted small">[missing image]</span>;
  return url ? <img src={url} alt={alt} /> : <span className="asset-placeholder" />;
}

function Thumb({ asset }: { asset: AssetInfo }) {
  const isImage = asset.mime.startsWith("image/");
  const { url } = useAssetUrl(isImage ? asset.id : undefined);
  return isImage ? (
    url ? <img src={url} alt="" /> : <span className="asset-placeholder" />
  ) : (
    <span className="it-file-ext">{asset.filename.split(".").pop()?.toUpperCase() ?? "FILE"}</span>
  );
}

async function openFile(asset: AssetInfo) {
  const blob = await fetchAssetBlob(asset.id);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Files card in an item's rail: each file with a thumbnail (opens it), its name and description, and a ⋯ menu
 * (Copy markdown for images, Remove…). The header "+" opens the upload dialog.
 */
export function Attachments({ targetId, assets, onChange }: { targetId: string; assets: AssetInfo[]; onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [uploading, setUploading] = useState(false);

  async function remove(a: AssetInfo) {
    const ok = await confirm({
      title: `Remove ${a.filename}?`,
      body: "Articles that show it will show a broken image.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/assets/${a.id}`, { method: "DELETE" });
      onChange();
      toast.success(`Removed ${a.filename}`);
    } catch (e) {
      toast.error(e, { title: `Couldn't remove ${a.filename}` });
    }
  }

  return (
    <Card
      title="Files"
      padding="sm"
      as="section"
      actions={<IconButton icon="plus" size="sm" label="Upload a file" aria-haspopup="dialog" onClick={() => setUploading(true)} />}
    >
      {assets.length === 0 ? (
        <p className="it-rail-empty">No files yet</p>
      ) : (
        <ul className="it-files">
          {assets.map((a) => (
            <li key={a.id} className="it-file">
              <button type="button" className="it-file-thumb" onClick={() => void openFile(a).catch((e) => toast.error(e, { title: `Couldn't open ${a.filename}` }))} aria-label={`Open ${a.filename}`}>
                <Thumb asset={a} />
              </button>
              <div className="it-file-meta">
                <span className="it-file-name">{a.filename}</span>
                {a.alt_text && <span className="it-file-desc">{a.alt_text}</span>}
              </div>
              <OverflowMenu
                size="sm"
                label={`Actions for ${a.filename}`}
                items={[
                  ...(a.mime.startsWith("image/")
                    ? [
                        {
                          id: "copy",
                          label: "Copy markdown",
                          icon: "copy" as const,
                          hint: "Paste it into the text to show the image",
                          onSelect: async () => {
                            if (await copyText(`![${a.alt_text || a.filename}](asset:${a.id})`)) toast.success("Copied");
                            else toast.error("Couldn't copy the markdown");
                          },
                        },
                        { type: "separator" as const },
                      ]
                    : []),
                  { id: "remove", label: "Remove…", icon: "trash", tone: "danger", onSelect: () => void remove(a) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      <UploadDialog targetId={targetId} open={uploading} onClose={() => setUploading(false)} onUploaded={onChange} />
    </Card>
  );
}

function UploadDialog({ targetId, open, onClose, onUploaded }: { targetId: string; open: boolean; onClose: () => void; onUploaded: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);

  function close() {
    if (busy) return;
    setFile(null);
    setAlt("");
    setError(null);
    setMissing(false);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setMissing(true);
      // Take the person to the control that fixes it: the file drop's Choose file button.
      document.getElementById(`it-upload-${targetId}`)?.querySelector<HTMLButtonElement>(".file-drop button")?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const mime = file.type || (file.name.endsWith(".md") ? "text/markdown" : "application/octet-stream");
      await api("/assets", { method: "POST", body: { target_id: targetId, filename: file.name, mime, data_base64: await fileToBase64(file), alt_text: alt.trim() || undefined } });
      onUploaded();
      toast.success(`Uploaded ${file.name}`);
      setBusy(false);
      setFile(null);
      setAlt("");
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!busy}
      title="Attach a screenshot or file"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`it-upload-${targetId}`} loading={busy} loadingText="Uploading…">
            Upload
          </Button>
        </>
      }
    >
      <form id={`it-upload-${targetId}`} className="it-dialog-form" noValidate onSubmit={submit}>
        <FileDrop
          label="File"
          accept={ACCEPT}
          file={file}
          busy={busy}
          busyText="Uploading…"
          onFile={(f) => {
            setFile(f);
            setMissing(false);
          }}
          hint="Images (PNG, JPEG, WebP, GIF), PDF, JSON, text or Markdown."
        />
        {missing && (
          <p className="it-dialog-error" role="alert">
            Choose a file to upload.
          </p>
        )}
        <Field label="Description" optional hint="Used as the image's alt text.">
          <TextInput value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={300} />
        </Field>
        <Callout tone="warning">Images aren't scanned for secrets. Don't upload screenshots that show any.</Callout>
        {!!error && <ErrorState compact error={error} title="Couldn't upload it" />}
      </form>
    </Dialog>
  );
}
