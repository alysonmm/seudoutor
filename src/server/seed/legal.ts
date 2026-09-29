import fs from 'node:fs';
import path from 'node:path';
import { upsertDocumentDraft } from '../modules/documents';

export const LEGAL_DOCS: { key: string; title: string; audience: string }[] = [
  { key: 'termos-paciente', title: 'Termos de Uso do Paciente', audience: 'patient' },
  { key: 'contrato-profissional', title: 'Contrato de Prestação de Software para Médicos e Clínicas', audience: 'practitioner' },
  { key: 'aviso-privacidade', title: 'Aviso de Privacidade', audience: 'all' },
  { key: 'politica-cancelamentos', title: 'Política de Cancelamentos', audience: 'all' },
  { key: 'politica-avaliacoes', title: 'Política de Avaliações', audience: 'all' },
  { key: 'politica-cookies', title: 'Política de Cookies', audience: 'all' },
  { key: 'confidencialidade-interna', title: 'Termo Interno de Confidencialidade', audience: 'internal' },
];

/** Carrega as MINUTAS de docs/legal/<key>.md como `draft_minuta`. Nunca publica nem aprova. */
export async function seedLegalDrafts(root = process.cwd()) {
  for (const d of LEGAL_DOCS) {
    const file = path.join(root, 'docs/legal', `${d.key}.md`);
    if (!fs.existsSync(file)) continue;
    await upsertDocumentDraft(d.key, d.title, d.audience, fs.readFileSync(file, 'utf8'));
  }
}
