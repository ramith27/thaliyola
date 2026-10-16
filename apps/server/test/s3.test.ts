import { describe, expect, it } from "vitest";
import { S3AssetStore } from "../src/core/s3.js";

describe("S3 signing", () => {
  // Reference values from the AWS Signature V4 documentation example
  // ("GET Object" with a Range header removed is not published, so we check structure
  // and determinism here; the live round trip runs against a real S3-compatible server).
  it("produces a well-formed, deterministic SigV4 authorization header", () => {
    const store = new S3AssetStore({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    const url = new URL("https://s3.amazonaws.com/examplebucket/a%20b/c.png");
    const now = new Date("2013-05-24T00:00:00Z");
    const h1 = store.signedHeaders("GET", url, null, now);
    const h2 = store.signedHeaders("GET", url, null, now);
    expect(h1).toEqual(h2);
    expect(h1["x-amz-date"]).toBe("20130524T000000Z");
    expect(h1["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(h1.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(store.signedHeaders("PUT", url, Buffer.from("x"), now).authorization).not.toBe(h1.authorization);
  });
});

// Live round trip: S3_TEST_ENDPOINT=http://127.0.0.1:3900 S3_TEST_BUCKET=… S3_TEST_KEY=… S3_TEST_SECRET=… [S3_TEST_REGION=…]
describe.runIf(!!process.env.S3_TEST_ENDPOINT)("S3 round trip", () => {
  it("stores and fetches objects, and reports missing ones", async () => {
    const store = new S3AssetStore({
      endpoint: process.env.S3_TEST_ENDPOINT!,
      region: process.env.S3_TEST_REGION ?? "us-east-1",
      bucket: process.env.S3_TEST_BUCKET!,
      accessKeyId: process.env.S3_TEST_KEY!,
      secretAccessKey: process.env.S3_TEST_SECRET!,
      prefix: "thaliyola-test",
    });
    const key = `ab/${"ab".padEnd(64, "0")}`;
    const data = Buffer.from(`hello ${Date.now()}`);
    await store.put(key, data);
    expect((await store.get(key)).equals(data)).toBe(true);
    await expect(store.get(`cd/${"cd".padEnd(64, "0")}`)).rejects.toThrow(/not found/);
  });

  it("refuses requests signed with the wrong secret", async () => {
    const store = new S3AssetStore({
      endpoint: process.env.S3_TEST_ENDPOINT!,
      region: process.env.S3_TEST_REGION ?? "us-east-1",
      bucket: process.env.S3_TEST_BUCKET!,
      accessKeyId: process.env.S3_TEST_KEY!,
      secretAccessKey: "wrong-secret",
    });
    await expect(store.put(`ef/${"ef".padEnd(64, "0")}`, Buffer.from("x"))).rejects.toThrow(/403/);
  });
});
