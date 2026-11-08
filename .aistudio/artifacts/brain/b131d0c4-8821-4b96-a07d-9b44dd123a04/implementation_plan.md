# Menu Flutuante no Rodapé & Inicialização Limpa de Usuários ("Carteira")

Reestruturar a navegação global do sistema para um **dock flutuante centralizado no rodapé** (alinhado horizontalmente na mesma linha do botão de ação rápida `+`), além de tornar o onboarding de novos usuários minimalista: criando exclusivamente a conta **"Carteira"** (com saldo zerado e editável/apagável pelo usuário) e **nenhum espaço ou transação fictícia pré-criada**.

---

### Decisões do Usuário & Alinhamentos Críticos

> [!IMPORTANT]
> **Decisão Confirmada na Fase 1**:
> - **Alinhamento do Menu e Botão (+)**: Menu de navegação centralizado horizontalmente na tela flutuando no rodapé, enquanto o botão de ação rápida (`+`) permanece fixo no canto inferior direito, ambos na mesma linha/altura da viewport (`bottom-6`).
> - **Inicialização de Novos Usuários**: Apenas a conta **"Carteira"** (tipo corrente, saldo 0.00) deve ser pré-criada. Nenhum espaço deve ser criado previamente. Categorias essenciais de receitas e despesas são mantidas para permitir lançamentos imediatos sem erros.

---

## 1. Visão Geral & Conceito Central

- **O que faz**:
  1. **Dock Flutuante Inferior Unificado (Desktop & Mobile)**:
     - Remove o menu estático do cabeçalho superior e a barra colada no rodapé mobile, substituindo-os por um **dock flutuante translúcido** (`backdrop-blur-md`, bordas finas `border-slate-700/80`, sombra elegante `shadow-2xl`), centralizado horizontalmente no rodapé (`bottom-6`).
     - O botão de ação rápida `+` (FAB) fica alinhado no canto direito na mesma altura `bottom-6`, criando uma barra de controle ergonômica e moderna semelhante a sistemas desktop modernos e interfaces mobile touch.
     - O cabeçalho superior fica limpo e focado na identidade (Logo como Início), no alternador de mês/ano e no menu de Perfil/Configurações do usuário.
  2. **Inicialização Limpa de Novos Usuários (Zero Clutter)**:
     - Novos usuários (autenticados ou em sessão inicial) passam a receber única e exclusivamente a conta **"Carteira"** (com saldo zerado), sem dívidas, faturas ou movimentações fictícias.
     - Nenhum espaço compartilhado é criado automaticamente (`spaces = []`). A tela de Espaços passa a exibir um estado inicial acolhedor convidando à criação do primeiro espaço apenas quando o usuário desejar.
     - Transações começam zeradas (`transactions = []`).

---

## 2. Experiência do Usuário & Design Visual

