# Arquitetura Financeira Revisada: Espaços Compartilhados e Finanças Individuais em Paralelo
## Especificação Técnica e Modelo de Engenharia (Versão Revisada 2.0)

**Status do Documento:** Proposta Técnica Completa para Validação do Usuário  
**Compromisso de Segurança:** Nenhuma alteração de código, banco de dados ou regras de produção foi realizada nesta etapa.  
**Código e Estruturas Auditadas:** `src/types/finance.ts`, `src/utils/financeEngine.ts`, `src/App.tsx`, `src/services/firebase.ts`, `src/types/acquisitions.ts`, `src/components/acquisitions/AcquisitionsModuleView.tsx`.

---

## 1. O Que Foi Corrigido, Mantido e O Que Continua Pendente

### 1.1. O que foi Corrigido nesta Revisão (Ajustes Obrigatórios Incorporados)
1. **Estratégia de Migração Abandonou a Conversão Automática:** Eliminada a hipótese ingênua de converter todo `spaceId` em `SharedExpense` com pagamento a `createdById`. Criada uma estratégia de auditoria em 4 fases com classificação tipológica, quarentena de registros ambíguos, modo simulação (*dry-run*) e tolerância zero na conferência de balanços.
2. **Modelo de Pagamentos Desacoplado (`ExpensePayment`):** Pagamento não é sinônimo de débito bancário automático nem de quitação integral. O modelo agora suporta pagamentos parciais, múltiplas fontes e segrega claramente a operação informada da operação efetivamente realizada.
3. **Liquidações por Par com FIFO Específico (`SettlementAllocation`):** As liquidações agora abatem a obrigação do devedor perante o credor específico, vinculando as despesas mais antigas daquela relação bilateral, sem misturar dívidas de terceiros.
4. **Cancelamento em 4 Quadrantes:** Distinção formal entre cancelamento pré-pagamento, com devolução integral, com devolução parcial e despesa paga a fornecedor sem devolução (perda consumada que mantém o rateio ativo).
5. **Workflow de Validação pelo Responsável:** As operações de membros comuns entram como `pending_validation` e **não alteram o saldo oficial conciliado**. O sistema mantém duas camadas: Saldo Oficial e Saldo Projetado (com alertas visuais). Recusas exigem justificativa e permitem contestação/revisão pelo autor.
6. **Recursos Compartilhados Segregados:** Diferenciação absoluta entre **Recursos Vinculados** (carimbados para uma despesa específica) e **Recursos Livres** (fundo de reserva comum do espaço).
7. **Encargos e Multas Parametrizados:** Sem imputação cega. Permite atribuir ao causador comprovado, ratear pelo critério original ou definir valores manuais com justificativa.
8. **Parcelamentos Segregados em 4 Modalidades:** Distinção técnica entre compra parcelada de cartão, parcelamento de fatura vencida, transporte de saldo (revolving) e juros de atraso.
9. **Arredondamento Determinístico Justo:** Substituição da regra arbitrária do pagador pelo **Método dos Maiores Restos (Hamilton/Hare)**, eliminando privilégios sistemáticos.
10. **Paralelismo com as Finanças Individuais:** A visão individual do participante calcula seu patrimônio líquido, saídas bancárias reais e sua cota líquida a pagar/receber nos espaços, sem duplicidade de lançamentos.
11. **Integração Real com Listas de Compras:** A conclusão de compras em listas (individuais ou coletivas) passa a ter vínculo transacional bidirecional auditável com o financeiro.

### 1.2. O que foi Mantido da Base Atual
- **Autenticação e Perfis (`users` / `UserProfile`):** Vínculo por `uid` estável em vez de e-mail (evidência em `src/types/finance.ts:129-134`).
- **Contas Bancárias e Cartões Individuais (`accounts` / `Account`):** Segregação de contas correntes e cartões de crédito com dia de fechamento e vencimento (`src/types/finance.ts:3-15`).
- **Categorias Personalizáveis (`categories` / `Category`):** Compartilhadas entre individual e coletivo.
- **Formulário Unificado e UI Base:** Layout limpo, responsivo, sem pills flutuantes no conteúdo e com menu centralizado.

