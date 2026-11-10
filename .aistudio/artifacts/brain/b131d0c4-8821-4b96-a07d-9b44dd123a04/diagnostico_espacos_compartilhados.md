# Diagnóstico Completo da Lógica Atual dos Espaços Compartilhados

Este documento apresenta a reconstrução reversa e a auditoria técnica de toda a arquitetura financeira dos **Espaços Compartilhados**, baseada estritamente no código-fonte, nos modelos de dados, nas funções matemáticas e nos componentes em execução (`src/types/finance.ts`, `src/utils/financeEngine.ts`, `src/App.tsx`, `src/components/SpacesLedgerView.tsx`, `src/components/UniversalTransactionModal.tsx`, `src/components/ConfirmSettlementModal.tsx`, `src/components/DashboardView.tsx`, `src/components/AccountsCardsView.tsx`).

---

## 1. Visão Geral da Arquitetura Financeira Atual

A arquitetura dos Espaços Compartilhados opera sob o padrão **Livro-Razão Multimembro Mensal com Fechamento por Competência/Fatura (`invoiceMonth`)**, inspirado no modelo matemático do *Splitwise*, combinado com um conceito de **Caixa Coletivo Virtual (`space_cash`)**.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   ARQUITETURA ATUAL                                     │
├────────────────────────────────┬───────────────────────────┬────────────────────────────┤
│       BANCO DE DADOS           │      MOTOR DE CÁLCULO     │         INTERFACE          │
│       (Firestore/Cache)        │   (src/utils/financeEngine)│   (React / Componentes)    │
├────────────────────────────────┼───────────────────────────┼────────────────────────────┤
│ • Coleção 'spaces'             │ • calculateSpaceLedger()  │ • SpacesLedgerView         │
│ • Coleção 'transactions'       │ • calculateCreditCard...()│ • UniversalTransactionModal│
│ • Coleção 'accounts'           │ • generateRecurrence...() │ • ConfirmSettlementModal   │
│ • Coleção 'categories'         │ • computeAutomatedStatus()│ • DashboardView            │
│ • Coleção 'users'              │ • filterCascadeTargets()  │ • AccountsCardsView        │
└────────────────────────────────┴───────────────────────────┴────────────────────────────┘
```

### Características Centrais da Implementação Atual:
1. **Natureza Transacional Única:** Não existem tabelas separadas para "Dívidas", "Saldos Acumulados" ou "Contas a Pagar do Espaço". Toda a inteligência contábil é **calculada em tempo real** através da função pura `calculateSpaceLedger()`, que itera sobre o array de `Transaction` do mês selecionado.
2. **Escopo Estritamente Mensal:** Os saldos, rateios, caixas e sugestões de transferências **não transitam automaticamente de um mês para o outro**. O Livro-Razão é filtrado por `tx.spaceId === space.id && tx.invoiceMonth === selectedMonth`.
3. **Descentralização Bancária:** O Espaço em si **não possui conta bancária real**. Toda transação compartilhada utiliza obrigatoriamente a conta bancária ou cartão de crédito (`accountId`) do participante que realizou o cadastro.

---

## 2. Diagrama Textual das Entidades e Relacionamentos

```
                    ┌─────────────────────────┐
                    │       UserProfile       │
                    │ (uid, name, email)      │
                    └────────────┬────────────┘
                                 │ 1:N
         ┌───────────────────────┼────────────────────────┐
         │ 1:N                   │ 1:N                    │ 1:N
         ▼                       ▼                        ▼
┌──────────────────┐    ┌─────────────────┐     ┌──────────────────┐
│     Account      │    │    Category     │     │      Space       │
│ (checking/credit)│    │ (income/expense)│     │(enabledModules[])│
└────────┬─────────┘    └────────┬────────┘     └────────┬─────────┘
         │                       │                       │
         │ 1:N                   │ 1:N                   │ 1:N (spaceId)
         └───────────────────────┼───────────────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │      Transaction      │
                     │  (Despesa ou Receita) │
                     └───────────┬───────────┘
                                 │ 1:N (embebido)
                                 ▼
                     ┌───────────────────────┐
                     │      SplitShare       │
                     │(responsibility/paid)  │
                     └───────────────────────┘
