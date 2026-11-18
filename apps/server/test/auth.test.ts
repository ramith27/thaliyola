import type { Request } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudflareAuthenticator, devAuthenticator } from "../src/auth/index.js";

const AUD = "test-aud-tag";
let server: Server;
let issuer: string;
let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  // Stand-in for https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
  server = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const req = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

describe("cloudflareAuthenticator", () => {
  it("accepts a valid Access JWT for a user", async () => {
    const auth = cloudflareAuthenticator(issuer, AUD);
    const token = await sign({ email: "Alice@Example.com", sub: "u1" });
    expect(await auth(req({ "cf-access-jwt-assertion": token }))).toEqual({
      subject: "cf:alice@example.com",
      email: "alice@example.com",
      kind: "human",
    });
  });

  it("passes on a user's name from the claims, and nothing when there is none", async () => {
    const auth = cloudflareAuthenticator(issuer, AUD);
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ email: "ada@example.com", name: " Ada  Lovelace " }) }))).toEqual({
      subject: "cf:ada@example.com",
      email: "ada@example.com",
      kind: "human",
      name: "Ada Lovelace",
    });
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ email: "ada@example.com", given_name: "Ada", family_name: "Lovelace" }) }))).toMatchObject({
      name: "Ada Lovelace",
    });
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ email: "ada@example.com", common_name: "Ada L" }) }))).toMatchObject({ name: "Ada L" });
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ email: "ada@example.com", name: "ada@example.com" }) }))).not.toHaveProperty("name");
    // A service token's common_name is its client id, not a name.
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ common_name: "abc.access" }) }))).not.toHaveProperty("name");
  });

  it("maps a service token to a service identity", async () => {
    const auth = cloudflareAuthenticator(issuer, AUD);
    const token = await sign({ common_name: "abc.access", sub: "" });
    expect(await auth(req({ "cf-access-jwt-assertion": token }))).toEqual({ subject: "cf-svc:abc.access", email: null, kind: "service" });
  });

  it("rejects a missing header, wrong audience and wrong issuer", async () => {
    const auth = cloudflareAuthenticator(issuer, AUD);
    expect(await auth(req({}))).toBeNull();
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ email: "a@b.c" }, { aud: "other" }) }))).toBeNull();
    expect(await auth(req({ "cf-access-jwt-assertion": await sign({ email: "a@b.c" }, { iss: "https://evil.example" }) }))).toBeNull();
    expect(await auth(req({ "cf-access-jwt-assertion": "not-a-jwt" }))).toBeNull();
  });
});

describe("devAuthenticator", () => {
  it("maps configured bearer tokens to users", async () => {
    const auth = devAuthenticator("t1=alice@example.com, t2=svc-rca@example.com");
    expect(await auth(req({ authorization: "Bearer t1" }))).toMatchObject({ subject: "dev:alice@example.com", kind: "human" });
    expect(await auth(req({ authorization: "Bearer t2" }))).toMatchObject({ kind: "service" });
    expect(await auth(req({ authorization: "Bearer nope" }))).toBeNull();
    expect(await auth(req({}))).toBeNull();
  });
});
