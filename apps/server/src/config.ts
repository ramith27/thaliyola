import { z } from "zod";

const Env = z
  .object({
    PORT: z.coerce.number().default(8080),
    DATABASE_URL: z.string().default("postgres://cairn:cairn@localhost:5432/cairn"),
    AUTH_MODE: z.enum(["dev", "cloudflare"]).default("dev"),
    // dev mode: comma-separated "token=email" pairs
    DEV_TOKENS: z.string().default(""),
    // cloudflare mode: https://<team>.cloudflareaccess.com and the Access app's AUD tag
    CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
    CF_ACCESS_AUD: z.string().optional(),
    // Emails that may approve anywhere and manage projects and members
    ADMIN_EMAILS: z.string().default(""),
    // Share of a proposal's terms an existing finding must contain to count as a near-duplicate
    DUPLICATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "dev" && !env.DEV_TOKENS.trim()) {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev requires DEV_TOKENS (token=email pairs)" });
    }
    if (env.AUTH_MODE === "cloudflare" && (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD)) {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=cloudflare requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD" });
    }
  });

export type Config = z.infer<typeof Env>;

export function settingsFrom(config: Config): Settings {
  return {
    adminEmails: config.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    duplicateThreshold: config.DUPLICATE_THRESHOLD,
  };
}

export interface Settings {
  adminEmails: string[];
  duplicateThreshold: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
