export const metadata = { title: 'Acessibilidade' };
export default function Acess() {
  return (<><h1>Acessibilidade</h1>
    <p>Nossa meta técnica é a WCAG 2.2 nível AA. Navegação por teclado, foco visível, rótulos e mensagens de erro associadas aos campos, contraste adequado e uso com leitores de tela fazem parte do produto.</p>
    <p><strong>Situação:</strong> verificações automatizadas (axe) e de teclado foram executadas nas telas principais; <strong>não houve auditoria manual com leitores de tela nem avaliação por especialista</strong>. Não declaramos conformidade completa.</p>
    <p>Encontrou uma barreira? Fale conosco em <a href="/contato">Contato</a>.</p></>);
}