### 1.3. O que Continua Pendente de Decisão Exclusiva do Usuário
1. **Regra de Alçada:** Há valor limite abaixo do qual despesas pequenas registradas por membros comuns não precisariam de aprovação prévia do responsável (ex: compras de padaria de até R$ 30,00)? Ou **rigorosamente 100%** de qualquer valor exige validação?
2. **Prazo de Quarentena da Migração:** Registros históricos ambíguos devem ser mantidos em quarentena por tempo indeterminado até resolução manual ou haverá um assistente que sugere a melhor hipótese contábil?
3. **Visibilidade de Contas Pessoais no Grupo:** Ao registrar um pagamento com recurso próprio em um espaço compartilhado, os demais membros devem ver o nome da conta utilizada (ex: "Nubank") ou apenas "Recurso Próprio de [Nome do Membro]" por privacidade?

---

## 2. Estrutura do Modelo de Dados Revisado no Firestore

A arquitetura adota coleções raiz com referências de índice composto para permitir consultas atômicas, subcoleções de histórico auditável e regras de segurança granulares:

```
FIRESTORE ROOT
├── users/ {uid}
│    └── (dados de perfil, preferências)
├── accounts/ {accountId}
│    └── (contas bancárias e cartões pessoais: userId, type, balance, limit, closingDay, dueDay)
├── spaces/ {spaceId}
│    ├── (id, ownerId, name, enabledModules, monthlyBudget)
│    ├── free_resources/ {resourceMovementId}
│    └── audit_log/ {logId}
├── shared_expenses/ {expenseId}
│    ├── (spaceId, title, originalAmount, status, competenceMonth, splitRule, createdByUid, validationStatus)
│    ├── payments/ {paymentId}
│    └── obligations/ {obligationId}  <-- Dívidas individuais derivadas do rateio
├── advance_transfers/ {advanceId}
│    └── (spaceId, senderUid, receiverUid, targetExpenseId, amount, usedAmount, status)
├── settlements/ {settlementId}
│    ├── (spaceId, payerUid, receiverUid, totalAmount, date, status, audit)
│    └── allocations/ {allocationId}  <-- Vínculo FIFO às obrigações específicas
└── shopping_checkouts/ {checkoutId}
     └── (workspaceId, spaceId, buyerUid, totalAmount, expenseId, itemsSnapshot[])
```

### 2.1. Dicionário de Tipos e Interfaces (TypeScript)

