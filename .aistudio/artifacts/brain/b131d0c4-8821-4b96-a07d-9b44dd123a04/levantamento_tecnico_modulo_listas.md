# Levantamento Técnico e Funcional — Módulo de Listas de Aquisição

**Status do Documento:** Diagnóstico de Engenharia Reversa e Auditoria de Código-Fonte  
**Finalidade:** Recuperar o contexto técnico e funcional para unificação na nova arquitetura (Individual vs. Compartilhada)  
**Autorização de Implementação:** NÃO AUTORIZADA (Documento Estritamente Descritivo e Analítico)  
**Arquivos Inspecionados:**
- `src/types/acquisitions.ts`
- `src/utils/stateMachine.ts`
- `src/services/acquisitionsFirebase.ts`
- `src/components/acquisitions/AcquisitionsModuleView.tsx`
- `src/components/acquisitions/WorkspaceBoardView.tsx`
- `src/components/acquisitions/DashboardOverviewView.tsx`
- `src/components/acquisitions/HubDashboardView.tsx`
- `src/components/acquisitions/TaxonomyManagerView.tsx`
- `src/data/acquisitionsSeedData.ts`
- `src/App.tsx` (linhas 2580–2596)

---

## 1. Resumo Funcional do Módulo Atual

O módulo de aquisições foi construído originalmente como um subsistema especializado de **Gestão do Ciclo de Vida de Compras**, operando sob o conceito de **Workspaces** (Áreas de Trabalho), que contêm **Listas**, e estas contêm **Itens**.

### Principais Pilares do Módulo:
1. **Quadro Kanban de Estados Dinâmicos:** Cada tipo de lista possui uma máquina de estados visual própria, com 3 a 4 colunas verticais que guiam o item desde o planejamento inicial até a compra concluída.
2. **Taxonomia Hierárquica:** Cada item é classificado obrigatoriamente por **Grupo de Taxonomia** (ex: *Supermercado & Despensa*, *Eletrodomésticos & Tecnologia*) e **Categoria** (ex: *Mercearia*, *Linha Branca*).
3. **Histórico de Produtos e Preços:** Para compras recorrentes, o sistema mantém uma subcoleção de histórico (`items/{itemId}/products`), calculando em tempo real: menor preço histórico, preço médio, última marca e última loja.
4. **Módulo Isolado com Ponte Parcial para Finanças:** O módulo possui navegação própria (Dashboard, Hub de Workspaces, Kanban de Itens, Configurações de Taxonomia e Ambiente Admin). Ele se conecta ao módulo de Finanças através de um adaptador em `AcquisitionsModuleView.tsx`, que espelha os Espaços Unificados em Workspaces, e um gatilho de formulário (`onCreateExpenseFromPurchase`).

---

## 2. Relação dos Tipos de Listas Encontrados no Código

