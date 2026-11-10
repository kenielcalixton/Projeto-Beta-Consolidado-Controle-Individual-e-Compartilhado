# Relatório de Auditoria Técnica Cruzada — Arquitetura Financeira e Operacional

**Status:** Auditoria Técnica e Funcional Baseada em Evidências de Código-Fonte  
**Autorização de Implementação:** NÃO AUTORIZADA (Documento Estritamente Descritivo e Analítico)  
**Data da Auditoria:** 09 de Novembro de 2026  
**Arquivos Inspecionados no Codebase:**
- `src/types/finance.ts` e `src/types/acquisitions.ts`
- `src/utils/financeEngine.ts` e `src/utils/stateMachine.ts`
- `src/App.tsx` (linhas 1–2770)
- `src/services/firebase.ts` e `src/services/acquisitionsFirebase.ts`
- `src/components/DashboardView.tsx`
- `src/components/TransactionsView.tsx`
- `src/components/AccountsCardsView.tsx`
- `src/components/UniversalTransactionModal.tsx`
- `src/components/TransactionDetailModal.tsx`
- `src/components/PendingDisputesView.tsx`
- `src/components/SpacesLedgerView.tsx`
- `src/components/ConfirmSettlementModal.tsx`
- `src/components/acquisitions/AcquisitionsModuleView.tsx`
- `src/components/acquisitions/WorkspaceBoardView.tsx`

---

## 1. Contexto e Metodologia da Auditoria

Esta auditoria realizou uma verificação cruzada entre as 4 áreas fundamentais do sistema:
1. **Financeiro Individual:** Independência de registros pessoais, fluxo de caixa, cartões e orçamentos;
2. **Espaços Compartilhados:** Despesas coletivas, rateios, participantes e governança;
3. **Rateios Avulsos:** Despesas pessoais compartilhadas fora de espaços com terceiros;
4. **Listas de Aquisição:** Integração de compras de estoque, metas e wishlists com o financeiro.

### Critérios Obrigatórios de Classificação Adotados:
- **[IMPLEMENTADO]:** Existe no código e atende plenamente ao requisito operacional.
- **[PARCIALMENTE IMPLEMENTADO]:** Existe funcionalidade ou estrutura no código, mas possui lacunas de fluxo ou atende parcialmente.
- **[INEXISTENTE]:** Não existe no código atual (nenhum arquivo, tabela ou função implementa o requisito).
- **[INSEGURO]:** Existe no código, mas apresenta falhas graves de integridade contábil, vazamento de permissão ou ausência de validação de regras.
- **[NÃO COMPROVADO]:** Não foi possível verificar evidência empírica no código existente.

---

## 2. Resposta às Cinco Perguntas Centrais da Auditoria

---

### PERGUNTA 1: O Financeiro Individual Está Realmente Implementado?

**Veredito Técnico:** **PARCIALMENTE IMPLEMENTADO / ACOPLADO E INSEGURO NA LIQUIDAÇÃO DE CARTÕES.**

O financeiro individual possui suporte real para registro de transações pessoais e contas bancárias, mas **não é 100% independente do modelo compartilhado**, compartilha a mesma coleção Firestore e carece de mecanismos elementares como pagamentos parciais e transporte de saldos.

#### Evidências Analisadas por Recurso:
1. **Criação de Receitas e Despesas Pessoais [IMPLEMENTADO]:**
   - No `UniversalTransactionModal.tsx:432-475`, o usuário pode salvar uma transação com `type: 'income'` ou `'expense'`. Quando não seleciona um espaço, o sistema grava `spaceId: ''`.
   - Na listagem (`TransactionsView.tsx:142`) e no Dashboard (`DashboardView.tsx:116`), o filtro `!tx.spaceId` isola as transações individuais.
2. **Contas Bancárias e Cartões de Crédito [IMPLEMENTADO]:**
   - Em `AccountsCardsView.tsx` e `src/types/finance.ts:3-15`, o usuário cria contas `checking` (com saldo inicial) e `credit` (com limite, dia de fechamento e dia de vencimento).
3. **Registro de Pendências e Status [IMPLEMENTADO]:**
   - A função `computeAutomatedStatus` em `src/utils/financeEngine.ts:16-43` calcula automaticamente os estados `'paid'`, `'pending'`, `'overdue'`, `'validating'` e `'rejected'` baseado em `dueDate` e `paymentDate`.