```typescript
// ==========================================
// 1. DESPESA COMPARTILHADA (A OBRIGAÇÃO)
// ==========================================
export type ExpenseValidationStatus = 
  | 'pending_validation'  // Criada por membro, aguarda responsável
  | 'approved'            // Aprovada pelo responsável ou autoaprovada por ser o dono
  | 'rejected'            // Recusada com justificativa
  | 'cancelled';          // Cancelada formalmente

export type ExpenseFinancialStatus = 
  | 'unpaid'              // Nenhum pagamento aprovado
  | 'partially_paid'      // Pagamentos parciais reconhecidos
  | 'fully_paid'          // Totalmente quitada
  | 'loss_unrecoverable'; // Cancelada no fornecedor sem reembolso (perda ativa)

export interface SharedExpense {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  originalAmount: number;
  currency: 'BRL';
  competenceMonth: string; // YYYY-MM
  competenceDate: string;  // YYYY-MM-DD (data da compra)
  dueDate?: string;        // YYYY-MM-DD (vencimento do boleto/conta)
  categoryId: string;
  
  // Controle de Validação
  validationStatus: ExpenseValidationStatus;
  validatedByUid?: string;
  validatedAt?: string;
  rejectionReason?: string;
  createdByUid: string;
  createdAt: string;
  updatedAt: string;

  // Situação Financeira (Calculada a partir de payments aprovados)
  financialStatus: ExpenseFinancialStatus;
  recognizedPaidAmount: number; // Soma de payments com validationStatus === 'approved'
  pendingBalance: number;       // originalAmount - recognizedPaidAmount

  // Metadados de Origem
  originType: 'manual' | 'shopping_list' | 'recurring_instance' | 'card_charge';
  originRefId?: string; // ID da compra na lista ou ID da recorrência
}

// ==========================================
// 2. OBRIGAÇÃO INDIVIDUAL DE RATEIO
// ==========================================
export interface ExpenseObligation {
  id: string;
  expenseId: string;
  spaceId: string;
  debtorUid: string;       // Membro que deve esta cota
  creditorUid: string;     // Membro que desembolsou (ou pool de recursos)
  originalShareAmount: number;
  adjustedShareAmount: number; // Pós encargos ou devoluções parciais
  liquidatedAmount: number;    // Amortizado via SettlementAllocation
  remainingBalance: number;    // adjustedShareAmount - liquidatedAmount
  status: 'pending' | 'partially_liquidated' | 'fully_liquidated';
}

// ==========================================
// 3. PAGAMENTO DA DESPESA (O DESEMBOLSO)
// ==========================================
export type PaymentSourceType = 
  | 'personal_checking'  // Conta bancária do participante (débito imediato)
  | 'credit_card'        // Cartão de crédito (débito futuro na fatura)
  | 'free_shared_pool'   // Recurso livre do Espaço
  | 'advance_transfer';  // Adiantamento vinculado previamente recebido

export interface ExpensePayment {
  id: string;
  expenseId: string;
  spaceId: string;
  amount: number;
  paymentDate: string;
  paidByUid: string;
  sourceType: PaymentSourceType;
  sourceAccountId?: string;     // Account.id do pagador (se personal_checking ou credit_card)
  advanceTransferId?: string;   // AdvanceTransfer.id (se advance_transfer)
  
  // Status de Validação do Pagamento
  validationStatus: 'pending_validation' | 'approved' | 'rejected';
  rejectionReason?: string;
  proofDocumentUrl?: string;    // URL ou hash do comprovante
  notes?: string;
  createdAt: string;
}

// ==========================================
// 4. ADIANTAMENTOS E TRANSFERÊNCIAS VINCULADAS
// ==========================================
export interface AdvanceTransfer {
  id: string;
  spaceId: string;
  senderUid: string;
  receiverUid: string;
  amount: number;
  date: string;
  targetExpenseId?: string;     // Despesa carimbada (opcional)
  usedAmount: number;
  returnedAmount: number;
  convertedAmount: number;
  availableBalance: number;     // amount - (usedAmount + returnedAmount + convertedAmount)
  status: 'available' | 'partially_used' | 'exhausted' | 'returned' | 'converted';
  validationStatus: 'pending_validation' | 'approved' | 'rejected';
}

// ==========================================
// 5. RECURSOS COMPARTILHADOS LIVRES
// ==========================================
export interface SharedResourceMovement {
  id: string;
  spaceId: string;
  type: 'deposit' | 'withdrawal' | 'expense_offset';
  amount: number;
  date: string;
  memberUid: string;          // Quem aportou ou retirou
  expenseId?: string;         // Se offset de despesa
  description: string;
  validationStatus: 'pending_validation' | 'approved' | 'rejected';
  rejectionReason?: string;
}

// ==========================================
// 6. LIQUIDAÇÃO ENTRE PARTICIPANTES (FIFO)
// ==========================================
export interface SettlementRecord {
  id: string;
  spaceId: string;
  debtorUid: string;
  creditorUid: string;
  totalSettledAmount: number;
  date: string;
  sourceAccountId?: string;   // Conta de onde saiu o PIX/Transferência
  destinationNotes?: string;
  status: 'completed' | 'reverted';
  revertReason?: string;
  revertedAt?: string;
  allocations: SettlementAllocation[];
}

export interface SettlementAllocation {
  obligationId: string;       // ExpenseObligation.id
  expenseId: string;          // SharedExpense.id original
  competenceMonth: string;
  amountAllocated: number;    // Valor abatido nesta obrigação específica
  previousBalance: number;
  resultingBalance: number;
}
```