O sistema define estritamente três tipos de lista (`ListType = 'recorrente' | 'objetivo' | 'desejo'` em `src/types/acquisitions.ts:44`):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              OS 3 TIPOS DE LISTAS ATUAIS                               │
├─────────────────────┬────────────────────────────────┬─────────────────────────────────┤
│   LISTA RECORRENTE  │       LISTA DE OBJETIVO        │         LISTA DE DESEJO         │
│     ('recorrente')  │          ('objetivo')          │            ('desejo')           │
├─────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ • Foco: Consumo     │ • Foco: Grandes Compras        │ • Foco: Ideias e Inspirações    │
│   doméstico e feira │   planejadas e duráveis        │   sem compromisso de compra     │
│ • Gestão de estoque │ • Cotações e links comparativos│ • Preço estimado e prioridade   │
│ • Carrinho de compra│ • Aportes de poupança (metas)  │ • Prós e contras                │
│ • Histórico de preço│ • Relatório financeiro final   │ • Conversão direta para Objetivo│
└─────────────────────┴────────────────────────────────┴─────────────────────────────────┘
```

---

## 3. Tabela Comparativa de Ações e Comportamentos por Tipo

| Característica / Ação | Lista Recorrente (`recorrente`) | Lista de Objetivo (`objetivo`) | Lista de Desejo (`desejo`) |
| :--- | :--- | :--- | :--- |
| **Objetivo Primário** | Reposição contínua de despensa, higiene, limpeza e suprimentos. | Aquisição de bens de maior valor (móveis, eletros, equipamentos). | Wishlist, curadoria de ideias e avaliação de custo-benefício. |
| **Colunas / Estados do Kanban** | 1. `estoque` (Estoque)<br>2. `comprar` (A Comprar)<br>3. `carrinho` (Carrinho)<br>4. `conferido` (Conferido) | 1. `pesquisa` (Pesquisa / Cotação)<br>2. `poupando` (Poupando)<br>3. `pronto` (Pronto para Executar)<br>4. `adquirido` (Adquirido) | 1. `ideia` (Ideia)<br>2. `avaliando` (Avaliando)<br>3. `arquivado` (Arquivado) |
| **Campos Exclusivos do Item** | `currentStock`, `minStock`, `unit` (`un`, `kg`, `L`, `pct`, `cx`), `cartDraft`, `productsHistory`. | `targetAmount`, `savedAmount`, `finalPaidAmount`, `acquiredStore`, `quotes[]`, `deposits[]`. | `estimatedPrice`, `priority` (`Baixa`, `Média`, `Alta`), `inspirationUrl`, `prosAndCons`, `convertedToGoalItemId`. |
| **Ajuste Rápido de Estoque** | **Sim:** Botões `+` e `-` diretos no card (`adjustItemStock`). | **Não:** Não possui conceito de estoque. | **Não:** Não possui conceito de estoque. |
| **Gatilho de Estoque Crítico** | **Sim:** Se `currentStock <= minStock`, card ganha borda de alerta e pode ir para `comprar`. | **Não.** | **Não.** |
| **Adição de Cotações / Links** | Histórico das compras passadas registra a loja e marca. | **Sim:** Permite cadastrar múltiplos links com loja, URL, preço e notas (`GoalQuote`). | **Parcial:** Possui 1 campo `inspirationUrl`. |
| **Aportes Financeiros / Poupança** | **Não.** | **Sim:** Registro de depósitos (`GoalDeposit`) com cálculo de progresso percentual (0 a 100%). | **Não.** |
| **Avanço Automático de Estado** | Se `currentStock <= minStock` vai para `comprar` (opcional). | Se `savedAmount >= targetAmount`, avança para `pronto`. | **Não.** |
| **Checkout com Criação de Despesa** | **Sim:** Ao confirmar o carrinho, oferece criar despesa via `onCreateExpenseFromPurchase`. | **Sim:** Ao concluir a meta (`adquirido`), oferece criar despesa. | **Não:** Não permite compra direta; deve ser convertido em meta. |
| **Relatório Financeiro de Fechamento** | Estatísticas de preço (menor, médio, último preço e última marca). | Relatório orçamentário (`calculateGoalFinalReport`): compara planejado vs poupado vs pago real (`economia`, `exato`, `acima`). | **Não.** |
| **Ciclo de Reversão / Retorno** | • `revertConfirmedCheckout`: volta para carrinho e desfaz estoque.<br>• `returnConfirmedToStock`: volta para estoque mantendo o histórico. | Não possui retorno automatizado após adquirido (permanece como histórico). | Permite desarquivar ou converter em meta (`convertWishToGoal`). |

---

## 4. Fluxos de Utilização de Cada Tipo de Lista

### 4.1. Fluxo da Lista Recorrente (`recorrente`)
```
[1. Estoque] ───────────────> [2. A Comprar] ─────────────> [3. Carrinho] ─────────────> [4. Conferido]
 (Estoque atual > min)       (Consumo/Estoque crítico)      (No mercado/loja)           (Compra finalizada)
           ▲                                                                                     │
           │                                                                                     │
           └────────────────── (Retornar ao Estoque após conferência) ───────────────────────────┘
