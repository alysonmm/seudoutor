import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { inviteMember, inviteSchema } from '@/server/modules/orgs';

export const POST = handle<{ orgId: string }>(async (req, { orgId }) => {
  const s = await requireAuth(req);
  const r = await inviteMember(s.userId, orgId, await body(req, inviteSchema));
  return { invitationId: r.invitationId }; // o token vai por e-mail ao destinatário, não ao convidante
});
