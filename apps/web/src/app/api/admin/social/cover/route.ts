import { setCover } from '@/lib/social-server';

export const dynamic = 'force-dynamic';

/** /admin/social: the chosen frame (JPEG) as the Facebook Reel's cover, after the post is published. */
export function PUT(req: Request): Promise<Response> {
  return setCover(req);
}
