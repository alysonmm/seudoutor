import { handle } from '@/server/http';
import { currentVersion } from '@/server/modules/documents';

export const GET = handle<{ key: string }>(async (_req, { key }) => {
  const v = await currentVersion(key);
  return { key: v.key, title: v.title, version: v.version, status: v.status, hash: v.content_hash, body: v.body_md, isDraft: v.status !== 'published' };
});
