import { startPost } from '@/lib/social-server';

export const dynamic = 'force-dynamic';

/** /admin/social: check the draft and open one Meta upload session per channel (src/lib/social-server.ts). */
export function POST(req: Request): Promise<Response> {
  return startPost(req);
}