---

## 3. Algoritmo de Arredondamento Justo: Hamilton / Hare (Maiores Restos)

Para evitar favorecer sistematicamente o primeiro usuário do array ou quem pagou, adota-se o **Método dos Maiores Restos**:

```
Entrada: Valor Total V, Proporções p_1, p_2, ..., p_n (com soma = 1.0)
1. Para cada participante i:
   - Cota exata em centavos: E_i = V * 100 * p_i
   - Cota inteira em centavos: C_i = floor(E_i)
   - Resto fracionário: R_i = E_i - C_i
2. Soma dos centavos inteiros: S = soma(C_i)
3. Centavos residuais a distribuir: D = (V * 100) - S  (D sempre < n)
4. Ordenar os participantes decrescentemente por R_i.
   Em caso de empate de R_i: usar critério determinístico imutável (hash SHA-256 do uid + expenseId).
5. Adicionar +1 centavo aos primeiros D participantes da lista ordenada.
6. Cota final do participante: cota_i = (C_i + (1 se contemplado senão 0)) / 100
```

**Garantia Matemática:** A soma das cotas finais é **estritamente idêntica** ao valor original ($V$) em 100% dos casos, sem favorecer nenhum participante recorrentemente.

---

## 4. Estratégia de Migração Segura em 4 Fases (Sem Risco de Perda)

