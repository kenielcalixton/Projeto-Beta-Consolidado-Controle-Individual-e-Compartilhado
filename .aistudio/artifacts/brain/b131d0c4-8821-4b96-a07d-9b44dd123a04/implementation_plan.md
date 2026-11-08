# Consolidação: Meu Painel Financeiro + Módulo de Listas & Aquisições

Unificação do **Meu Painel Financeiro** (mantendo 100% da sua estrutura, regras de negócio, faturas, recorrências e Livro-Razão intactos) com o **Módulo de Listas & Aquisições** (quadros Kanban de estoque recorrente, objetivos/metas e desejos), conectados sob o mesmo login e projeto Firebase (`teste-beta-fin-e-list`), permitindo também lançar compras concluídas como despesas no controle financeiro.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> Confirme se concorda com as diretrizes abaixo (baseadas nas suas respostas e nos arquivos do seu repositório `Projeto-consolida-fin-e-list`) antes de executarmos a consolidação no código.

- **Preservação Integral do Módulo de Finanças**: Todos os componentes, cálculos (`financeEngine.ts`), modais (`UniversalTransactionModal`, `ConfirmSettlementModal`, `TransactionDetailModal`), abas (`Painel`, `Contas & Cartões`, `Extrato`, `Espaços`, `Inbox`, `Admin`) e regras do projeto `Estrutura fin` serão mantidos exatamente como funcionam hoje.
- **Incorporação Isolada das Listas & Aquisições**: O projeto `Estrurura list` será acoplado como uma nova seção principal na barra de navegação (**Aquisições / Listas**), mantendo seus próprios Espaços de Aquisição (`workspaces`), Listas (`lists`), Itens (`items`) e Categorias/Subcategorias (`taxonomy`) separados dos Espaços e Categorias de Finanças neste momento.
- **Ponte Pronta entre Aquisições e Despesas ("Aceitando as Pontas")**:
  - Quando você concluir uma compra no carrinho (Lista Recorrente ➔ `conferido`) ou finalizar a aquisição de uma meta (Lista de Objetivo ➔ `adquirido`), haverá a ação rápida **"Lançar como Despesa no Financeiro"** (ou opção direta no checkout), que abre o `UniversalTransactionModal` do Financeiro já preenchido com a descrição do item/marca, o valor total pago e a data da compra para você escolher a conta/cartão ou espaço financeiro.
- **Firebase Unificado & Master Admin**:
  - Configuração apontando para o projeto Firebase unificado `teste-beta-fin-e-list` (`apiKey: AIzaSyCtekht1J4c3...`).
  - Reconhecimento automático do UID Master `GOgPDiSr6UP3VGR0zRcdFlgDseY2` (além dos UIDs admin anteriores `cFlLuuez1TMfNhsNFKGpjQ8qYSG3` e `wAUPqTjSmOMV3S8XlaLlv46QK463`) com acesso total ao painel Admin tanto de Finanças quanto de Aquisições.

---

## 1. Overview & Core Concept

- **O que o Sistema Faz**: Funciona como uma central única para gestão financeira pessoal/compartilhada e gestão do ciclo de compras domésticas, metas de aquisição e desejos.
- **Fluxo de Trabalho para Desenvolvimento Local (GitHub + VS Code + Firebase Hosting)**:
  - Toda a estrutura de pastas continuará limpa dentro de `src/` com tipagens TypeScript estritas e scripts prontos no `package.json` (`npm run dev`, `npm run build`), facilitando o `git pull`/`git push` no seu VS Code local e o `firebase deploy` para o Firebase Hosting.

---

## 2. User Experience & Visual Design

- **Navegação Principal Unificada**:
  - O cabeçalho superior (Desktop) e a barra fixa inferior (Mobile) do **Meu Painel Financeiro** ganham o item **Aquisições** (`ph-shopping-cart` / `ShoppingCart`), ao lado de `Painel`, `Contas & Cartões`, `Extrato`, `Espaços` e `Inbox` (mais `Admin` para contas administradoras).
  - Dentro da aba **Aquisições**, uma sub-barra de navegação rápida permite alternar entre as visões originais do módulo de listas sem sair do contexto:
    1. **Visão Geral de Aquisições** (`DashboardOverviewView`: KPIs de Estoque Mínimo, Total no Carrinho, Total Guardado em Objetivos e Convites de Listas).
    2. **Espaços & Quadros Kanban** (`HubDashboardView` e `WorkspaceBoardView`: Listas Recorrentes, Objetivos com Cotações/Depósitos e Lista de Desejos).
    3. **Categorias de Produtos** (`TaxonomyManagerView` / `SettingsView`: Gestão de Categorias Principais e Subcategorias de itens).
    4. **Sincronização & Admin de Listas** (visível para o Admin Master).