```
1. **Cadastro:** O usuário cadastra o item (ex: *"Arroz 5kg"*), definindo estoque atual (ex: 2 un), estoque mínimo (ex: 1 un) e unidade (`pct`).
2. **Consumo diário:** Clica no botão `-` no card de estoque. Quando atinge o mínimo, o sistema sinaliza criticidade e move o item para a coluna **"A Comprar"**.
3. **Ida às compras:** Ao planejar a compra, o usuário move o item para a coluna **"Carrinho"**.
4. **Checkout no Carrinho:** Clica em "Comprar". Abre modal solicitando: Marca, Preço Unitário, Quantidade comprada, Nome da Loja e foto do recibo/comprovante.
5. **Efeito do Checkout:** O item passa para **"Conferido"**, o estoque é incrementado automaticamente (`currentStock + quantidade`) e grava-se um novo registro em `productsHistory`. Se o checkbox de criar despesa estiver marcado, dispara o formulário financeiro.
6. **Fechamento do Ciclo:** O usuário clica em "Retornar ao Estoque". O item volta para a coluna 1 (**"Estoque"**) com o novo saldo abastecido e com o histórico de compras e estatísticas de preço preservados.

### 4.2. Fluxo da Lista de Objetivo (`objetivo`)
```
[1. Pesquisa] ──────────────> [2. Poupando] ──────────────> [3. Pronto] ───────────────> [4. Adquirido]
 (Cotações e links)         (Aportes e meta %)            (100% poupado)              (Compra efetuada)
```
1. **Cadastro:** Cadastra o objetivo (ex: *"Geladeira Frost Free"*), grupo, categoria e o valor alvo (`targetAmount: R$ 3.500,00`).
2. **Pesquisa de Mercado:** Na coluna 1, cadastra cotações encontradas em diferentes lojas (Magazine Luiza R$ 3.600, Amazon R$ 3.450, etc.).
3. **Poupança / Aportes:** Move para "Poupando". Usuários registram aportes periódicos (`GoalDeposit`). Uma barra de progresso exibe a porcentagem acumulada.
4. **Meta Batida:** Ao atingir 100% do valor, o sistema avança o item para **"Pronto para Executar"**.
5. **Aquisição:** Ao comprar, o usuário clica em "Concluir Aquisição", informando o valor final pago, loja e marca. O sistema gera o relatório financeiro final (apontando se houve economia ou sobrepreço) e pode enviar o valor para o financeiro.

### 4.3. Fluxo da Lista de Desejo (`desejo`)
```
[1. Ideia] ─────────────────> [2. Avaliando] ─────────────> [3. Arquivado / Convertido]
 (Inspiração inicial)         (Prós, contras e viabilidade)    (Descartado OU vira Objetivo)