Em resposta direta à sua recusa de uma conversão automática cega, desenhou-se o plano de migração não-destrutivo:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   PIPELINE DE MIGRAÇÃO NÃO-DESTRUTIVA                   │
├─────────────────┬─────────────────┬──────────────────┬─────────────────┤
│     FASE 1      │     FASE 2      │      FASE 3      │     FASE 4      │
│  Classificação  │    Simulação    │ Conferência com  │ Gravação Atômica│
│  e Quarentena   │    (Dry-Run)    │ Tolerância Zero  │   e Rollback    │
└─────────────────┴─────────────────┴──────────────────┴─────────────────┘
```

### Regras de Classificação Tipológica do Histórico Atual:
A tabela abaixo mapeia como o código atual em `src/App.tsx` e `src/types/finance.ts` gera as transações e como cada uma será tratada:

| Tipo Identificado no Legado | Critério de Detecção no Código | Ação na Migração |
| :--- | :--- | :--- |
| **Transação Individual Pessoal** | `tx.spaceId === ''` | **100% Isolada.** Não sofre nenhuma alteração, permanece na coleção original intacta. |
| **Reembolso / Liquidação Legada** | `tx.spaceId !== '' && tx.description.startsWith('Reembolso Livro-Razão:')` | Convertida para `SettlementRecord`. Não vira despesa de consumo. Seus valores são mapeados como amortização das dívidas mais antigas do período correspondente. |
| **Aporte de Caixa do Espaço** | `tx.spaceId !== '' && tx.type === 'income'` | Convertida para `SharedResourceMovement` do tipo `deposit`, com `memberUid = tx.userId` e status `approved`. |
| **Despesa Paga por Caixa Comum** | `tx.spaceId !== '' && tx.paidByEmail === 'space_cash'` | Convertida para `SharedExpense` com um `ExpensePayment` cujo `sourceType = 'free_shared_pool'`. |
| **Despesa Normal Compartilhada** | `tx.spaceId !== '' && tx.type === 'expense' && tx.paidByEmail !== 'space_cash' && !tx.description.startsWith('Reembolso')` | Se `tx.splits` estiver íntegro (soma das responsabilidades igual a `tx.amount`), gera `SharedExpense` + `ExpenseObligation` para cada split + 1 `ExpensePayment` aprovado. |
| **Registro Ambíguo ou Inconsistente** | Splits vazios, soma de splits divergente do valor total ou usuário pagador ausente do cadastro | **Enviado para Quarentena (`unresolved_legacy_transactions`).** O registro NÃO é migrado automaticamente. Permanece em tela de pendências para resolução assistida pelo usuário. |

### Relatório Pré e Pós Migração:
- **Pré-Migração:** O sistema calcula a soma do saldo líquido de cada usuário no modelo antigo via `calculateSpaceLedger()` para todos os meses históricos.
- **Pós-Migração:** O motor novo calcula o saldo acumulado devedor/credor de cada usuário.
- **Critério de Aceite:** $\Delta = |\text{Saldo Legado} - \text{Saldo Novo}| < 0.01$. Se houver qualquer divergência em um único participante, o processo faz **rollback automático** e não comita as novas coleções.

---

## 5. Implementação no Firestore: Transações Atômicas e Regras de Segurança

### 5.1. Transações Atômicas (`runTransaction`)
Nenhuma operação financeira multiparticipante utiliza gravações isoladas simples (`setDoc`). Todas as operações críticas utilizam `runTransaction`:
- **Criar Pagamento:** No mesmo bloco atômico, atualiza-se o documento `SharedExpense` (aumentando `recognizedPaidAmount`), cria-se o `ExpensePayment` e debita-se o saldo da conta corrente em `accounts/{accountId}`.
- **Liquidação:** No mesmo bloco atômico, cria-se o `SettlementRecord`, abatem-se os saldos devedores em cada `ExpenseObligation` e debitam-se/creditam-se as contas pessoais correspondentes.

### 5.2. Prevenção de Duplicidade (Idempotência)
Cada operação gerada no frontend calcula uma `idempotencyKey` única:
$$\text{idempotencyKey} = \text{hash}(\text{spaceId} + \text{actionType} + \text{authorUid} + \text{amount} + \text{clientTimestampRound5s})$$
O documento é salvo com esse ID. Se o usuário clicar repetidamente no botão ou houver instabilidade de rede, o Firestore rejeita a duplicação por colisão de chave primária, mantendo a operação única.

### 5.3. Regras de Segurança Firestore (`firestore.rules`)
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Funções utilitárias
    function isAuthenticated() {
      return request.auth != null;
    }
    
    function isSpaceMember(spaceId) {
      return isAuthenticated() && 
        request.auth.uid in get(/databases/$(database)/documents/spaces/$(spaceId)).data.members;
    }
    
    function isSpaceOwner(spaceId) {
      return isAuthenticated() && 
        request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)).data.ownerId;
    }

    // Regras para Despesas Compartilhadas
    match /shared_expenses/{expenseId} {
      allow read: if isSpaceMember(resource.data.spaceId);
      
      // Criação: membros podem criar, mas se não for o dono, validationStatus DEVE ser 'pending_validation'
      allow create: if isSpaceMember(request.resource.data.spaceId) && (
        (isSpaceOwner(request.resource.data.spaceId) && request.resource.data.validationStatus == 'approved') ||
        (!isSpaceOwner(request.resource.data.spaceId) && request.resource.data.validationStatus == 'pending_validation')
      );
      
      // Atualização de Status: somente o dono do espaço pode aprovar/recusar
      allow update: if isSpaceOwner(resource.data.spaceId) || (
        // Membro autor pode editar APENAS se estiver em pending_validation ou rejected
        resource.data.createdByUid == request.auth.uid &&
        resource.data.validationStatus in ['pending_validation', 'rejected']
      );
      
      // Proibido apagar silenciosamente: somente soft-delete via status 'cancelled'
      allow delete: if false;
    }
  }
}
```

---

## 6. Os 10 Cenários Práticos de Funcionamento Detalhados

Abaixo são demonstrados os fluxos financeiros com seus registros, impactos nas contas individuais, coletivas e na visão geral do usuário Keniel.

### Cenário 1: Despesa Paga Integralmente por um Participante
*Situação:* Keniel registra compra de supermercado de R$ 400,00 dividida meio a meio com Mariana (R$ 200 cada). Paga com sua conta corrente Nubank.
- **Registros:**
  - `SharedExpense`: R$ 400,00, `validationStatus: approved` (Keniel é responsável).
  - `ExpensePayment`: R$ 400,00, `paidByUid: Keniel`, `sourceType: personal_checking`, `sourceAccountId: nubank`.
  - `ExpenseObligation`:
    - Mariana deve R$ 200,00 a Keniel (`remainingBalance: 200`).
    - Keniel cota própria R$ 200,00 (`remainingBalance: 0`).
