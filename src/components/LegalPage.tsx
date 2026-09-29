import { currentVersion } from '@/server/modules/documents';
import Markdown from './Markdown';

export default async function LegalPage({ docKey }: { docKey: string }) {
  try {
    const v = await currentVersion(docKey);
    return (<>
      {v.status !== 'published' && <div className="banner" role="alert"><strong>MINUTA — REVISÃO JURÍDICA PENDENTE.</strong> Este texto não foi aprovado e não vale como documento final.</div>}
      <Markdown source={v.body_md} />
      <p className="small muted">Versão {v.version} • hash {v.content_hash.slice(0, 12)} • {v.status === 'published' ? 'publicada' : 'minuta'}</p>
    </>);
  } catch {
    return <div className="banner" role="alert">Este documento ainda não foi publicado. Fale conosco pelo canal de contato.</div>;
  }
}