```

---

## 3. Explicação de Cada Entidade

### 3.1. `Space` (Espaço Compartilhado)
* **Finalidade:** Agrupa participantes em torno de um núcleo de despesas, caixa comum e/ou listas de compras.
* **Principais Campos (`src/types/finance.ts` linhas 37-52):**
  * `id`: Identificador único (`space_${timestamp}`).
  * `ownerId` / `ownerEmail`: Usuário criador do espaço.
  * `name`, `description`, `icon`, `color`: Metadados visuais.
  * `participantEmails`: Array de strings com e-mails em minúsculo (usado na regra de consulta `array-contains` do Firestore).
  * `participants`: Array de objetos `SpaceParticipant` (`{ email, name, status: 'active' | 'invited' }`).
  * `enabledModules`: Array com `'finance'`, `'acquisitions'` ou ambos.
  * `monthlyBudget`: Limite orçamentário mensal de compras (utilizado no módulo de aquisições).
* **Relacionamentos:** 1 Espaço possui N Transações (`Transaction.spaceId`) e N Listas de Compras (`AcquisitionList.workspaceId`).
* **Manipulação:** Criado, editado e excluído em `src/App.tsx` (`handleCreateSpace`, `handleDeleteSpace`) e renderizado em `src/components/SpacesLedgerView.tsx`.

### 3.2. `Transaction` (Lançamento Financeiro Universal)
* **Finalidade:** Representa qualquer evento financeiro: despesa individual, despesa compartilhada, aporte de receita no espaço ou acerto de reembolso do Livro-Razão.
* **Principais Campos (`src/types/finance.ts` linhas 68-102):**
  * `id`: Chave primária (`tx_${timestamp}_${index}`).
  * `userId`: UID do usuário que criou o registro.
  * `amount`: Valor monetário nominal bruto.
  * `type`: `'expense'` (despesa) ou `'income'` (receita/aporte).
  * `status`: `'paid'`, `'pending'`, `'overdue'`, `'validating'`, `'rejected'`.
  * `competenceDate`: Data em que a compra ocorreu (`YYYY-MM-DD`).
  * `dueDate`: Data de vencimento financeiro (`YYYY-MM-DD`).
  * `paymentDate`: Data da baixa efetiva (preenchida quando `status === 'paid'`).
  * `invoiceMonth`: Mês de competência/fatura de vinculação (`YYYY-MM`).
  * `spaceId`: ID do espaço (vazio `''` se for transação individual).
  * `paidByEmail`: Em despesas, e-mail do pagador ou `'space_cash'` se liquidado pelo caixa coletivo. Em receitas, e-mail de quem aportou.
  * `recipientEmail`: Em receitas do espaço, quem confirma a entrada no caixa.
  * `participantEmails`: Lista de todos os membros envolvidos para indexação no banco.
  * `splits`: Array de `SplitShare`.
  * `recurrenceType`, `recurrenceGroupId`, `installmentIndex`, `installmentTotal`: Controle de parcelamento e recorrência fixa.

### 3.3. `SplitShare` (Fatia de Rateio Embebida)
* **Finalidade:** Define a responsabilidade matemática e o desembolso real de cada participante naquela transação específica.
* **Principais Campos (`src/types/finance.ts` linhas 58-66):**
  * `email`: E-mail do participante.
  * `name`: Nome do participante.
  * `responsibility`: Valor em R$ que o participante deve pagar na despesa.
  * `paidAmount`: Valor em R$ que o participante efetivamente desembolsou no momento do pagamento.
  * `status`: `'accepted'`, `'pending'`, `'rejected'`, `'disputed'`.

### 3.4. `Account` (Conta Bancária / Cartão de Crédito)
* **Finalidade:** Registra o meio de pagamento utilizado.
* **Principais Campos (`src/types/finance.ts` linhas 3-15):**
  * `type`: `'checking'` (conta corrente/carteira) ou `'credit'` (cartão de crédito).
  * `balance`: Saldo inicial/estático da conta corrente.
  * `limit`: Limite total do cartão de crédito.
  * `closingDay` / `dueDay`: Dia de fechamento e dia de vencimento da fatura.

### 3.5. `Caixa Coletivo` (`availableSpaceCash`)
* **Confirmação no Código:** **Não existe uma tabela ou documento `Cash` no banco.** O Caixa Coletivo é uma variável calculada em tempo de execução dentro de `calculateSpaceLedger()`:
  $$\text{availableSpaceCash} = \text{totalConfirmedIncome} - \text{paidViaSpaceCashExpenses}$$

---

## 4. Fluxos Completos dos Oito Cenários

### Cenário A — Despesa Paga por um Participante
* **Operação:** Keniel registra R$ 400,00 no Supermercado, pago com sua conta bancária (`checking`), rateio igualitário com Mariana.
* **Registro Criado:**
  * `Transaction`: `{ amount: 400, type: 'expense', status: 'paid', paidByEmail: 'keniel@...', spaceId: 'sp_1' }`
  * `splits`:
    * Keniel: `{ responsibility: 200, paidAmount: 400, status: 'accepted' }`
    * Mariana: `{ responsibility: 200, paidAmount: 0, status: 'accepted' }`
* **Impacto no Banco Individual:**
  * Keniel: Em `AccountsCardsView.tsx` (`getCheckingDynamicBalance`), o saldo bancário da conta de Keniel reduz **R$ 400,00** integralmente.
  * Mariana: Nenhuma conta bancária de Mariana é afetada.
* **Impacto no Dashboard:**
  * Na Visão Geral (`DashboardView.tsx`), a função `getEffectiveAmount` de Keniel computa apenas a sua cota: **R$ 200,00** de despesa.
  * Na Visão Geral de Mariana, computa a cota dela: **R$ 200,00** de despesa.
* **Impacto no Livro-Razão do Espaço (`calculateSpaceLedger`):**
  * Despesas Compartilhadas: R$ 400,00.
  * Keniel: Pago R$ 400,00 | Cota R$ 200,00 $\rightarrow$ **Saldo Líquido: +R$ 200,00 (Crédito / A Receber)**.
  * Mariana: Pago R$ 0,00 | Cota R$ 200,00 $\rightarrow$ **Saldo Líquido: -R$ 200,00 (Débito / A Pagar)**.
  * Sugestão: *Mariana deve transferir R$ 200,00 para Keniel*.

---

### Cenário B — Despesas Cruzadas e Compensação
* **Operação:** Mariana registra R$ 100,00 de Internet, paga por ela (`paidByEmail: 'mariana@...'`), rateio igualitário.
* **Registro Criado:**
  * `splits`: Mariana `{ responsibility: 50, paidAmount: 100 }`, Keniel `{ responsibility: 50, paidAmount: 0 }`.
* **Cálculo de Compensação:**
  * Keniel:
    * Total Responsabilidade: $200 + 50 = \text{R\$} 250,00$
    * Total Desembolsado: $\text{R\$} 400,00$
    * Saldo Líquido: $400 - 250 = \mathbf{+R\$ 150,00}$ (A Receber).
  * Mariana:
    * Total Responsabilidade: $200 + 50 = \text{R\$} 250,00$
    * Total Desembolsado: $\text{R\$} 100,00$
    * Saldo Líquido: $100 - 250 = \mathbf{-R\$ 150,00}$ (A Pagar).
* **Resultado:** O algoritmo guloso de liquidação (`transfers`) cancela a necessidade de transferências bilaterais e consolida uma única instrução: **Mariana transfere R$ 150,00 para Keniel**.

---

### Cenário C — Despesa Paga pelo Caixa Coletivo
* **Operação 1 (Aportes):** Keniel e Mariana criam duas transações de receita (`type: 'income'`) de R$ 500,00 com destino ao Espaço.
  * Keniel: `{ amount: 500, type: 'income', status: 'paid', paidByEmail: 'keniel@...' }`
  * Mariana: `{ amount: 500, type: 'income', status: 'paid', paidByEmail: 'mariana@...' }`
  * Livro-Razão: `totalConfirmedIncome = 1000.00`.
  * `availableSpaceCash = 1000.00`.
  * Keniel: `incomeContributed = 500` | Saldo: +R$ 500,00.
  * Mariana: `incomeContributed = 500` | Saldo: +R$ 500,00.
* **Operação 2 (Despesa de Energia R$ 300,00 via Caixa):**
  * Lançamento criado com `paidByEmail: 'space_cash'`.
  * Rateio gerado: Keniel `{ responsibility: 150, paidAmount: 0 }`, Mariana `{ responsibility: 150, paidAmount: 0 }`.
  * `paidViaSpaceCashExpenses` sobe para R$ 300,00.
  * `availableSpaceCash` cai para $1000 - 300 = \mathbf{R\$ 700,00}$.
  * Como `paidByEmail === 'space_cash'`, a linha 464 de `financeEngine.ts` **não adiciona** desembolso direto para ninguém.
  * Novo Saldo de Keniel: $\text{Total Pago } (500) - \text{Responsabilidade } (150) = \mathbf{+R\$ 350,00}$.
  * Novo Saldo de Mariana: $\text{Total Pago } (500) - \text{Responsabilidade } (150) = \mathbf{+R\$ 350,00}$.
  * Nenhuma transferência entre membros é gerada, pois ambos possuem saldo credor idêntico perante o caixa remanescente.

---

### Cenário D — Rateio Personalizado (70% / 30%)
* **Operação:** Keniel cadastra R$ 1.000,00 dividido em 70% (Keniel) e 30% (Mariana).
* **Processamento no Formulário (`UniversalTransactionModal.tsx` linhas 418-428):**
  * O formulário armazena explicitamente o valor absoluto em Reais no objeto `splits`:
    * Keniel: `{ responsibility: 700.00, paidAmount: 1000.00 }`
    * Mariana: `{ responsibility: 300.00, paidAmount: 0.00 }`
  * O percentual **não é gravado como string "%"**, mas sim convertido diretamente em centavos monetários para evitar erros de dízima periódica.
* **Livro-Razão:**
  * Keniel assume R$ 700,00 de responsabilidade (70% de cobertura própria) e fica credor de R$ 300,00.
  * Mariana assume R$ 300,00 de responsabilidade e fica devedora de R$ 300,00.

---

### Cenário E — Liquidação entre Participantes
* **Operação:** No painel do Livro-Razão, clica-se no botão **"Registrar Reembolso"** para liquidar a transferência sugerida de Mariana para Keniel (ex: R$ 150,00).
* **Implementação Real (`src/App.tsx` linhas 1494-1540):**
  * O sistema cria uma transação especial:
    * `description`: `"Reembolso Livro-Razão: Mariana -> Keniel"`
    * `amount`: 150.00
    * `type`: `'expense'`
    * `status`: `'paid'`
    * `paidByEmail`: `'mariana@...'`
    * `splits`:
      * Mariana: `{ responsibility: 0, paidAmount: 150, status: 'accepted' }`
      * Keniel: `{ responsibility: 150, paidAmount: 0, status: 'accepted' }`
* **O Truque Matemático no Código (`financeEngine.ts` linha 414):**
  ```ts
  const isReimbursementTransfer = tx.description.startsWith('Reembolso Livro-Razão:');
  if (!isReimbursementTransfer) {
    totalSharedExpenses = Number((totalSharedExpenses + tx.amount).toFixed(2));
  }
  ```
  * O sistema **ignora** essa transação da soma total de despesas do espaço (`totalSharedExpenses`), evitando inflar os gastos reais do grupo.
  * No loop de splits:
    * Mariana ganha `directExpensePaid += 150`, aumentando seu saldo em +R$ 150,00 (zerando o débito).
    * Keniel recebe `totalResponsibility += 150`, reduzindo seu crédito em -R$ 150,00 (zerando o crédito).
* **Vínculo com Despesas Anteriores:** **Não existe.** O acerto é uma transação cega e consolidada. O sistema não marca as despesas de supermercado ou internet como "reembolsadas"; ele simplesmente compensa o montante aritmético.

---

### Cenário F — Pagamento com Cartão de Crédito
* **Operação:** Keniel registra R$ 400,00 no Espaço pago com seu Cartão de Crédito (Fechamento dia 10, Vencimento dia 17). Compra feita no dia 12/11.
* **Processamento (`calculateCreditCardInvoice`):**
  * Como o dia 12 $\ge$ dia 10 (fechamento), a despesa é projetada para a fatura de Dezembro (`invoiceMonth = '2026-12'`).
  * A data de vencimento da transação é definida como `2026-12-17`.
* **Separação nos Painéis:**
  * No mês atual (Novembro/2026), essa despesa **não aparece no Livro-Razão**, pois o Livro-Razão é filtrado pelo mês de fatura `selectedMonth`.
  * Em Dezembro/2026, a despesa surge no Livro-Razão e na fatura do cartão.
* **Pagamento da Fatura (`handlePayInvoice` em `App.tsx` linhas 832-870):**
  * Ao clicar em "Pagar Fatura" no módulo de Cartões:
  * **O código busca todas as transações com `accountId === card.id && invoiceMonth === ym` e altera o status para `'paid'` com `paymentDate = hoje`.**
  * **INCONSISTÊNCIA CONFIRMADA NO CÓDIGO:** O parâmetro `_sourceCheckingId` (conta corrente pagadora) é descartado pelo código. O pagamento da fatura **não debita a conta corrente** e **não gera uma nova transação financeira**, apenas comuta o status das despesas de cartão de pendente para pago.

---

### Cenário G — Despesas Recorrentes (Aluguel R$ 1.500,00)
* **Operação:** Cadastro de Aluguel de R$ 1.500,00 com `recurrenceType: 'fixed'` (Fixa Mensal).
* **Implementação Real (`financeEngine.ts` linhas 203-285):**
  * O sistema gera imediatamente **12 documentos individuais** no banco de dados com `installmentIndex` de 1 a 12 e mesmo `recurrenceGroupId`.
  * Cada parcela recebe `competenceDate` e `dueDate` projetados mês a mês (`addMonthsToDate(baseDate, i)`).
  * A 1ª parcela herda o status escolhido. As parcelas futuras (mês 2 a 12) são salvas obrigatoriamente como `isPaid: false`, `paymentDate: ''`, `splits[].paidAmount: 0`.
* **Edição em Cascata (`filterCascadeTargets`):**
  * Ao editar uma parcela, o usuário escolhe:
    * `only_this`: Altera apenas aquele mês.
    * `this_and_following`: Altera do mês selecionado até o mês 12.
    * `all`: Altera todos os 12 registros do grupo.
* **Limitação:** Não há geração além de 12 meses; ao término do período, novas parcelas não são criadas automaticamente.

---

### Cenário H — Pagamento Parcial
* **Operação:** Uma despesa de R$ 1.500,00 recebe pagamento de R$ 500,00 e depois R$ 1.000,00.
* **COMPORTAMENTO REAL NO CÓDIGO:**
  * **O sistema NÃO suporta pagamentos parciais nativos.**
  * Na interface de liquidação (`ConfirmSettlementModal.tsx`), o usuário pode alterar o campo `confirmedAmount`. Se ele digitar R$ 500,00:
    * O valor total da despesa `tx.amount` é **sobrescrito** para R$ 500,00.
    * Os R$ 1.000,00 restantes são **perdidos/apagados**, pois o sistema não possui histórico de parcelas de baixa nem saldo residual.
    * Não é possível dar baixa parcial mantendo a transação aberta com o valor remanescente pendente.

---

## 5. Funcionamento do Motor de Saldos

O motor matemático está concentrado em `src/utils/financeEngine.ts` na função `calculateSpaceLedger(transactions, defaultParticipants)`.

### 5.1. Fórmulas Implementadas
Para cada participante $i$ no mês selecionado:

1. **Responsabilidade Total:**
   $$\text{totalResponsibility}_i = \sum \text{SplitShare.responsibility}$$

2. **Despesas Pagas do Próprio Bolso:**
   $$\text{directExpensePaid}_i = \sum_{\substack{\text{tx.status} = \text{'paid'} \\ \text{tx.paidByEmail} \neq \text{'space\_cash'}}} \text{SplitShare.paidAmount}$$

3. **Aportes de Receita Efetivados:**
   $$\text{incomeContributed}_i = \sum_{\substack{\text{tx.type} = \text{'income'} \\ \text{tx.status} = \text{'paid'}}} \text{tx.amount}$$

4. **Total Coberto:**
   $$\text{totalPaid}_i = \text{directExpensePaid}_i + \text{incomeContributed}_i$$

5. **Saldo Líquido:**
   $$\text{netBalance}_i = \text{totalPaid}_i - \text{totalResponsibility}_i$$

### 5.2. Algoritmo de Simplificação de Dívidas (Greedy Matching)
Localizado nas linhas 495-538 de `src/utils/financeEngine.ts`:

```typescript
// 1. Separa quem deve (netBalance < -0.01) e quem tem a receber (netBalance > 0.01)
const debtors = summaries.filter(s => s.netBalance < -0.01).sort((a,b) => b.remainingDebt - a.remainingDebt);
const creditors = summaries.filter(s => s.netBalance > 0.01).sort((a,b) => b.remainingCredit - a.remainingCredit);