4. **Pagamentos Parciais [INEXISTENTE]:**
   - O modelo `Transaction` (`src/types/finance.ts:68-102`) possui apenas `amount: number` e um booleano de quitação `paymentDate?: string`. Não há suporte para quitar R$ 50 de uma conta de R$ 200 e manter saldo devedor residual de R$ 150.
5. **Transporte de Saldos entre Competências (Rollover) [INEXISTENTE]:**
   - Todo o sistema filtra rigidamente por `tx.invoiceMonth === selectedMonth` (`DashboardView.tsx:112` e `financeEngine.ts:391`). Na virada do mês, contas vencidas de meses anteriores não são transportadas automaticamente para compor o saldo inicial da competência seguinte.
6. **Orçamento Pessoal [PARCIALMENTE IMPLEMENTADO / APENAS VISUAL]:**
   - O `monthlyBudget` existe em `Space` e `Workspace`, e no Dashboard existem barras comparativas de consumo por categoria. Porém, não há alocação orçamentária rígida, travas de estouro de orçamento ou projeção de metas financeiras.
7. **Faturas de Cartão e Pagamento de Faturas [INSEGURO / FALHA CRÍTICA COMPROVADA]:**
   - O cálculo de faturas agrupa compras por `tx.accountId === card.id && tx.invoiceMonth === invoiceMonth` (`financeEngine.ts:61-125`).
   - **Falha Crítica no Pagamento (`src/App.tsx:825-865`):** A função `handlePayInvoice(card, invoiceMonth, _sourceCheckingId)` recebe a conta corrente pagadora no argumento `_sourceCheckingId`, mas a variável é **prefixada com underscore e totalmente ignorada no código**! O sistema apenas marca os itens do cartão como `'paid'`, **sem debitar um único centavo da conta bancária de origem**. O pagamento de fatura atual é puramente cosmético.
8. **Transferências entre Contas Próprias [INEXISTENTE]:**
   - Não existe entidade ou fluxo para transferir R$ 500 do "Nubank" para o "Itaú" do mesmo usuário.
9. **Fluxo Completo de uma Despesa Individual:**
   - Formulário $\rightarrow$ Grava em `/transactions/{tx.id}` com `spaceId: ''` $\rightarrow$ Aparece na aba de Transações e Dashboard $\rightarrow$ Edição manual para status `'paid'` com data de pagamento $\rightarrow$ Se for em conta corrente, o saldo da conta é recalculado visualmente; se for em cartão, aguarda a liquidação da fatura.

---

### PERGUNTA 2: Os Dados Individuais e Compartilhados Estão Corretamente Separados?

**Veredito Técnico:** **INSEGURO / FRACAMENTE ACOPLADO POR STRINGS EM COLEÇÃO GLOBAL ÚNICA.**

A separação física entre dados individuais e dados de espaços **não existe no banco de dados**. Ambos convivem misturados na mesma coleção raiz do Firestore.

```
ESTRUTURA ATUAL NO BANCO DE DADOS (FIRESTORE)
coleção: 'transactions'
├── doc: tx_001 { userId: "keniel_123", spaceId: "",         amount: 150, participantEmails: ["keniel@email.com"] }  <-- INDIVIDUAL
├── doc: tx_002 { userId: "keniel_123", spaceId: "sp_jardins",amount: 400, participantEmails: ["keniel@email.com", "mariana@email.com"] } <-- COMPARTILHADO
└── doc: tx_003 { userId: "keniel_123", spaceId: "",         amount: 300, participantEmails: ["keniel@email.com", "mariana@email.com"] } <-- RATEIO AVULSO
```

#### Fragilidades Técnicas Identificadas:
1. **Dependência Exclusiva de Flag de Texto (`spaceId`):**
   - A única distinção entre um gasto pessoal íntimo e uma despesa de condomínio é a presença ou ausência da string `tx.spaceId`. Se um bug ou falha de rede salvar `spaceId` nulo ou com espaço em branco, o gasto pessoal vaza para o espaço ou o gasto coletivo se perde.