```
1. **Cadastro:** Cadastra um desejo (ex: *"Cadeira Ergonômica Mesh"*), prioridade (`Alta`), preço estimado (`R$ 1.800,00`) e URL de inspiração.
2. **Avaliação:** Move para "Avaliando" e preenche prós, contras e notas de necessidade.
3. **Decisão:**
   - **Descarte:** Move para "Arquivado".
   - **Aprovação:** Clica em **"Converter em Meta"**. O sistema executa `convertWishToGoal()`: cria automaticamente um novo item na Lista de Objetivos (no estágio *Pesquisa*, herdando o preço e link) e arquiva o desejo original com a referência `convertedToGoalItemId`.

---

## 5. Estrutura Técnica e Arquivos Envolvidos

### Mapeamento de Arquivos no Projeto:

| Arquivo | Função Técnica e Responsabilidade |
| :--- | :--- |
| `src/types/acquisitions.ts` | Contrato de dados: `Workspace`, `AcquisitionList`, `AcquisitionItem`, `ProductPurchase`, `GoalQuote`, `GoalDeposit`, `TaxonomyGroup`. |
| `src/utils/stateMachine.ts` | Lógica pura: transições de estágio (`getNextStage`, `getPreviousStage`), checkout de carrinho (`confirmCartCheckout`), reversão (`revertConfirmedCheckout`), ajuste de estoque (`adjustItemStock`), cálculo de metas (`calculateGoalProgress`, `calculateGoalFinalReport`), estatísticas de preço (`calculatePriceStats`), conversão de desejo em meta (`convertWishToGoal`). |
| `src/services/acquisitionsFirebase.ts` | Acesso ao Firestore: coleções `workspaces`, `lists`, `items`, `items/{itemId}/products`, `taxonomy`, `users`. Upload de recibos para o Firebase Storage (`receipts/`). |
| `src/components/acquisitions/AcquisitionsModuleView.tsx` | Componente contêiner: orquestra a navegação interna (Hub, Detalhe do Workspace, Configurações, Admin), sincroniza com `localStorage` e conecta com os `unifiedSpaces` vindos de Finanças. |
| `src/components/acquisitions/WorkspaceBoardView.tsx` | Componente central do Kanban: renderiza colunas, cards, modais de item, carrinho, cotações, depósitos e filtros por categoria. Possui 2.679 linhas de código. |
| `src/components/acquisitions/HubDashboardView.tsx` | Painel de visualização de todos os workspaces disponíveis, status de convites e resumo de itens críticos. |
| `src/components/acquisitions/DashboardOverviewView.tsx` | Dashboard analítico com métricas consolidadas de compras, orçamentos e itens em andamento. |
| `src/components/acquisitions/TaxonomyManagerView.tsx` | Interface administrativa para gerenciar grupos e categorias de compras (`TaxonomyGroup`). |
| `src/components/acquisitions/AdminEnvironmentView.tsx` | Painel do Master Admin para gerenciar usuários, inspecionar banco e disparar sincronização. |
| `src/data/acquisitionsSeedData.ts` | Carga inicial de dados mock para modo demonstração ou bootstrap do banco. |
| `src/App.tsx:2584-2596` | Ponte no aplicativo raiz: recebe o evento `onCreateExpenseFromPurchase` e abre o modal de lançamento financeiro preenchendo descrição e valor. |

---

## 6. Modelo de Dados Atual: Entidades, Campos e Cardinalidades

```
┌─────────────────────────────────┐
│            Workspace            │
│  (id, name, type, ownerUid,     │
│   acceptedMemberEmails, members)│
└────────────────┬────────────────┘
                 │ 1:N
                 ▼
┌─────────────────────────────────┐
│         AcquisitionList         │
│  (id, workspaceId, name, type,  │
│   acceptedMemberEmails)         │
└────────────────┬────────────────┘
                 │ 1:N
                 ▼
┌─────────────────────────────────┐
│         AcquisitionItem         │
│  (id, listId, workspaceId, name,│
│   groupId, categoryId, stage)   │
└────────────────┬────────────────┘
                 │ 1:N (subcoleção)
                 ▼