// 2. Itera simultaneamente casando o maior devedor com o maior credor
while (dIdx < debtors.length && cIdx < creditors.length) {
  const amount = Math.min(debtor.remainingDebt, creditor.remainingCredit);
  transfers.push({ from: debtor.email, to: creditor.email, amount });
  debtor.remainingDebt -= amount;
  creditor.remainingCredit -= amount;
  if (debtor.remainingDebt < 0.01) dIdx++;
  if (creditor.remainingCredit < 0.01) cIdx++;
}
```

### 5.3. Exemplo Numérico de Arredondamento (Ajuste de Centavos)
Na divisão de R$ 100,00 entre 3 pessoas (`financeEngine.ts` linhas 214-219 e 427-438):
* Valor base por cota: $\lfloor 100 / 3 \times 100 \rfloor / 100 = \text{R\$} 33,33$.
* Resto de centavos: $100 - (33,33 \times 3) = \text{R\$} 0,01$.
* O primeiro participante (`idx === 0`) recebe o ajuste:
  * Participante 1: **R$ 33,34**
  * Participante 2: **R$ 33,33**
  * Participante 3: **R$ 33,33**
  * Soma exata: **R$ 100,00**.

---

## 6. Integração com as Finanças Individuais

| Funcionalidade | O que acontece no Espaço Compartilhado | O que acontece na Conta Pessoal do Criador | O que acontece na Conta Pessoal do Outro Membro |
| :--- | :--- | :--- | :--- |
| **Despesa R$ 400 (50/50)** | Entra R$ 400 total no Livro-Razão; R$ 200 de responsabilidade para cada. | O saldo bancário/cartão do criador reduz R$ 400 integralmente. | Nenhuma conta bancária é afetada. |
| **Visão Geral (Home)** | Não aplicável (filtro global). | Soma apenas R$ 200 nas despesas do mês (`getEffectiveAmount`). | Soma R$ 200 nas despesas do mês (`getEffectiveAmount`). |
| **Visão Individual** | Não aparece. | Transação ocultada pois possui `spaceId`. | Transação ocultada pois possui `spaceId`. |
| **Visão do Espaço** | Exibe a despesa integral de R$ 400. | Exibe a despesa integral de R$ 400. | Exibe a despesa integral de R$ 400. |

### O Seletor de Escopo no Topo do Dashboard (`src/components/DashboardView.tsx` linhas 111-129):
1. **Visão Geral (`overview`):**
   * Agrupa transações individuais e transações de espaços.
   * Nas transações com rateio, substitui o valor de face pelo campo `myShare.responsibility`.
2. **Individual (`individual`):**
   * Executa o filtro estrito `!tx.spaceId`.
   * **Efeito colateral:** Se o usuário pagou R$ 400,00 do bolso em uma conta de condomínio compartilhada, esse gasto desaparece da sua visão individual.
3. **Espaço Específico (`spaceId`):**
   * Filtra `tx.spaceId === activeScope`.
   * Considera o valor de face de cada despesa do grupo.

---

## 7. Recorrências, Receitas e Caixa Coletivo

```
   ┌────────────────────────────────────────────────────────┐
   │             FLUXO DO CAIXA COLETIVO                    │
   └──────────────────────────┬─────────────────────────────┘
                              │
     ┌────────────────────────┴────────────────────────┐
     ▼                                                 ▼