2. **Dependência Frágil de E-mails (`participantEmails`):**
   - As consultas no Firestore (`src/App.tsx:605-608`) executam:
     `where('participantEmails', 'array-contains', email)`
   - Se o usuário atualizar seu e-mail no Firebase Auth, ele perde o acesso imediato a todas as suas transações históricas individuais e coletivas.
3. **Ausência de Isolamento Documental:**
   - Não existem subcoleções como `/users/{uid}/transactions` ou `/spaces/{spaceId}/transactions`. Todas as transações do sistema residem na mesma coleção raiz `/transactions`.
4. **Vazamento Potencial na Saída de Participante:**
   - Se um morador sai de um espaço compartilhado, o e-mail dele permanece gravado no array `participantEmails` das despesas históricas em `/transactions`. Sem uma rotina atômica de remoção, o ex-participante continua recebendo os dados das transações pelo listener do Firestore.
5. **Ausência de Regras de Segurança no Repositório:**
   - Não há arquivo local de `firestore.rules`. As operações usam leitura e escrita irrestritas no cliente (`getDocs`, `setDoc`, `updateDoc`).

---

### PERGUNTA 3: O Rateio Avulso Está Implementado ou Pode Ser Reaproveitado?

**Veredito Técnico:** **PARCIALMENTE IMPLEMENTADO / REAPROVEITÁVEL COMO BASE DE UI, MAS COM FALHAS GRAVES DE FLUXO E VÍNCULO.**

Existe uma estrutura funcional de rateio fora de espaço no código, mas ela opera sobre o mesmo documento da despesa original, sem criar uma obrigação independente no financeiro do participante devedor.

#### Análise do Fluxo do Cenário Proposto (Keniel R$ 300 / Mariana R$ 100):

| Etapa do Cenário Proposto | Situação no Código Atual | Evidência Técnica | Como Funciona Hoje no Sistema |
| :--- | :--- | :--- | :--- |
| **1. Keniel registra despesa de R$ 300 no financeiro pessoal** | **IMPLEMENTADO** | `UniversalTransactionModal.tsx:432` | Salva com `amount: 300`, `spaceId: ''`, `accountId: keniel_checking`. |
| **2. Keniel adiciona split de R$ 100 para Mariana** | **IMPLEMENTADO** | `UniversalTransactionModal.tsx:327-370` | Keniel clica em "Adicionar Participante", insere o e-mail de Mariana e define `responsibility: 100`. Mariana entra em `splits` com `status: 'pending'`. |
| **3. Mariana recebe notificação** | **IMPLEMENTADO** | `PendingDisputesView.tsx:53-70` | Na aba "Notificações / Pendências", o filtro `adhocInboxItems` captura transações onde `!tx.spaceId` e `splits` contêm o e-mail de Mariana pendente. |
| **4. Mariana aceita a obrigação** | **IMPLEMENTADO** | `App.tsx:1866-1915` (`handleAcceptSplit`) | Mariana clica em "Aceitar Cota". O status do split dela passa para `'accepted'`. |
| **5. Criação de despesa/pendência no financeiro de Mariana** | **INEXISTENTE / FALHA DE ARQUITETURA** | `App.tsx:1882-1894` | **Não é criada nenhuma despesa no financeiro de Mariana.** O sistema apenas altera o array `splits` dentro do documento original de Keniel. O financeiro pessoal de Mariana não registra passivo em suas contas. |
| **6. Mariana informa que pagou** | **INEXISTENTE** | Nenhuma função no código | Não existe botão ou modal para Mariana informar *"Realizei o PIX para Keniel"*. |
| **7. Keniel recebe solicitação para confirmar recebimento** | **INEXISTENTE** | Nenhuma função no código | Não há tela ou fila de confirmação de recebimento para despesas avulsas. |
| **8. Keniel confirma recebimento** | **INEXISTENTE** | Nenhuma função no código | Keniel apenas tem a opção de dar baixa manual geral na despesa inteira via `handleToggleStatus`. |
| **9. Baixa da obrigação de Mariana** | **INEXISTENTE** | N/A | Não há baixa individual desacoplada da despesa inteira. |
| **10. Reembolso vinculado sem inflar receita** | **INEXISTENTE** | N/A | O sistema não gera a transação de crédito/reembolso vinculada na conta bancária de Keniel. |