```
┌────────────────────────────────────────────────────────────────────────┐
│ [Logo Finanças]  [< Nov 2026 >]                     [Admin] [Keniel ▼] │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│                      CONTEÚDO PRINCIPAL (DASHBOARD)                    │
│                  - Indicadores Financeiros & Balanço                   │
│                  - Aquisições & Listas Integradas                      │
│                  - Gráfico de Despesas & Ranking                       │
│                                                                        │
│                                                                        │
│                                                                        │
│               ┌──────────────────────────────────────┐     ┌─────┐     │
│               │ Contas │ Extrato │ Espaços │ Listas  │     │  +  │     │  bottom-6
│               └──────────────────────────────────────┘     └─────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

- **Aparência do Dock Flutuante**:
  - `fixed bottom-6 inset-x-0 z-30 pointer-events-none flex justify-center`
  - Container interno com `pointer-events-auto bg-slate-900/95 border border-slate-700/80 backdrop-blur-md px-3 py-2 rounded-2xl shadow-2xl flex items-center gap-1.5`.
  - Estados ativos com iluminação sutil índigo (`bg-indigo-600 text-white shadow-md shadow-indigo-600/25`), mantendo os rótulos legíveis e ícones nítidos em qualquer resolução.
  - No mobile, mantém o dock flutuante compacto com ícones e rótulos concisos; no desktop, adiciona rótulos completos e micro-interações de hover.
- **Espaçamento e Visibilidade**:
  - A área do `<main>` terá `pb-28 sm:pb-32` para garantir rolagem livre sem que o dock ou o botão `+` cubram botões, tabelas ou formulários.

---

## 3. Decisões do Produto & Arquitetura de Dados

### Decisão 1: Unificação da Experiência Desktop e Mobile no Rodapé
- **Abordagem**: Unificar a navegação em um único componente dock flutuante responsivo no rodapé, eliminando a discrepância entre cabeçalho superior no desktop e rodapé no mobile.
- **Por que**: Traz uma interface contemporânea, fluida e consistente, com alcance imediato do polegar e do mouse, liberando 100% da largura superior para a identidade e contexto temporal.

### Decisão 2: Política de Onboarding "Carteira Única"
- **Abordagem**:
  - Em `src/utils/seedData.ts` e nas rotinas de sincronização inicial do Firestore em `src/App.tsx`:
    - `accounts`: `[{ id: 'acc_carteira', name: 'Carteira', type: 'checking', balance: 0.0, limit: 0, closingDay: 1, dueDay: 1, color: 'emerald', icon: 'ph-wallet' }]`.
    - `spaces`: `[]` (vazio).
    - `transactions`: `[]` (vazio).
  - O dataset completo de demonstração administrativa continua disponível exclusivamente quando ativado via `autostart=admin` para testes de painel do administrador.

---

## 4. Plano de Execução & Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                           App.tsx                           │
├──────────────────────────────┬──────────────────────────────┤
│       Cabeçalho Limpo        │   Dock Flutuante Inferior    │
│  - Logo (Link Dashboard)     │  - Contas & Cartões          │
│  - Alternador Mês/Ano        │  - Extrato                   │
│  - Perfil & Configurações    │  - Espaços                   │
│  - Botão Admin (se admin)    │  - Listas                    │
│                              │  - Inbox                     │
├──────────────────────────────┴──────────────────────────────┤
│               Botão de Ação Rápida Flutuante (+)            │
│  - Alinhado na mesma linha (bottom-6 right-5 sm:right-8)   │
├─────────────────────────────────────────────────────────────┤
│                 Onboarding Limpo (seedData.ts)              │
│  - Única conta: "Carteira" (balance: 0)                     │
│  - Zero espaços pré-criados                                 │
│  - Zero transações pré-criadas                              │
└─────────────────────────────────────────────────────────────┘
```

1. **Ajustar Dados Iniciais (`src/utils/seedData.ts`)**:
   - Atualizar `getInitialDemoData` para retornar apenas a conta "Carteira" (`balance: 0`, `color: 'emerald'`, `icon: 'ph-wallet'`), `spaces: []` e `transactions: []`.
2. **Atualizar Inicialização no Firestore (`src/App.tsx`)**:
   - Ajustar as rotinas de seed de primeira execução para persistir apenas a conta "Carteira" e nenhum espaço ou transação fictícia.
3. **Construir o Dock Flutuante Inferior (`src/App.tsx`)**:
   - Remover o `<nav>` centralizado do cabeçalho superior.
   - Substituir a barra mobile inferior fixa e o menu desktop por um único dock flutuante centralizado:
     `fixed bottom-6 inset-x-0 z-30 flex justify-center pointer-events-none` com interior `pointer-events-auto bg-slate-900/95 border border-slate-700/80 backdrop-blur-md px-3 py-2 rounded-2xl shadow-2xl`.
4. **Alinhar o Botão FAB (`src/components/QuickActionFAB.tsx`)**:
   - Ajustar o posicionamento do botão FAB para `fixed bottom-6 right-5 sm:right-8 z-40`, garantindo alinhamento perfeito de linha com o dock central.
5. **Verificação & Testes**:
   - Co-executar `compile_applet` e `lint_applet`.
   - Reiniciar o servidor de desenvolvimento e validar responsividade e persistência.
