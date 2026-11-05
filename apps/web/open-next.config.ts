import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Pages render on request; the public HTML pages are cached at the edge by worker.ts (src/lib/edge-cache.ts).
export default defineCloudflareConfig({});
