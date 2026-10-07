import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Pages render on request (data changes hourly); caching can be added later with R2/KV.
export default defineCloudflareConfig({});
