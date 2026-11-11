import { finishPost } from '@/lib/social-server';

export const dynamic = 'force-dynamic';

/** /admin/social: publish after the last chunk, then report Meta's progress until the post is live. */
export function POST(req: Request): Promise<Response> {
  return finishPost(req);
}