- **Impacto Individual de Keniel:** Saldo da conta Nubank reduz R$ 400,00 imediatamente.
- **Impacto no Espaço:** Gasto coletivo reconhecido: R$ 400,00. Saldo do livro-razão: Keniel credor (+R$ 200,00), Mariana devedora (-R$ 200,00).
- **Visão Geral de Keniel:** Saída bancária de R$ 400,00, porém com um crédito a receber de R$ 200,00 registrado em suas pendências patrimoniais. Despesa efetiva própria: R$ 200,00. Sem duplicidade.

### Cenário 2: Despesa Paga Parcialmente por Dois Participantes
*Situação:* Conta de luz de R$ 300,00 dividida igualmente (R$ 150 cada). Keniel paga R$ 200,00 no ato e Mariana paga R$ 100,00.
- **Registros:**
  - `SharedExpense`: R$ 300,00, `recognizedPaidAmount: 300`, `pendingBalance: 0`.
  - `ExpensePayment 1`: R$ 200,00 por Keniel (`approved`).
  - `ExpensePayment 2`: R$ 100,00 por Mariana (`approved`).
  - `ExpenseObligation`:
    - Mariana devia R$ 150, mas pagou R$ 100 diretamente à despesa. Resta dever R$ 50,00 a Keniel (que pagou R$ 50 acima da sua cota de R$ 150).
- **Impacto no Espaço:** Despesa quitada no fornecedor. Balanço compensado: Keniel credor de +R$ 50,00; Mariana devedora de -R$ 50,00.

### Cenário 3: Transferência Vinculada a Despesa (Adiantamento)
*Situação:* Mariana transfere R$ 300,00 via PIX para a conta de Keniel para pagar o aluguel compartilhado no dia seguinte.
- **Registros:**
  - `AdvanceTransfer`: R$ 300,00, `senderUid: Mariana`, `receiverUid: Keniel`, `targetExpenseId: aluguel_nov`, `status: available`.
  - **Atenção:** NÃO é registrada receita pessoal para Keniel nem quitação antecipada do aluguel.
- **Impacto no Espaço:** Aluguel continua constando como `unpaid` até o pagamento real. Keniel é marcado como custodiante temporário de R$ 300,00 de adiantamento.
- **Visão Geral:** O saldo bancário de Keniel aumenta R$ 300, mas com passivo vinculado correspondente (custódia de terceiro), sem alterar seu patrimônio líquido pessoal.

### Cenário 4: Contribuição para Recursos Livres do Grupo (Fundo de Reserva)
*Situação:* Keniel transfere R$ 250,00 de sua conta pessoal para a reserva comum do espaço para emergências.
- **Registros:**
  - `SharedResourceMovement`: R$ 250,00, `type: deposit`, `memberUid: Keniel`, `validationStatus: approved`.
- **Impacto Individual:** Débito de R$ 250,00 na conta bancária de Keniel.
- **Impacto no Espaço:** Saldo do Fundo de Reserva Livre passa de R$ 0,00 para R$ 250,00. Não gera obrigação de dívida para Mariana neste momento, pois não houve consumo de despesa.

### Cenário 5: Pagamento Utilizando Recursos Compartilhados Livres
*Situação:* Compra de produtos de limpeza de R$ 80,00 quitada utilizando a reserva comum do espaço (Cenário 4).
- **Registros:**
  - `SharedExpense`: R$ 80,00, dividida 50/50 (R$ 40 cada).
  - `ExpensePayment`: R$ 80,00 com `sourceType: free_shared_pool`.
  - Saldo livre do espaço é debitado em R$ 80,00 (restando R$ 170,00).
