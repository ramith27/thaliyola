import { ValidationError } from "../context.js";
import { base, call, failWith } from "./remote.js";
import type { ConnTarget, DriverEnv, TestResult } from "./types.js";

/**
 * Trello as a place notifications go: a card per event on one list (API key and token). Test reads the list, then adds
 * a test card to it, so people see where cards will land.
 */

export function trelloAuth(c: ConnTarget): URLSearchParams {
  return new URLSearchParams({ key: c.secret.api_key ?? "", token: c.secret.token ?? "" });
}

/** One card: a name (the notification's title) and a description (its text and a link). */
export interface TrelloCard {
  name: string;
  desc: string;
}

/** Adds a card to the connection's list. Throws when Trello doesn't take it. */
export async function postTrello(c: ConnTarget, env: DriverEnv, card: TrelloCard): Promise<void> {
  const params = trelloAuth(c);
  const res = await call(`${base(env, "trello", "https://api.trello.com")}/1/cards?${params}`, "http", env, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    // Trello caps names at 16384 and descriptions at 16384 characters; ours stay far below.
    body: JSON.stringify({ idList: c.config.list_id, name: card.name.slice(0, 300), desc: card.desc.slice(0, 4000), pos: "top" }),
  });
  if (res.status === 404 || res.status === 400) throw new ValidationError("Trello couldn't add the card (check the list ID, and that the token's account can see the board)");
  if (res.status < 200 || res.status >= 300) failWith(res, "Trello");
}

export async function testTrello(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const params = trelloAuth(c);
  params.set("fields", "name,closed");
  const res = await call(`${base(env, "trello", "https://api.trello.com")}/1/lists/${encodeURIComponent(c.config.list_id!)}?${params}`, "http", env, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404 || res.status === 400) throw new ValidationError("Trello couldn't find that list (check the list ID, and that the token's account can see the board)");
  if (res.status !== 200) failWith(res, "Trello");
  const list = JSON.parse(res.text) as { name: string; closed?: boolean };
  await postTrello(c, env, { name: "Thaliyola test card", desc: "A test from Thaliyola: notifications routed to this connection arrive as cards on this list. You can archive this card." });
  return {
    detail: `Connected to Trello and added a test card to the list "${list.name}".`,
    warning: list.closed ? "That list is archived; cards added to it won't show on the board." : undefined,
  };
}