┌─────────────────────────────────┐
│         ProductPurchase         │
│  (id, itemId, brand, unitPrice, │
│   quantity, totalPrice, store)  │
└─────────────────────────────────┘
```

### Detalhamento dos Campos:

#### 1. `Workspace` (`workspaces/{workspaceId}`)
- `id`: string (chave primária)
- `name`: string (nome do espaço)
- `description`: string
- `type`: `'Individual' | 'Compartilhado'`
- `ownerUid`: string (UID do criador)
- `ownerEmail`: string
- `acceptedMemberEmails`: string[] (usado para filtro `array-contains` no Firestore)
- `acceptedMemberUids`: string[]
- `members`: `WorkspaceMember[]` (lista com `email`, `role: 'Admin' | 'Membro'`, `status: 'Pendente' | 'Aceito' | 'Recusado'`)
- `monthlyBudget`?: number (teto orçamentário mensal)
- `createdAt`: string (ISO)

#### 2. `AcquisitionList` (`lists/{listId}`)
- `id`: string
- `workspaceId`: string (referência ao Workspace pai)
- `name`: string
- `type`: `'recorrente' | 'objetivo' | 'desejo'`
- `description`: string
- `acceptedMemberEmails`: string[]
- `createdAt`: string

#### 3. `AcquisitionItem` (`items/{itemId}`)
- `id`: string
- `listId`: string (referência à lista)
- `workspaceId`: string (referência ao workspace)
- `name`: string (nome do produto/item)
- `groupId`: string (taxonomia de grupo)
- `categoryId`: string (taxonomia de categoria)
- `listType`: `'recorrente' | 'objetivo' | 'desejo'`
- `stage`: string (estágio kanban atual do item)
- `acceptedMemberEmails`: string[]
- `notes`?: string
- **Campos Recorrente:** `currentStock` (número), `minStock` (número), `unit` (string), `cartDraft` (objeto rascunho de compra)
- **Campos Objetivo:** `targetAmount` (número), `savedAmount` (número), `finalPaidAmount` (número), `acquiredStore` (string), `quotes` (`GoalQuote[]`), `deposits` (`GoalDeposit[]`)
- **Campos Desejo:** `estimatedPrice` (número), `priority` (`Baixa | Média | Alta`), `inspirationUrl` (string), `prosAndCons` (string), `convertedToGoalItemId` (string)
- `productsHistory`: `ProductPurchase[]` (histórico em cache no próprio documento)
- `updatedAt`: string

#### 4. `ProductPurchase` (`items/{itemId}/products/{productId}`)
- `id`: string
- `itemId`: string
- `brand`: string (marca comprada)
- `unitPrice`: number (preço unitário em R$)
- `quantity`: number (quantidade)
- `totalPrice`: number (`unitPrice * quantity`)
- `storeName`: string (loja/estabelecimento)
- `purchaseDate`: string (ISO)
- `receiptUrl`?: string (foto/recibo no Storage)
- `productPhotoUrl`?: string

---

## 7. Análise de Permissões, Autoria e Governança

A auditoria aprofundada de código revelou fatos cruciais sobre a segurança e governança atuais:

1. **Inexistência de Autoria no Nível de Item e Lista:**
   - O documento `AcquisitionList` **não possui** campo `createdByUid` ou `authorEmail`.
   - O documento `AcquisitionItem` **não possui** campo `createdByUid` ou `authorEmail`.
   - O documento `ProductPurchase` **não possui** campo de quem executou a compra.
   - Apenas `GoalDeposit` possui o campo `authorEmail: string`.
2. **Inexistência de Regras de Autorização por Papel (`role`):**
   - Na interface (`WorkspaceBoardView.tsx`), os papéis `'Admin'` e `'Membro'` definidos em `WorkspaceMember` **não são checados** para nenhuma operação de edição. Qualquer participante aceito pode:
     - Editar ou excluir qualquer lista;
     - Criar, editar ou excluir qualquer item;
     - Mudar estágios de qualquer item;
     - Fazer checkout ou reverter checkouts;
     - Editar configurações do workspace e até mesmo abrir o modal de exclusão do workspace.
3. **Controle de Acesso Exclusivamente por E-mail (ACL Array-Contains):**
   - O único controle de segurança atual consiste na presença do e-mail do usuário no array `acceptedMemberEmails`.
   - Se o e-mail estiver no array, o Firestore retorna o documento. Se for removido do array, o usuário perde acesso de leitura.
4. **Riscos de Exclusão e Mutações Concorrentes:**
   - Como não há vínculo de propriedade de item por membro, um participante pode alterar o preço, mudar o estágio ou apagar permanentemente um item criado por outro participante sem deixar nenhum rastro de auditoria.

---

## 8. Integrações Existentes: O Que é Comprovado vs. Parcial vs. Inexistente

| Integração | Status Real no Código | Evidência Técnica | Como Funciona Hoje |
| :--- | :--- | :--- | :--- |
| **Listas $\rightarrow$ Despesas Financeiras** | **PARCIALMENTE IMPLEMENTADA** | `src/App.tsx:2584-2596` e `WorkspaceBoardView.tsx:532` | Ao concluir compra no carrinho (ou meta), o sistema abre o modal financeiro comum pré-preenchendo descrição e valor. **Porém não salva vínculo bidirecional**: não registra `itemId` na despesa nem `transactionId` no item. Se a despesa for cancelada ou editada no financeiro, o item não é notificado. |
| **Listas $\rightarrow$ Estoque / Quantidade** | **COMPROVADAMENTE EXISTENTE** | `src/utils/stateMachine.ts:104-191` | O checkout do carrinho soma a quantidade comprada ao `currentStock`. O decremento via `-` atualiza o estoque. O alerta de estoque crítico funciona. Porém, o estoque existe apenas dentro do módulo de aquisições (não existe controle patrimonial no financeiro). |
| **Listas $\rightarrow$ Orçamento Mensal** | **APENAS VISUAL (NÃO INTEGRADA)** | `WorkspaceBoardView.tsx:1133` | O campo `monthlyBudget` é exibido apenas como texto/badge de teto orçamentário. Não há cálculo comparando a soma dos itens comprados no mês com esse teto, nem bloqueio ou alerta de estouro de orçamento. |
| **Listas $\rightarrow$ Receitas Financeiras** | **INEXISTENTE** | Nenhuma referência no código | Os depósitos de metas (`GoalDeposit`) são anotações isoladas dentro do item. Não debitam contas bancárias nem se relacionam com as receitas ou caixas de Finanças. |
| **Listas $\rightarrow$ Espaços Compartilhados** | **PARCIALMENTE IMPLEMENTADA** | `AcquisitionsModuleView.tsx:138-203` | Existe um espelhamento em memória: se `unifiedSpaces` for fornecido por Finanças, ele gera `effectiveWorkspaces`. Contudo, os dados persistidos continuam na coleção `workspaces` e `lists`, duplicando entidades conceituais. |
| **Histórico de Auditoria de Ações** | **INEXISTENTE** | Nenhuma tabela de log | Mutações de itens, alterações de estoque e exclusões de listas não gravam entradas em log de auditoria. |

---

## 9. Problemas e Limitações Identificados no Módulo Atual

1. **Duplicação Conceitual entre `Workspace` e `Space`:**
   - O sistema possui duas entidades com a mesma finalidade: o `Space` (do módulo financeiro) e o `Workspace` (do módulo de aquisições). O código atual tenta resolver isso mapeando em tempo de execução via `useMemo` em `AcquisitionsModuleView.tsx`, o que gera fragilidade na sincronização de dados.
2. **Acoplamento a E-mail em vez de `uid`:**
   - As listas e itens dependem fortemente de `acceptedMemberEmails: string[]` para queries no Firestore. Se um participante alterar seu e-mail, os itens e listas ficam órfãos para esse usuário.
3. **Falta de Rastreabilidade Transacional com Finanças:**
   - Ao gerar uma despesa a partir de uma compra, o sistema chama `onCreateExpenseFromPurchase` sem passar o `spaceId`, sem conta bancária associada e sem armazenar o `itemId`. Não há como saber qual despesa quitou qual compra de lista.
4. **Ausência de Autoria e Responsabilidade em Compras Coletivas:**
   - Em um espaço compartilhado, quando um membro realiza a compra do carrinho, o sistema não registra quem realizou o desembolso financeiro, nem como o rateio daquela compra deve ser distribuído entre os moradores/participantes.
5. **Componente Monolítico de Visualização:**
   - O arquivo `WorkspaceBoardView.tsx` possui 2.679 linhas, concentrando renderização de kanban, 8 modais diferentes, lógica de formulários e uploads de imagem em um único arquivo, dificultando manutenção e testes.
6. **Ausência de Testes Automatizados:**
   - Não há nenhum arquivo `.test.ts` para testar os fluxos de listas, carrinho, checkout ou transições de estado (o único teste existente é `financeEngine.test.ts`).

---

## 10. O Que Pode Ser Reaproveitado vs. O Que Precisa Ser Adaptado

### 10.1. O Que Deve Ser 100% Reaproveitado:
- **As 3 Máquinas de Estado (`src/utils/stateMachine.ts`):** A lógica kanban dos 3 tipos (Recorrente com 4 estágios, Objetivo com 4 estágios, Desejo com 3 estágios) está perfeitamente madura, matematicamente testada e possui excelente UX.
- **Funções Puras de Negócio:**
  - `confirmCartCheckout`: lógica de cálculo de preço total e inserção de produto.
  - `calculateGoalFinalReport`: apuração de economia/sobrepreço da meta.
  - `calculatePriceStats`: cálculo de menor preço, preço médio e última loja.
  - `convertWishToGoal`: herança de dados ao transformar desejo em objetivo.
- **Taxonomia Global (`TaxonomyGroup` e `TaxonomyCategory`):** Categorização completa já populada com seed data sólido de mercado, tecnologia, conforto e lazer.
- **Componentes Visuais de Card e Kanban:** Layouts responsivos já adaptados para desktop e mobile sheet.

### 10.2. O Que Precisa Ser Adaptado para a Nova Hierarquia (Individual vs. Compartilhada):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        NOVA HIERARQUIA ARQUITETURAL PROPOSTA                           │
├───────────────────────────────────────────┬────────────────────────────────────────────┤
│             LISTA INDIVIDUAL              │             LISTA COMPARTILHADA            │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ • Pertence ao Usuário (`ownerUid`)        │ • Pertence ao Espaço (`spaceId`)           │
│ • Sem dependência de Workspace avulso     │ • Herda os membros ativos do Espaço        │
│ • Gestão 100% pessoal de itens e estoque  │ • Governança, autoria e aprovação do Espaço│
│ • Checkout gera Despesa Pessoal           │ • Checkout gera Despesa Compartilhada com  │
│   vinculada à conta do próprio usuário    │   pagador, rateio e aprovação de membros   │
└───────────────────────────────────────────┴────────────────────────────────────────────┘
```