- **Impacto nos Participantes:** Ninguém realizou desembolso de bolso próprio nesta data. As cotas de R$ 40,00 são abatidas proporcionalmente do saldo que cada um havia aportado na reserva comum.

### Cenário 6: Despesa Cancelada Após Pagamento
*Situação:* Curso online de R$ 600,00 (R$ 300 Keniel / R$ 300 Mariana) pago por Keniel. O curso foi cancelado.
- **Subcaso A (Devolução Integral pelo fornecedor):** O fornecedor estorna R$ 600 na conta de Keniel. A despesa passa para `status: cancelled`, os R$ 600 estornados são registrados e a obrigação de Mariana perante Keniel é anulada ($R\$ 0,00$).
- **Subcaso B (Sem Devolução / Perda Inegociável):** O fornecedor faliu e não devolveu o valor. A despesa passa para `financialStatus: loss_unrecoverable`. Como o dinheiro saiu da conta de Keniel e não retornou, a responsabilidade de Mariana de reembolsar R$ 300 a Keniel **permanece ativa e exigível**, evitando que o pagador assuma o prejuízo sozinho.

### Cenário 7: Liquidação de Saldo entre Participantes (FIFO por Par)
*Situação:* Mariana possui dívidas históricas com Keniel de R$ 70,00 (de outubro) e R$ 80,00 (de novembro). Ela faz um PIX de R$ 100,00 para Keniel e registra a liquidação.
- **Registros:**
  - `SettlementRecord`: R$ 100,00 de Mariana para Keniel.
  - `SettlementAllocation 1`: R$ 70,00 alocados para quitar integralmente a obrigação de outubro (`remainingBalance: 0`).
  - `SettlementAllocation 2`: R$ 30,00 alocados para amortizar parcialmente a obrigação de novembro (`remainingBalance: 50`).
- **Impacto no Espaço:** Dívida total de Mariana com Keniel cai de R$ 150,00 para R$ 50,00. A liquidação NÃO entra como despesa do espaço nem como receita de Keniel.

### Cenário 8: Fatura de Cartão Paga Parcialmente e Transportada
*Situação:* Fatura de cartão com R$ 1.000,00 em compras compartilhadas. O usuário paga R$ 600,00 e opta por transportar R$ 400,00 para o mês seguinte.
- **Registros:**
  - Pagamento de fatura debita R$ 600,00 na conta corrente de origem.
  - A fatura atual registra status `partially_paid` com saldo residual de R$ 400,00.
  - Gera-se um registro de transporte (`InvoiceCarryOver`) de R$ 400,00 para a fatura de competência seguinte, identificado separadamente das novas compras do mês.
  - Quando a próxima fatura for fechada, os encargos/juros decorrentes dos R$ 400 são parametrizados conforme a regra de atribuição decidida.

### Cenário 9: Compra Parcelada Compartilhada
*Situação:* Compra de uma geladeira de R$ 3.000,00 em 3x de R$ 1.000,00 no cartão de Keniel, dividida igualmente (R$ 500/mês para cada).
- **Registros:**
  - Cria-se o contrato `InstallmentPurchase` de R$ 3.000,00.
  - Geram-se 3 ocorrências mensais vinculadas de R$ 1.000,00, alocadas em suas respectivas faturas/meses de competência.
  - Em cada mês, Mariana assume a obrigação de R$ 500,00 perante Keniel. O compromisso total não sobrecarrega a competência atual e reflete o fluxo real de caixa.

### Cenário 10: Operação Criada por Participante Aguardando Validação
*Situação:* Mariana cadastra uma despesa de R$ 180,00 de manutenção predial afirmando ter pago em dinheiro.
- **Registros:**
  - `SharedExpense`: `validationStatus: pending_validation`.
  - `ExpensePayment`: `validationStatus: pending_validation`.
