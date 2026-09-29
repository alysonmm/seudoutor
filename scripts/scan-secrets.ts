/** Varredura simples de segredos versionados (padrões comuns). Complementa, não substitui, uma ferramenta dedicada no CI. */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files -co --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
const patterns: [string, RegExp][] = [
  ['chave privada', /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['token GitHub', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['token Slack', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['chave sk-', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['atribuição de segredo', /(SECRET|PASSWORD|TOKEN|API_KEY)\s*=\s*['"][^'"\s]{16,}['"]/],
];
const allow = /dev-only|Senha-Seed|Senha-Forte|example|teste|test-webhook|JBSWY3DP/i;
let bad = 0;
for (const f of files) {
  if (/(package-lock\.json|\.png|\.zip)$/.test(f) || !fs.existsSync(f) || fs.statSync(f).size > 1_000_000) continue;
  const txt = fs.readFileSync(f, 'utf8');
  txt.split('\n').forEach((line, i) => {
    for (const [name, re] of patterns) if (re.test(line) && !allow.test(line)) { console.log(`${f}:${i + 1}: possível ${name}`); bad++; }
  });
}
console.log(bad ? `${bad} achado(s)` : 'nenhum segredo encontrado (padrões básicos)');
process.exit(bad ? 1 : 0);