- **Identidade Visual & Tema**:
  - Mantém o padrão visual escuro (`slate-900` / `slate-800` com acentos em `indigo-600`, `emerald-500`, `amber-500` e `rose-500`) e suporte ao `@custom-variant dark` do Tailwind CSS v4, garantindo que tanto as telas de Finanças quanto os quadros Kanban de Aquisições tenham contraste e legibilidade perfeitos.
  - Tipografia unificada com `Plus Jakarta Sans` para interface/títulos e `JetBrains Mono` (`tabular-nums`) para valores em R$, saldos, estoques e faturas.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisão 1: Preservar Coleções Independentes no Firestore (`teste-beta-fin-e-list`)**
  - *Abordagem Escolhida*:
    - **Finanças** continua usando: `users`, `accounts`, `categories`, `spaces`, `transactions`.
    - **Aquisições** continua usando: `workspaces`, `lists`, `items` (com subcoleção `products`) e `taxonomy` (além do cache rápido em `localStorage` para resposta instantânea no Kanban).
  - *Por quê*: Garante zero colisão entre os Espaços/Categorias de Finanças e os Espaços/Categorias de Aquisições, exatamente como você solicitou, permitindo evoluir a fusão de espaços no futuro sem quebrar dados existentes.
- **Decisão 2: Autenticação Única Compartilhada**
  - *Abordagem Escolhida*: Quando o usuário entra pela tela de Login (Firebase Auth ou Perfil Demonstrativo), a mesma sessão (`uid`, `email`, `name`) alimenta simultaneamente o estado do Financeiro e o estado de Aquisições.
- **Decisão 3: Conversão de Compra / Aquisição em Despesa Financeira**
  - *Abordagem Escolhida*: Ao confirmar um item no carrinho (`confirmCartCheckout`) ou concluir um objetivo (`adquirido`), o usuário pode clicar em **"Gerar Despesa no Financeiro"** (ou marcar um checkbox rápido no modal de checkout do carrinho/objetivo). Isso abre ou pré-preenche o modal universal de lançamentos do Financeiro com o valor real pago, loja/marca na descrição e data, permitindo escolher em qual Conta ou Cartão de Crédito (à vista ou parcelado) a compra foi feita.

---

## 4. Technical Architecture & Data Strategy

### Arquitetura de Componentes & Fluxo de Dados

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   Firebase (teste-beta-fin-e-list)                         │
│  Auth Unificado  │  Firestore Finanças          │  Firestore Aquisições    │
│  (UID Master:    │  • accounts   • categories   │  • workspaces • lists    │
│   GOgPDiSr6U...) │  • spaces     • transactions │  • items      • taxonomy │
└────────┬─────────┴──────────────┬───────────────┴─────────────┬────────────┘
         │                        │                             │
         ▼                        ▼                             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        App.tsx (Shell Unificado)                           │
│  • Header Global (Seletor YYYY-MM + Nav Desktop + Botão + Novo Lançamento) │
│  • Sessão Compartilhada (currentUser sincronizado entre os 2 módulos)      │
├──────────────────────────────────────┬─────────────────────────────────────┤
│      MÓDULO DE FINANÇAS (Intacto)    │     MÓDULO DE AQUISIÇÕES (Integrado)│
│  • DashboardView (KPIs + Rosca)      │  • AcquisitionsModuleContainer      │
│  • AccountsCardsView (Contas/Faturas)│    ├─ DashboardOverviewView         │
│  • TransactionsView (Extrato Mensal) │    ├─ HubDashboardView (Espaços)    │
│  • SpacesLedgerView (Livro-Razão)    │    ├─ WorkspaceBoardView (Kanban)   │
│  • PendingDisputesView (Inbox)       │    ├─ TaxonomyManagerView           │
│  • AdminDashboardView                │    └─ AdminEnvironmentView          │
└──────────────────┬───────────────────┴──────────────────┬──────────────────┘
                   │                                      │
                   ▼                                      │
┌──────────────────────────────────────┐                  │
│   UniversalTransactionModal.tsx      │◄─────────────────┘
│   (Recebe pré-preenchimento direto   │  "Lançar como Despesa" ao concluir
│    de compras do Carrinho / Metas)   │  item no Carrinho ou Objetivo
└──────────────────────────────────────┘
```

### Mapeamento Interativo entre os Módulos
1. **Login Único (`AuthScreen.tsx`)**: Autentica no projeto `teste-beta-fin-e-list` e propaga `{ uid, name, email }` para os listeners em tempo real do Financeiro (`onSnapshot`) e para o gerenciador de estados do módulo de Aquisições.
2. **Ponte de Conversão (`onCreateExpenseFromAcquisition`)**:
   - Na etapa `carrinho` ➔ `conferido` ou `conferido` (Lista Recorrente) e na etapa `pronto` ➔ `adquirido` ou `adquirido` (Lista de Objetivo), um botão **"Lançar no Financeiro"** dispara um callback para o `App.tsx`.
   - O `App.tsx` abre o `UniversalTransactionModal` no modo `expense` com a descrição formatada (`"[Compra] Nome do Item - Marca (Loja)"`) e o valor total pago (`totalPrice` ou `finalPaidAmount`), permitindo registrar no cartão de crédito (inclusive parcelado) ou conta corrente e vinculá-lo a um espaço financeiro se desejar.