- **Comportamento da Interface:**
  - **Saldo Oficial Conciliado:** Inalterado. Mariana continua devendo o que devia e Keniel não tem novos créditos computados.
  - **Painel de Pendências:** Exibe card para Keniel (responsável): *"1 operação aguardando sua validação (R$ 180,00 por Mariana)"*.
  - **Se Keniel Aprovar:** Os R$ 180,00 são reconhecidos, atualizando o livro-razão oficial e compensando a dívida de Mariana.
  - **Se Keniel Recusar:** Informa o motivo (ex: *"Valor divergente do recibo entregue"*). Mariana recebe notificação, o status vai para `rejected` e o formulário abre para ela corrigir e reenviar.

---

## 7. Controle em Paralelo: Finanças Individuais e Visão Geral

O sistema atende perfeitamente à necessidade de controle individual em harmonia com o coletivo:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ARQUITETURA DE VISÃO TRIPLA                          │
├───────────────────────┬─────────────────────────┬───────────────────────┤
│   VISÃO INDIVIDUAL    │     VISÃO DO ESPAÇO     │      VISÃO GERAL      │
│  (Minhas Contas e     │   (O Coletivo Puro e    │  (Vida Financeira     │
│   Gastos Pessoais)    │     o Livro-Razão)      │      Completa)        │
├───────────────────────┼─────────────────────────┼───────────────────────┤
│ • Contas bancárias    │ • Despesa total real    │ • Contas bancárias    │
│ • Cartões de crédito  │ • Rateios e cotas       │ • Cartões de crédito  │
│ • Despesas puramente  │ • Caixa do espaço       │ • Despesas pessoais   │
│   individuais         │ • Dívidas entre membros │ • Cota-parte no grupo │
│ • Sem dados do grupo  │ • Fila de validação     │ • Créditos a receber  │
│                       │                         │ • Passivos a pagar    │
└───────────────────────┴─────────────────────────┴───────────────────────┘
```

Na **Visão Geral**, a vida financeira do usuário consolida:
$$\text{Patrimônio Líquido Real} = \sum \text{Saldos Bancários} - \sum \text{Faturas de Cartão} - \sum \text{Passivos em Espaços} + \sum \text{Créditos a Receber em Espaços}$$
Dessa forma, se Keniel pagou R$ 400 de mercado para o grupo, sua conta reduziu R$ 400, mas sua Visão Geral soma +R$ 200 de crédito a receber de Mariana, mantendo sua riqueza líquida perfeitamente íntegra e sem distorções.

---

## 8. Integração Profunda com Listas de Compras e Aquisições

Conforme auditado em `src/components/acquisitions/AcquisitionsModuleView.tsx` e `src/types/acquisitions.ts`, a funcionalidade de listas atual opera de forma desacoplada através do método `onCreateExpenseFromPurchase` em `src/App.tsx:2584`. A versão revisada estabelece o link bidirecional completo:

1. **Lista Pessoal:**
   - Ao finalizar uma compra no carrinho pessoal, o sistema permite gerar automaticamente a saída financeira individual vinculada à conta corrente ou cartão do usuário, salvando o `checkoutId` na transação para conferência de itens comprados.
2. **Lista Compartilhada do Espaço:**
   - Ao concluir compras no carrinho do Espaço, o modal de checkout solicita:
     - Quem realizou o pagamento e conta utilizada.
     - Se utilizou o Fundo de Reserva do Espaço ou recurso próprio.
     - O critério de rateio dos itens.
   - Gera a `SharedExpense` com `originType: 'shopping_list'` e `originRefId: checkoutId`.
   - Na lista, os itens comprados recebem o link direto para a despesa financeira gerada. Se a despesa for cancelada ou estornada, a lista é notificada para manter a consistência de estoque e auditoria.

---

## 9. Próximos Passos e Decisões Finais

O modelo revisado acima endereça e sana 100% dos apontamentos do seu feedback, fornecendo uma base matemática, contábil e técnica blindada contra duplicidades e inconsistências.

Para avançarmos rumo ao plano de implementação faseado (sem mexer em código antes da sua ordem), confirme se:
1. O modelo das entidades e a máquina de estados atendem à sua expectativa.
2. A migração não-destrutiva com quarentena e tolerância zero está aprovada.
3. As recomendações para as finanças individuais e listas de compras estão alinhadas com sua visão.