#### O Que Pode Ser Reaproveitado:
- A interface de Inbox e negociação de rateios em `PendingDisputesView.tsx:89-130`: a modalidade de propor novo valor (`handleProposeNewValue`) e de recusa com justificativa (`handleRejectSplit`) já está madura e funcional na interface.
- O componente de divisão de cotas no `UniversalTransactionModal.tsx`.

---

### PERGUNTA 4: Existe um Controle Completo de Transferências entre Participantes?

**Veredito Técnico:** **INEXISTENTE.**

Não existe **nenhuma entidade de Transferência**, nem controle de custódia, confirmação de recebimento ou devoluções no banco de dados.

#### Evidências Técnicas:
1. **A Interface `SettlementTransfer` é um Tipo Efêmero em Memória:**
   - Em `src/types/finance.ts:119-125`, existe a interface `SettlementTransfer` (`fromEmail`, `toEmail`, `amount`).
   - Porém, essa interface é utilizada **exclusivamente como retorno em memória** do algoritmo guloso de compensação (`financeEngine.ts:333, 505`). Não existe coleção `/transfers` ou `/settlements` no Firestore.
2. **Liquidação Simulada como Despesa Comum:**
   - Quando o usuário clica em liquidar no Livro-Razão, a função `handleSettlementTransfer` (`src/App.tsx:1806-1860`) cria uma **despesa comum** com texto sintético:
     `description: "Reembolso Livro-Razão: de Mariana para Keniel"`
   - Não há controle de envio $\rightarrow$ recebimento bancário $\rightarrow$ custódia temporária.
3. **Cenário de Adiantamento (R$ 500 enviados / R$ 350 gastos / R$ 150 devolvidos):**
   - **Totalmente Insuportado:** Se Mariana transferir R$ 500 para Keniel pagar contas, o sistema atual não tem onde registrar a custódia. Se Keniel registrar entrada de R$ 500, o sistema computa como receita pessoal dele (inflando sua renda). Ao devolver os R$ 150, não há rastreabilidade da origem.

---

### PERGUNTA 5: O Modelo de Aprovação e Governança Está Compatível com as Novas Regras?

**Veredito Técnico:** **PARCIALMENTE IMPLEMENTADO / INCOMPATÍVEL COM A REGRA DE GOVERNANÇA PELO RESPONSÁVEL DA DESPESA.**

O modelo atual mistura aprovação de convites de espaço com aceites de rateio avulso, e não possui máquina de validação para pagamentos informados nem histórico de revogações.

#### Confronto com as Diretrizes Definidas pelo Usuário:
1. **Validação pelo Responsável da Despesa (Credor) vs. Administrador do Espaço:**
   - *Diretriz do Usuário:* A validação de um pagamento pertence ao responsável pela despesa (quem desembolsou o dinheiro), e não a um administrador genérico.
   - *Situação Atual no Código:* Não há distinção entre o dono do espaço e o responsável pela despesa para fins de aprovação. Em espaços compartilhados, qualquer despesa entra diretamente como ativa/concluída sem passar por aprovação de ninguém.
2. **Fluxo de Aprovação de Pagamentos Informados [INEXISTENTE]:**
   - Não existe o fluxo onde o participante devedor declara *"Paguei minha cota"* e o responsável pela despesa aprova ou recusa com comprovante.
3. **Revogação de Aprovações Anteriores [INEXISTENTE]:**
   - Não existe estorno ou revogação com preservação de histórico. Se o status for alterado, o dado anterior é simplesmente sobrescrito no documento.
4. **Notificações e Sucessão de Responsável [INEXISTENTE]:**
   - Não há lógica de transição de responsabilidade caso um participante saia do espaço.

---

## 3. Auditoria Específica de Integração com Listas de Aquisição

A auditoria cruzada entre `AcquisitionsModuleView.tsx`, `WorkspaceBoardView.tsx` e o módulo de Finanças (`src/App.tsx`) confirmou:

| Ponto de Integração Auditado | Situação Real no Código | Evidência no Código-Fonte | Análise Técnica |
| :--- | :--- | :--- | :--- |
| **Listas Individuais geram despesas individuais?** | **PARCIALMENTE IMPLEMENTADO** | `src/App.tsx:2584-2596` | O handler `onCreateExpenseFromPurchase` abre o modal de despesa preenchendo apenas descrição e valor. Força `setPresetSpaceId(undefined)`, mas não pré-associa à conta corrente do usuário nem preenche categoria. |
| **Listas Compartilhadas geram despesas no Espaço?** | **FALHA DE INTEGRAÇÃO** | `src/App.tsx:2587` | Mesmo que a lista pertença a um espaço compartilhado (`workspace.type === 'Compartilhado'`), o handler na raiz executa `setPresetSpaceId(undefined)`, perdendo o vínculo do espaço! O usuário precisa selecionar manualmente o espaço e os participantes. |
| **Vínculo Persistente entre Compra e Despesa** | **INEXISTENTE** | `src/types/acquisitions.ts` e `src/types/finance.ts` | A entidade `Transaction` não possui `acquisitionItemId` ou `checkoutId`. O `AcquisitionItem` não possui `transactionId`. São sistemas totalmente desvinculados após o cadastro inicial. |
| **Identificação de Quem Comprou e Quem Pagou** | **INEXISTENTE** | `WorkspaceBoardView.tsx:505-541` | O modal de carrinho de compras solicita apenas marca, preço unitário, quantidade e loja. Não pergunta quem pagou nem a conta de débito. |
| **Atualização de Estoque no Checkout** | **IMPLEMENTADO** | `src/utils/stateMachine.ts:104-152` | A função `confirmCartCheckout` soma a quantidade comprada ao `currentStock` e grava o registro em `productsHistory`. Funciona perfeitamente dentro do módulo de aquisições. |
| **Cancelamentos e Reversões Integrados** | **INSEGURO / DESCONECTADO** | `src/utils/stateMachine.ts:155-168` | Ao clicar em reverter compra (`revertConfirmedCheckout`), o sistema desfaz o estoque no item, **mas a despesa financeira gerada continua ativa e intocada no módulo financeiro**, gerando duplicidade e descompasso contábil imediato. |

---

## 4. Mapa Atual de Entidades e Relacionamentos no Banco de Dados

```
COLEÇÃO: 'users'
 └── UserProfile { uid, email, name, isAdmin }

COLEÇÃO: 'accounts'
 └── Account { id, userId, name, type: 'checking'|'credit', balance, limit, closingDay, dueDay }

COLEÇÃO: 'categories'
 └── Category { id, userId, name, type: 'income'|'expense'|'both' }

COLEÇÃO: 'spaces'
 └── Space { id, ownerId, ownerEmail, name, participantEmails, participants[], enabledModules[], monthlyBudget }

COLEÇÃO: 'transactions'  <-- (GLOBAL E SOBRECARREGADA)
 └── Transaction {
       id, userId, ownerEmail, amount, type: 'income'|'expense',
       status: 'paid'|'pending'|'overdue'|'validating'|'rejected',
       accountId, competenceDate, dueDate, paymentDate, invoiceMonth,
       recurrenceType, installmentIndex, installmentTotal,
       spaceId,          // VAZIO se individual, PREENCHIDO se espaço
       paidByEmail,      // Quem pagou ('space_cash' se caixa coletivo)
       participantEmails[],
       splits: SplitShare[] { email, name, responsibility, paidAmount, status: 'accepted'|'pending'|'rejected'|'disputed' }
     }

COLEÇÃO: 'workspaces'  <-- (DUPLICADA COM 'spaces')
 └── Workspace { id, name, type: 'Individual'|'Compartilhado', ownerUid, acceptedMemberEmails[], members[] }

COLEÇÃO: 'lists'
 └── AcquisitionList { id, workspaceId, name, type: 'recorrente'|'objetivo'|'desejo', acceptedMemberEmails[] }

COLEÇÃO: 'items'
 └── AcquisitionItem {
       id, listId, workspaceId, name, groupId, categoryId, stage,
       currentStock, minStock, targetAmount, savedAmount, finalPaidAmount,
       quotes[], deposits[], productsHistory[]
     }
```

---

## 5. Tabela Consolidada de Diagnóstico por Funcionalidade

Abaixo está o inventário completo de todas as funcionalidades auditadas, com sua classificação rigorosa e evidência técnica no código:

| Área do Sistema | Funcionalidade Auditada | Status Técnico | Arquivo / Evidência no Código | Justificativa Técnica do Diagnóstico |
| :--- | :--- | :--- | :--- | :--- |
| **Financeiro Individual** | Cadastro de Receitas e Despesas | **IMPLEMENTADO** | `UniversalTransactionModal.tsx:432` | Opera com `spaceId: ''`, salva tipos e categorias. |
| | Contas Correntes e Cartões | **IMPLEMENTADO** | `AccountsCardsView.tsx:35` | Gestão de saldos, limites e vencimentos. |
| | Pagamentos Parciais de Despesas | **INEXISTENTE** | `src/types/finance.ts:74` | `amount` é indivisível; status é binário (`paid` ou pendente). |
| | Rollover / Transporte de Saldo entre Meses | **INEXISTENTE** | `DashboardView.tsx:112` | Filtro `invoiceMonth === selectedMonth` oculta meses passados. |
| | Liquidação Real de Fatura de Cartão | **INSEGURO** | `src/App.tsx:826, 840` | `_sourceCheckingId` é ignorado; não há débito em conta bancária. |
| | Transferências entre Contas Próprias | **INEXISTENTE** | `src/types/finance.ts` | Não há entidade ou formulário de transferência interna. |
| | Orçamento Pessoal com Travas | **PARCIALMENTE IMPLEMENTADO** | `DashboardView.tsx:1130` | Visualização de progresso apenas, sem trava ou orçamento rígido. |
| **Espaços Compartilhados** | Livro-Razão e Compensação Multimembro | **IMPLEMENTADO** | `financeEngine.ts:330-515` | Algoritmo guloso de net balance mensal funciona perfeitamente. |
| | Caixa Coletivo (`space_cash`) | **PARCIALMENTE IMPLEMENTADO** | `financeEngine.ts:400` | Abate gastos do espaço, mas o saldo é volátil e sem auditoria. |
| | Governança por UID estável | **INSEGURO** | `src/types/finance.ts:45, 96` | Usa `participantEmails: string[]` em vez de UIDs nas regras e queries. |
| | Histórico de Aprovações e Reversões | **INEXISTENTE** | `src/App.tsx:1806` | Liquidações sobrescrevem registros sem tabela de log de reversão. |
| **Rateios Avulsos** | Notificação de Cota Pendente (Inbox) | **IMPLEMENTADO** | `PendingDisputesView.tsx:53` | Exibe despesas com `!tx.spaceId` pendentes de aceite. |
| | Aceite, Recusa e Contraproposta de Cota | **IMPLEMENTADO** | `src/App.tsx:1866-2020` | Funções `handleAcceptSplit`, `handleRejectSplit` operacionais. |
| | Criação de Passivo no Financeiro do Convidado | **INEXISTENTE** | `src/App.tsx:1882` | O aceite altera apenas o documento do autor; não gera conta a pagar no convidado. |
| | Confirmação de Pagamento pelo Responsável | **INEXISTENTE** | Nenhuma função | Não há fluxo de confirmação de recebimento para baixa da cota. |
| | Reembolso Vinculado sem Duplicar Receita | **INEXISTENTE** | N/A | Não existe entidade de reembolso avulso para crédito do pagador. |
| **Transferências** | Entidade de Transferência e Custódia | **INEXISTENTE** | `src/types/finance.ts:119` | `SettlementTransfer` é apenas interface de memória em algoritmo. |
| | Devolução Parcial de Adiantamento | **INEXISTENTE** | N/A | Não há suporte a saldo disponível sob custódia de terceiros. |
| **Listas de Aquisição** | Máquinas de Estado (Recorrente, Objetivo, Desejo) | **IMPLEMENTADO** | `src/utils/stateMachine.ts:13-313` | Transições Kanban, metas e wishlists 100% operacionais. |
| | Controle de Estoque com Alerta Crítico | **IMPLEMENTADO** | `src/utils/stateMachine.ts:58-62, 171` | Decremento, incremento no checkout e alerta mínimo funcionando. |
| | Histórico de Compras e Preços Médios | **IMPLEMENTADO** | `src/utils/stateMachine.ts:70-101` | Calcula menor preço, preço médio e última loja por produto. |
| | Vínculo Transacional Bidirecional Lista $\leftrightarrow$ Finanças | **PARCIALMENTE IMPLEMENTADO** | `src/App.tsx:2584` | Abre modal financeiro pré-preenchido, mas perde o ID do item e o `spaceId`. |
| | Reversão de Compra com Estorno Financeiro | **INEXISTENTE** | `src/utils/stateMachine.ts:155` | Reverte o estoque no item, mas deixa a despesa financeira órfã. |
| | Separação de Listas Individuais e de Espaços | **PARCIALMENTE IMPLEMENTADO** | `AcquisitionsModuleView.tsx:138` | Usa adaptador de memória com `workspaces`, sem hierarquia definitiva. |