#### Adaptações Específicas a Serem Projetadas:
1. **Extinção da Entidade `Workspace` Avulsa:**
   - Eliminar a duplicidade: toda lista pertencerá ou diretamente ao usuário (`userId`) ou a um `Space` existente (`spaceId`).
2. **Inclusão de Autoria Obrigatória nos Itens e Listas:**
   - Adicionar `createdByUid: string` em `AcquisitionList`, `AcquisitionItem` e `ProductPurchase`.
3. **Ponte Transacional Bidirecional com Finanças:**
   - Quando o checkout do carrinho for confirmado:
     - Em **Lista Individual:** Gera automaticamente uma transação pessoal com `originType: 'shopping_list'` e `originRefId: itemId`.
     - Em **Lista Compartilhada:** Abre o formulário da despesa compartilhada já preenchido com `spaceId`, itens comprados, solicitando o pagador real e a regra de rateio entre os participantes. O item grava o `expenseId` correspondente.
4. **Governança de Exclusão:**
   - Somente o autor do item ou o dono do espaço pode excluir ou arquivar um item de compra compartilhado.
5. **Permissões Baseadas em `uid`:**
   - Substituir a dependência de `acceptedMemberEmails: string[]` por `memberUids: string[]`, alinhando-se com as regras de segurança e autenticação estáveis do sistema.

