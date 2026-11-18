/**
 * Help › About Thaliyola: the version this server runs, the commit it was built from and when, and the newest
 * release notes. Reads `me.build` and `me.whats_new` from boot (older servers: "unknown").
 */
import type { Me } from "../api";
import { href } from "../router";
import { formatTimestamp } from "./labels";
import { Button } from "./kit/button";
import { CopyButton } from "./kit/display";
import { Facts } from "./kit/data";
import { Dialog } from "./kit/overlay";
import { versionText } from "./releases";

export function AboutDialog({ open, onClose, me }: { open: boolean; onClose: () => void; me: Me }) {
  const b = me.build;
  const latest = me.whats_new?.latest;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="About Thaliyola"
      description={b ? `Version ${versionText(b)}` : "This server doesn't report its version."}
      size="sm"
      footer={
        <Button variant="primary" icon="sparkle" href={href("/whats-new")} onClick={onClose}>
          What's new
        </Button>
      }
    >
      <Facts
        items={[
          { term: "Version", value: b ? <code>{b.version}</code> : <span className="muted">unknown</span> },
          {
            term: "Commit",
            value: b?.commit ? (
              <span className="tl-row">
                <code className="tl-break">{b.commit.slice(0, 12)}</code>
                <CopyButton text={b.commit} label="Copy commit" />
              </span>
            ) : (
              <span className="muted">not recorded for this build</span>
            ),
          },
          { term: "Built", value: b?.built_at ? formatTimestamp(b.built_at) : <span className="muted">run from source</span> },
          {
            term: "Latest release notes",
            value: latest ? <a href={href("/whats-new", { tab: "releases", release: latest.version })}>Thaliyola {latest.version}{latest.title ? `: ${latest.title}` : ""}</a> : <span className="muted">none published yet</span>,
          },
        ]}
      />
    </Dialog>
  );
}