[Receita / Aporte]                             [Despesa do Espaço]
tx.type = 'income'                             tx.type = 'expense'
tx.status = 'paid'                             tx.paidByEmail = 'space_cash'
     │                                                 │
     ▼                                                 ▼
+ totalConfirmedIncome                         + paidViaSpaceCashExpenses
     │                                                 │
     └────────────────────────┬────────────────────────┘
                              ▼
        availableSpaceCash = totalConfirmedIncome - paidViaSpaceCashExpenses
```

1. **Aportes vs. Outras Receitas:** No modelo atual, toda receita associada a um `spaceId` é interpretada contabilmente como **aporte no caixa do espaço**, creditando o pagador no Livro-Razão. Não há suporte para receitas operacionais que pertençam ao espaço sem ter vindo de um membro específico.
2. **Saídas do Caixa:** A redução do caixa ocorre **exclusivamente** quando uma despesa é salva com `paidByEmail: 'space_cash'` e `status: 'paid'`.
3. **Retiradas/Resgates:** Não existe função de "Sangria de Caixa" ou "Retirada". Para retirar dinheiro do caixa coletivo de volta para uma conta bancária, o usuário teria que simular uma despesa fictícia.

---

## 8. Mapeamento de Telas, Serviços e Tabelas

| Tela / Componente | Arquivo Fonte | Ações Disponíveis | Tabelas/Coleções Afetadas | Serviços Chamados |
| :--- | :--- | :--- | :--- | :--- |
| **SpacesLedgerView** | `src/components/SpacesLedgerView.tsx` | Criar Espaço, Convidar Membro, Excluir Espaço, Alternar Mês, Liquidar Reembolso, Disparar E-mail. | `spaces`, `transactions` | `financeEngine.ts`, `emailService.ts` |
| **UniversalTransactionModal** | `src/components/UniversalTransactionModal.tsx` | Criar despesa/receita, configurar rateio igual ou personalizado, definir pagador (`space_cash` ou membro). | `transactions`, `categories` | `financeEngine.ts`, `emailService.ts` |
| **ConfirmSettlementModal** | `src/components/ConfirmSettlementModal.tsx` | Baixar despesa/receita pendente, validar valor efetivo, escolher se paga via caixa ou membro direto. | `transactions` | `financeEngine.ts` |
| **DashboardView** | `src/components/DashboardView.tsx` | Alternar escopo (Geral, Individual, Espaço), auditar saldos do mês, abrir gaveta de detalhe. | Nenhuma (somente leitura) | `financeEngine.ts` |
| **AccountsCardsView** | `src/components/AccountsCardsView.tsx` | Criar conta/cartão, pagar fatura, ver extrato dinâmico por conta. | `accounts`, `transactions` | `financeEngine.ts` |

### Camadas de Validação (Onde as regras estão garantidas):
* **Frontend (`UniversalTransactionModal.tsx`, `financeEngine.ts`):** 100% dos cálculos de divisão, projeção de fatura de cartão de crédito e geração de séries recorrentes estão implementados exclusivamente no código TypeScript do cliente React.
* **Backend / Banco de Dados (`Firestore`):** Opera como armazenamento de documentos brutos. Não existem *Cloud Functions* ou gatilhos de banco recalculando saldos; se o frontend não calcular a transação de acerto, o banco não a deduz por conta própria.

---

## 9. Problemas, Limitações e Riscos Encontrados

Após inspecionar o código linha a linha, identificamos os seguintes pontos críticos:

### 9.1. Problemas e Inconsistências Efetivamente Confirmados no Código
1. **Descarte da Conta Pagadora no Pagamento de Cartão (`src/App.tsx` linha 832):**
   * O método `handlePayInvoice` recebe o argumento `_sourceCheckingId`, mas o prefixo `_` comprova que a variável é descartada.
   * **Consequência:** Ao "Pagar Fatura", o sistema marca os itens do cartão como pagos, mas **não retira o dinheiro da conta corrente informada**. O saldo da conta corrente não é debitado e nenhuma transação de liquidação de fatura é gerada.
2. **Impossibilidade de Pagamento Parcial (`ConfirmSettlementModal.tsx` linha 93):**
   * Ao confirmar um pagamento de despesa com valor diferente do original, o sistema substitui o campo `amount` bruto. Não há controle de saldo remanescente.
3. **Isolamento entre Aquisições e Finanças (`src/components/acquisitions/`):**
   * O módulo de Listas de Compras compartilha apenas o `workspaceId` e o `monthlyBudget` com o Espaço. A compra de itens da lista **não gera despesa financeira automaticamente** no Livro-Razão do Espaço.

### 9.2. Limitações da Implementação Atual
1. **Falta de Acúmulo de Saldo entre Meses (Carry-Over):**
   * Se Mariana ficou devendo R$ 150,00 em Novembro e ninguém clicou em "Registrar Reembolso", ao virar para Dezembro o Livro-Razão de Dezembro começa com **R$ 0,00**. As dívidas passadas não transitam automaticamente para o novo mês.
2. **Descolamento na Visão "Individual" do Dashboard:**
   * Uma despesa compartilhada que saiu integralmente da conta do usuário é excluída da aba "Individual" do Dashboard, criando a impressão visual de que aquele dinheiro não saiu de sua custódia até que ele consulte a aba "Contas & Cartões".
3. **Teto de 12 Meses para Recorrências:**
   * Despesas fixas criam exatamente 12 instâncias no momento do cadastro. Não há rotina agendada para continuar gerando parcelas no 13º mês em diante.

### 9.3. Riscos Potenciais
1. **Acerto de Contas como Transação Sintética:**
   * A liquidação gera uma transação cujo descritivo precisa começar estritamente com `"Reembolso Livro-Razão:"`. Se um usuário alterar essa descrição na edição, o motor deixará de reconhecê-la como transferência e passará a tratá-la como uma despesa de consumo comum, duplicando os gastos do Espaço.
2. **Dependência de E-mail como Chave Primária nos Splits:**
   * Os participantes são identificados pelo campo `email` em minúsculo. Se um participante alterar seu e-mail de cadastro, o histórico anterior de cotas e saldos daquele espaço deixa de ser correlacionado com o novo e-mail.

---

## 10. Conclusão da Lógica Atual em Linguagem Simples

Atualmente, o **Espaço Compartilhado** funciona como uma **calculadora de compensação mensal em tempo real**.

Quando um participante cadastra uma despesa no Espaço:
1. O valor integral da despesa é descontado do saldo bancário/cartão do criador (no extrato de Contas).
2. O sistema fatia a despesa em cotas gravadas dentro da própria transação.
3. O Livro-Razão do Espaço soma todas as cotas que cada membro deveria pagar e subtrai o que cada membro efetivamente desembolsou naquele mês.
4. Se alguém desembolsou mais do que consumiu, fica com saldo positivo (a receber). Se consumiu mais do que desembolsou, fica com saldo negativo (a pagar).
5. O sistema pode liquidar as dívidas por duas vias:
   * **Via Fundo Comum:** Membros colocam dinheiro no "Caixa" e as contas são pagas diretamente por esse fundo virtual.
   * **Via Reembolso Direto:** O devedor transfere para o credor e o sistema cria um registro com o rótulo de acerto que anula a diferença matemática do mês.

Todo o cálculo é efetuado dinamicamente no frontend a cada renderização, tendo como fronteira rígida o mês selecionado (`invoiceMonth`).