---

## 6. Problemas Estruturais de Arquitetura Identificados

1. **A Coleção `transactions` é Monolítica e Sobrecarregada:**
   - O mesmo documento armazena despesas individuais, despesas de espaços, aportes de caixa, liquidações sintéticas e rateios avulsos, dependendo de condicionais frágeis (`spaceId ?`, `paidByEmail === 'space_cash'`, `description.startsWith('Reembolso')`).
2. **Duplicidade de Espaços:**
   - O sistema persiste `spaces` para finanças e `workspaces` para listas de aquisições. Devem ser fundidos em uma única hierarquia.
3. **Ausência de Backend Transacional Confiável:**
   - Mutações que envolvem dois participantes (ex: pagar fatura, liquidar dívida, transferir adiantamento) são disparadas diretamente do cliente via SDK Web, sem garantia ACID de execução mútua.

---

## 7. Roteiro Técnico Recomendado: O Que Reaproveitar, Adaptar e Desenvolver

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          ROTEIRO TÉCNICO DE IMPLEMENTAÇÃO                              │
├─────────────────────────┬────────────────────────────┬─────────────────────────────────┤
│    O QUE REAPROVEITAR   │       O QUE ADAPTAR        │        O QUE DESENVOLVER        │
│      (Pronto no Código) │    (Refatorar Estrutura)   │       (Construir do Zero)       │
├─────────────────────────┼────────────────────────────┼─────────────────────────────────┤
│ • Motor de compensação  │ • Desacoplar Transações    │ • Entidade e fluxo de           │
│   gulosa (financeEngine)│   Individuais vs Espaços   │   Transferências e Adiantamentos│
│ • UI de negociação do   │ • Corrigir pagamento real  │ • Fluxo de confirmação de baixa │
│   PendingDisputesView   │   de faturas de cartão     │   em Rateios Avulsos (2 vias)   │
│ • 3 Máquinas de Estado  │ • Unificar Workspace em    │ • Vínculo bidirecional atômico  │
│   das Listas (Kanban)   │   Espaço definitivo        │   entre Lista e Despesa         │
│ • Catálogo de Taxonomia │ • Migrar ACL de e-mails    │ • Pagamentos Parciais e         │
│   e histórico de preços │   para UIDs estáveis       │   Transporte de Saldos (Multimês│
└─────────────────────────┴────────────────────────────┴─────────────────────────────────┘
```

---

## 8. Dúvidas de Negócio Críticas que Impedem Decisões Técnicas

Para que o plano de implementação final seja elaborado com precisão cirúrgica, restam apenas **3 dúvidas de regra de negócio**:

1. **Rateio Avulso no Cartão de Crédito:** Quando Keniel paga uma compra avulsa de R$ 300 no cartão de crédito pessoal e Mariana deve R$ 100, quando Mariana transferir os R$ 100 para Keniel:
   - O dinheiro deve entrar como saldo na conta corrente de Keniel como "Reembolso Recebido", ou o sistema deve abater diretamente a fatura aberta do cartão?
2. **Destino do Estoque na Dissolução do Espaço:** Se um Espaço Compartilhado for desfeito, as listas e os itens de estoque cadastrados devem ser arquivados juntamente com o espaço, ou transferidos para o perfil individual do responsável?
3. **Limite de Adiantamento entre Participantes:** Um participante pode enviar uma transferência/adiantamento a qualquer momento para outro, ou toda transferência deve estar previamente atrelada a uma despesa ou solicitação aprovada?

*Este documento encerra a auditoria técnica cruzada. Nenhuma linha de código foi implementada ou alterada, aguardando suas diretrizes para os próximos passos.*
