import { describe, expect, it } from "vitest";
import { draftArticle, draftFinding } from "../src/paste";

describe("paste to draft", () => {
  it("pulls labelled parts out of incident notes", () => {
    const d = draftFinding(`Refund webhook processed twice

Symptoms: customers refunded twice for one return
Root cause: the consumer had no idempotency key, so retries re-ran the refund
Fix: store the provider event id and skip repeats
Also added an alert on duplicate refunds.`);
    expect(d).toMatchObject({
      title: "Refund webhook processed twice",
      type: "rca",
      symptoms: "customers refunded twice for one return",
      root_cause: "the consumer had no idempotency key, so retries re-ran the refund",
    });
    expect(d.fix).toBe("store the provider event id and skip repeats\nAlso added an alert on duplicate refunds.");
  });

  it("drops chat noise from a Slack thread and keeps the message text", () => {
    const d = draftFinding(`Alex  10:42 AM
Checkout is throwing 502s for EU users
:eyes: 2
Sam  10:45 AM
looks like the CDN origin cert expired
(edited)
Alex  10:58 AM
renewed it, errors gone`);
    expect(d.title).toBe("Checkout is throwing 502s for EU users");
    expect(d.symptoms).toContain("CDN origin cert expired");
    expect(d.symptoms).not.toMatch(/10:4|:eyes:|edited/);
    expect(d.type).toBe("incident");
  });

  it("uses the first message as the symptom when nothing is labelled", () => {
    const d = draftFinding("Alex  10:42 AM\nCheckout is throwing 502s for EU users\nSam  10:45 AM\nRoot cause: CDN origin cert expired");
    expect(d.symptoms).toBe("Checkout is throwing 502s for EU users");
    expect(d.root_cause).toBe("CDN origin cert expired");
  });

  it("strips email headers and signatures", () => {
    const d = draftFinding(`Subject: Known issue: exports time out over 50k rows
From: someone
Exports over 50k rows time out after 30s.
Workaround: filter by month and export in parts.
--
Jane, Support`);
    expect(d.title).toBe("Known issue: exports time out over 50k rows");
    expect(d.type).toBe("known_issue");
    expect(d.fix).toBe("filter by month and export in parts.");
    expect(JSON.stringify(d)).not.toContain("Jane");
  });

  it("turns a pasted doc into an article with headings", () => {
    const a = draftArticle(`Payment retries

Context:
Retries were unbounded.

Decision:
We decided to cap retries at five with jitter.`);
    expect(a.title).toBe("Payment retries");
    expect(a.type).toBe("decision");
    expect(a.body_md).toBe("## Context\nRetries were unbounded.\n\n## Decision\nWe decided to cap retries at five with jitter.");
  });

  it("wraps plain text in a Context section", () => {
    expect(draftArticle("Title\nJust some text.").body_md).toBe("## Context\n\nJust some text.");
  });
});
