// Secrets 通过 `wrangler secret put` 或本地 `.dev.vars` 注入，不写入 wrangler.jsonc
interface Env {
  ADMIN_PASSWORD?: string;
  ALLOW_UNAUTHENTICATED_LOCAL?: string;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_PASSWORD?: string;
    ALLOW_UNAUTHENTICATED_LOCAL?: string;
  }
}