---

## 11. Conclusão e Dúvidas para Validação pelo Usuário

O módulo atual possui uma riqueza funcional excepcional no que diz respeito ao controle de estoque, cotações de metas e wishlists, mas operava como uma "ilha funcional" separada das finanças reais. 

A unificação proposta trará total coerência ao sistema, garantindo que compras concluídas alimentem o financeiro com precisão contábil e auditoria.

### Dúvidas Técnicas Registradas para Sua Avaliação:
1. **Listas Padrão ao Criar um Espaço:** Quando um novo Espaço Compartilhado for criado com o módulo de aquisições ativo, o sistema deve criar automaticamente as 3 listas padrão (1 Recorrente de Abastecimento, 1 Objetivo e 1 Desejo) ou o espaço deve iniciar vazio para os membros criarem as listas sob demanda?
2. **Estoque em Lista Compartilhada:** Em um Espaço Compartilhado (ex: casa com Keniel e Mariana), a baixa de estoque com o botão `-` deve ser livre para qualquer morador registrar o consumo diário, ou exige algum tipo de confirmação?
3. **Checkout sem Despesa:** Deve continuar existindo a opção de finalizar a compra no carrinho apenas atualizando o estoque, sem gerar despesa financeira (ex: quando o item foi doado ou pago com recursos externos que não devem entrar nas contas)?

*Este documento encerra o levantamento técnico e funcional do módulo de listas. Nenhuma implementação foi realizada, aguardando suas diretrizes para incorporação na nova arquitetura.*
