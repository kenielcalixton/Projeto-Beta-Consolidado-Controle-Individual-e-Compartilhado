export type AccountType = 'checking' | 'credit';

export interface Account {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  balance: number; // Saldo inicial ou atual para conta corrente
  limit: number; // Limite total para cartão de crédito
  closingDay: number; // Dia de fechamento (1-31)
  dueDay: number; // Dia de vencimento (1-31)
  color: string;
  icon: string;
  createdAt?: any;
}

export type CategoryType = 'income' | 'expense' | 'both';

export interface Category {
  id: string;
  userId: string;
  name: string;
  type: CategoryType;
  icon: string;
  color: string;
  createdAt?: any;
}

export interface SpaceParticipant {
  email: string;
  name: string;
  status: 'active' | 'invited';
}

export type SpaceModule = 'finance' | 'acquisitions';

export interface Space {
  id: string;
  ownerId: string;
  ownerEmail: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  participantEmails: string[];
  participants: SpaceParticipant[];
  /** Módulos ativos no espaço: 'finance', 'acquisitions' ou ambos */
  enabledModules?: SpaceModule[];
  /** Orçamento mensal de compras (R$) quando o módulo de aquisições está ativo */
  monthlyBudget?: number;
  createdAt?: any;
}

export type TransactionType = 'income' | 'expense';
export type TransactionStatus = 'paid' | 'pending' | 'overdue' | 'validating' | 'rejected';
export type RecurrenceType = 'single' | 'fixed' | 'installment';

export interface SplitShare {
  email: string;
  name: string;
  responsibility: number; // Quanto esta pessoa deve arcar na despesa
  paidAmount: number; // Quanto esta pessoa efetivamente desembolsou no pagamento
  status: 'accepted' | 'pending' | 'rejected' | 'disputed';
  proposedAmount?: number;
  note?: string;
}

export interface Transaction {
  id: string;
  userId: string;
  ownerEmail: string;
  ownerName: string;
  description: string;
  amount: number;
  type: TransactionType;
  status: TransactionStatus;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  accountId: string;
  accountName: string;
  accountType: AccountType;
  competenceDate: string; // YYYY-MM-DD (Data da compra / competência)
  dueDate: string; // YYYY-MM-DD (Data de vencimento / caixa)
  paymentDate?: string; // YYYY-MM-DD (Data de pagamento efetivo quando status === 'paid')
  invoiceMonth: string; // YYYY-MM (Mês de referência da fatura ou competência)
  recurrenceType: RecurrenceType;
  recurrenceGroupId: string;
  installmentIndex: number;
  installmentTotal: number;
  spaceId: string; // '' para lançamento individual
  spaceName: string;
  paidByEmail: string; // Em despesas: quem pagou ('space_cash' se pago pelo caixa do espaço ou '' se a pagar). Em receitas do espaço: quem enviou o aporte.
  recipientEmail?: string; // Em receitas do espaço: quem recebe no caixa e confirma a efetivação
  participantEmails: string[];
  splits: SplitShare[];
  disputeReason: string;
  proposedAmount: number;
  createdAt?: any;
  updatedAt?: any;
}

export type CascadeMode = 'only_this' | 'this_and_following' | 'all';

export interface LedgerParticipantSummary {
  email: string;
  name: string;
  totalResponsibility: number; // Cota de despesas no mês
  responsibilityPercent: number; // % da cota sobre as despesas totais do mês
  directExpensePaid: number; // Despesas do espaço pagas diretamente do bolso no mês
  incomeContributed: number; // Receitas/aportes efetivados enviados ao espaço no mês
  pendingIncomeContributed: number; // Receitas/aportes agendados aguardando confirmação
  totalPaid: number; // directExpensePaid + incomeContributed
  coveragePercent: number; // % das despesas totais do mês que esta pessoa já cobriu
  netBalance: number; // totalPaid - totalResponsibility (>0 cobriu a mais/a receber, <0 falta pagar/enviar)
}

export interface SettlementTransfer {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  toName: string;
  amount: number;
}

export const ADMIN_UID = 'GOgPDiSr6UP3VGR0zRcdFlgDseY2';

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  createdAt?: any;
}

export interface AdminUserSummary {
  uid: string;
  name: string;
  email: string;
  createdAtIso: string;
  createdAtFormatted: string;
  isAdminUser: boolean;
  accountsCount: number;
  categoriesCount: number;
  spacesCount: number;
  transactionsCount: number;
  totalRecords: number;
  totalIncome: number;
  totalExpenses: number;
  accounts: Account[];
  categories: Category[];
  spaces: Space[];
  transactions: Transaction[];
}

