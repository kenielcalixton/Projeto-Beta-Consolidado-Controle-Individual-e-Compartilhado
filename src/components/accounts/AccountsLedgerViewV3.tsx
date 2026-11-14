import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Wallet,
  Building2,
  PiggyBank,
  CreditCard,
  Plus,
  RefreshCw,
  Archive,
  ArchiveRestore,
  BookOpen,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeft,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Calendar,
  X,
  Edit2,
  DollarSign,
  ShieldCheck,
  FileSpreadsheet,
  Search,
  ListFilter,
} from 'lucide-react';
import { Account, FinancialMovement, AccountType } from '../../types/financeV3';
import { UniversalTransactionPreset } from '../../types/finance';
import {
  getUserAccounts,
  createAccount,
  updateAccount,
  archiveAccount,
  archiveAccountSafely,
  CreateAccountInput,
} from '../../services/accountService';
import {
  getAccountMovements,
  getEnrichedLedgerMovements,
  attachChronologicalRunningBalances,
  formatIsoDateBR,
  EnrichedLedgerMovement,
  LedgerScopeType,
  reverseMovement,
  reconcileAndSyncAccountBalance,
} from '../../services/ledgerService';
import {
  calculateCardAvailableLimit,
  getCardInvoices,
} from '../../services/creditCardService';
import { getUserPersonalTransactions } from '../../services/personalTransactionService';
import { getRecurrenceRules } from '../../services/recurrenceService';
import {
  formatCentsToBRL,
  parseBRLToCents,
} from '../../utils/movementLedger';
import { IconGridPicker, ColorPalettePicker } from '../ui/VisualPickers';
import {
  resolveHexColor,
  resolvePhosphorCategoryIcon,
} from '../../utils/visualPickerUtils';
import { CreditCardLedgerModal } from './CreditCardLedgerModal';

interface AccountsLedgerViewV3Props {
  userId: string;
  isDemo?: boolean;
  refreshTrigger?: number;
  onOpenNewTransaction?: (preset?: UniversalTransactionPreset) => void;
}

interface CardLimitInfo {
  creditLimitCents: number;
  usedAmountCents: number;
  availableLimitCents: number;
}

interface AccountObligationScan {
  openTransactionsCount: number;
  activeRecurrenceRulesCount: number;
  unpaidInvoicesBalanceCents: number;
  loading: boolean;
}

export const AccountsLedgerViewV3: React.FC<AccountsLedgerViewV3Props> = ({
  userId,
  isDemo = false,
  refreshTrigger = 0,
  onOpenNewTransaction,
}) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cardLimits, setCardLimits] = useState<Record<string, CardLimitInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Modo de visualização: Contas & Cartões vs Livro-Razão Geral
  const [viewMode, setViewMode] = useState<'accounts' | 'general_ledger'>('accounts');

  // Filtros de Contas
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'archived'>('active');

  // Conta selecionada para visualização do Livro-Razão (Ledger) em modal responsivo (somente contas não-crédito)
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const selectedAccountRef = useRef<Account | null>(null);
  useEffect(() => {
    selectedAccountRef.current = selectedAccount;
  }, [selectedAccount]);
  const [selectedCreditCard, setSelectedCreditCard] = useState<Account | null>(null);
  const [movements, setMovements] = useState<FinancialMovement[]>([]);
  const [loadingMovements, setLoadingMovements] = useState(false);

  // Livro-Razão Geral (Todas as contas bancárias/carteira enriquecidas com saldo resultante)
  const [generalLedgerMovements, setGeneralLedgerMovements] = useState<EnrichedLedgerMovement[]>([]);
  const [loadingGeneralLedger, setLoadingGeneralLedger] = useState(false);
  const [generalLedgerError, setGeneralLedgerError] = useState<string | null>(null);
  const [ledgerPeriodFilter, setLedgerPeriodFilter] = useState<string>('all');
  const [ledgerAccountFilter, setLedgerAccountFilter] = useState<string>('all');
  const [ledgerScopeFilter, setLedgerScopeFilter] = useState<'all' | LedgerScopeType>('all');
  const [ledgerSearch, setLedgerSearch] = useState<string>('');

  // Modais
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [isReversalModalOpen, setIsReversalModalOpen] = useState(false);
  const [movementToReverse, setMovementToReverse] = useState<FinancialMovement | null>(null);

  // Modal guiado de Arquivamento / Encerramento Seguro
  const [archiveTargetAccount, setArchiveTargetAccount] = useState<Account | null>(null);
  const [archiveScan, setArchiveScan] = useState<AccountObligationScan>({
    openTransactionsCount: 0,
    activeRecurrenceRulesCount: 0,
    unpaidInvoicesBalanceCents: 0,
    loading: false,
  });
  const [migrateToAccountId, setMigrateToAccountId] = useState<string>('');
  const [archiveSubmitting, setArchiveSubmitting] = useState(false);

  // Formulário de Conta (incluindo campos de Cartão de Crédito)
  const [accName, setAccName] = useState('');
  const [accType, setAccType] = useState<AccountType>('checking');
  const [accColor, setAccColor] = useState('#2563EB');
  const [accIcon, setAccIcon] = useState('ph-wallet');
  const [accCreditLimitInput, setAccCreditLimitInput] = useState('');
  const [accClosingDay, setAccClosingDay] = useState('20');
  const [accDueDay, setAccDueDay] = useState('27');
  const [accSubmitting, setAccSubmitting] = useState(false);

  // Formulário de Estorno
  const [reversalReason, setReversalReason] = useState('');
  const [reversalSubmitting, setReversalSubmitting] = useState(false);

  // Estado de Reconciliação
  const [reconciling, setReconciling] = useState(false);

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 4500);
  };

  // Trava scroll do body quando qualquer modal estiver aberto
  useEffect(() => {
    const anyModalOpen =
      Boolean(selectedAccount) ||
      Boolean(selectedCreditCard) ||
      isCreateModalOpen ||
      isReversalModalOpen ||
      Boolean(archiveTargetAccount);
    if (!anyModalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [
    selectedAccount,
    selectedCreditCard,
    isCreateModalOpen,
    isReversalModalOpen,
    archiveTargetAccount,
  ]);

  // Carrega contas + resumo de limite dos cartões de crédito
  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getUserAccounts(userId, true, isDemo);
      const validAccounts = (list || []).filter(
        (a): a is Account => !!a && typeof a.id === 'string' && a.id.trim().length > 0
      );
      setAccounts(validAccounts);
      setSelectedAccount((prev) => {
        if (!prev) return null;
        return validAccounts.find((a) => a.id === prev.id) || prev;
      });
      setSelectedCreditCard((prev) => {
        if (!prev) return null;
        return validAccounts.find((a) => a.id === prev.id) || prev;
      });

      const creditAccounts = validAccounts.filter((a) => a.type === 'credit');
      if (creditAccounts.length > 0) {
        const entries = await Promise.all(
          creditAccounts.map(async (card) => {
            try {
              const summary = await calculateCardAvailableLimit(card, userId, isDemo);
              return [card.id, summary] as const;
            } catch {
              return [
                card.id,
                {
                  creditLimitCents: card.creditLimitCents || 0,
                  usedAmountCents: 0,
                  availableLimitCents: card.creditLimitCents || 0,
                },
              ] as const;
            }
          })
        );
        setCardLimits(Object.fromEntries(entries));
      } else {
        setCardLimits({});
      }
      return validAccounts;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar contas';
      setError(message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId, isDemo]);

  // Carrega movimentos ao selecionar uma conta
  const loadMovementsForAccount = useCallback(async (account: Account) => {
    if (!account || !account.id) return;
    setLoadingMovements(true);
    try {
      const movs = await getAccountMovements(account.id, userId, isDemo);
      const validMovs = (movs || []).filter(
        (m): m is FinancialMovement => !!m && typeof m.id === 'string' && m.id.trim().length > 0
      );
      setMovements(validMovs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar movimentos';
      setError(message);
    } finally {
      setLoadingMovements(false);
    }
  }, [userId, isDemo]);

  // Carrega Livro-Razão Geral consolidado de todas as contas bancárias/carteira
  const loadGeneralLedger = useCallback(
    async (accountsList?: Account[]) => {
      const sourceAccounts = accountsList || accounts;
      if (!userId || sourceAccounts.length === 0) {
        setGeneralLedgerMovements([]);
        return;
      }
      setLoadingGeneralLedger(true);
      setGeneralLedgerError(null);
      try {
        const enriched = await getEnrichedLedgerMovements(userId, sourceAccounts, isDemo);
        setGeneralLedgerMovements(enriched);
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : 'Erro ao carregar movimentações do Livro-Razão Geral.';
        setGeneralLedgerError(message);
      } finally {
        setLoadingGeneralLedger(false);
      }
    },
    [userId, accounts, isDemo]
  );

  useEffect(() => {
    loadAccounts().then((loaded) => {
      if (viewMode === 'general_ledger' && loaded.length > 0) {
        loadGeneralLedger(loaded);
      }
    });
    if (selectedAccountRef.current) {
      loadMovementsForAccount(selectedAccountRef.current);
    }
  }, [loadAccounts, loadMovementsForAccount, refreshTrigger]);

  useEffect(() => {
    if (viewMode === 'general_ledger' && accounts.length > 0) {
      loadGeneralLedger(accounts);
    }
  }, [viewMode, accounts, loadGeneralLedger]);

  const handleSelectAccountForLedger = (acc: Account) => {
    setError(null);
    if (acc.type === 'credit') {
      setSelectedAccount(null);
      setSelectedCreditCard(acc);
      return;
    }
    setSelectedCreditCard(null);
    setSelectedAccount(acc);
    loadMovementsForAccount(acc);
  };

  // Reconciliação forçada de saldo
  const handleReconcileBalance = async () => {
    if (!selectedAccount) return;
    setReconciling(true);
    try {
      const res = await reconcileAndSyncAccountBalance(
        selectedAccount.id,
        userId,
        isDemo
      );
      if (res.hasDivergence) {
        showToast(
          `Divergência detectada e corrigida! Ajuste de ${formatCentsToBRL(
            Math.abs(res.differenceCents)
          )}. Saldo Oficial Atualizado: ${formatCentsToBRL(res.reconciledBalanceCents)}`
        );
      } else {
        showToast(
          `Saldo auditado com sucesso! Nenhuma divergência detectada. Saldo Oficial: ${formatCentsToBRL(
            res.reconciledBalanceCents
          )}`
        );
      }
      setSelectedAccount((prev) =>
        prev
          ? {
              ...prev,
              projectedBalanceCents: res.reconciledBalanceCents,
            }
          : null
      );
      await loadAccounts();
      await loadMovementsForAccount(selectedAccount);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Falha na reconciliação';
      setError(message);
    } finally {
      setReconciling(false);
    }
  };

  const resetAccountForm = () => {
    setAccName('');
    setAccType('checking');
    setAccColor('#2563EB');
    setAccIcon('ph-wallet');
    setAccCreditLimitInput('');
    setAccClosingDay('20');
    setAccDueDay('27');
    setModalError(null);
  };

  // Salvar nova conta ou atualizar conta existente
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    if (!accName.trim()) {
      setModalError('O nome da conta é obrigatório.');
      return;
    }

    let creditLimitCents: number | undefined;
    let closingDay: number | undefined;
    let dueDay: number | undefined;

    if (accType === 'credit') {
      if (accCreditLimitInput.trim()) {
        try {
          creditLimitCents = parseBRLToCents(accCreditLimitInput);
          if (creditLimitCents < 0) {
            setModalError('O limite do cartão não pode ser negativo.');
            return;
          }
        } catch (err: unknown) {
          setModalError(err instanceof Error ? err.message : 'Limite de crédito inválido.');
          return;
        }
      } else {
        creditLimitCents = 0;
      }

      const parsedClosing = parseInt(accClosingDay, 10);
      const parsedDue = parseInt(accDueDay, 10);
      if (!Number.isInteger(parsedClosing) || parsedClosing < 1 || parsedClosing > 31) {
        setModalError('O dia de fechamento da fatura deve estar entre 1 e 31.');
        return;
      }
      if (!Number.isInteger(parsedDue) || parsedDue < 1 || parsedDue > 31) {
        setModalError('O dia de vencimento da fatura deve estar entre 1 e 31.');
        return;
      }
      closingDay = parsedClosing;
      dueDay = parsedDue;
    }

    setAccSubmitting(true);
    try {
      if (editingAccount) {
        await updateAccount(
          editingAccount.id,
          userId,
          {
            name: accName.trim(),
            type: accType,
            color: accColor,
            icon: accIcon,
            ...(accType === 'credit' ? { creditLimitCents, closingDay, dueDay } : {}),
          },
          isDemo
        );
        showToast('Conta atualizada com sucesso.');
      } else {
        const payload: CreateAccountInput = {
          name: accName.trim(),
          type: accType,
          color: accColor,
          icon: accIcon,
          ...(accType === 'credit' ? { creditLimitCents, closingDay, dueDay } : {}),
        };
        await createAccount(userId, payload, isDemo);
        showToast('Nova conta financeira criada com sucesso.');
      }
      setIsCreateModalOpen(false);
      setEditingAccount(null);
      resetAccountForm();
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro ao salvar conta';
      setModalError(message);
    } finally {
      setAccSubmitting(false);
    }
  };

  const handleOpenEditAccount = (acc: Account, e: React.MouseEvent) => {
    e.stopPropagation();
    setModalError(null);
    setEditingAccount(acc);
    setAccName(acc.name);
    setAccType(acc.type);
    setAccColor(resolveHexColor(acc.color, '#2563EB'));
    setAccIcon(
      acc.icon
        ? resolvePhosphorCategoryIcon(acc.icon)
        : acc.type === 'credit'
        ? 'ph-credit-card'
        : acc.type === 'savings'
        ? 'ph-coins'
        : 'ph-wallet'
    );
    setAccCreditLimitInput(
      typeof acc.creditLimitCents === 'number' && acc.creditLimitCents > 0
        ? (acc.creditLimitCents / 100).toFixed(2).replace('.', ',')
        : ''
    );
    setAccClosingDay(String(acc.closingDay || 20));
    setAccDueDay(String(acc.dueDay || 27));
    setIsCreateModalOpen(true);
  };

  const handleToggleArchive = async (acc: Account, e: React.MouseEvent) => {
    e.stopPropagation();
    setModalError(null);
    if (acc.isArchived) {
      // Desarquivar diretamente com confirmação simples
      try {
        await archiveAccount(acc.id, userId, false, isDemo);
        showToast(`Conta "${acc.name}" reativada com sucesso.`);
        if (selectedAccount?.id === acc.id) {
          setSelectedAccount((prev) => (prev ? { ...prev, isArchived: false } : null));
        }
        await loadAccounts();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Erro ao desarquivar conta.');
      }
      return;
    }

    // Abre fluxo guiado de Encerramento / Arquivamento Seguro com diagnóstico de pendências
    setArchiveTargetAccount(acc);
    setMigrateToAccountId('');
    setArchiveScan({
      openTransactionsCount: 0,
      activeRecurrenceRulesCount: 0,
      unpaidInvoicesBalanceCents: 0,
      loading: true,
    });

    try {
      const [txs, rules, invoices] = await Promise.all([
        getUserPersonalTransactions(userId, undefined, isDemo).catch(() => []),
        getRecurrenceRules({ userId, scope: 'personal' }, isDemo).catch(() => []),
        acc.type === 'credit'
          ? getCardInvoices(acc.id, userId, isDemo).catch(() => [])
          : Promise.resolve([]),
      ]);

      const openTxs = txs.filter(
        (t) =>
          t.accountId === acc.id &&
          ['pending', 'forecast', 'partially_paid', 'overdue'].includes(t.status)
      );
      const activeRules = rules.filter(
        (r) => r.defaultAccountId === acc.id && r.status === 'active'
      );
      const unpaidInvoicesBalanceCents = invoices.reduce(
        (sum, inv) =>
          inv.invoiceStatus !== 'paid' && inv.invoiceStatus !== 'carried_over'
            ? sum + (inv.remainingBalanceCents || 0)
            : sum,
        0
      );

      setArchiveScan({
        openTransactionsCount: openTxs.length,
        activeRecurrenceRulesCount: activeRules.length,
        unpaidInvoicesBalanceCents,
        loading: false,
      });
    } catch {
      setArchiveScan({
        openTransactionsCount: 0,
        activeRecurrenceRulesCount: 0,
        unpaidInvoicesBalanceCents: 0,
        loading: false,
      });
    }
  };

  const handleConfirmSafeArchive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!archiveTargetAccount) return;
    setArchiveSubmitting(true);
    setModalError(null);
    try {
      const shouldMigrate = Boolean(migrateToAccountId.trim());
      const res = await archiveAccountSafely(
        {
          accountId: archiveTargetAccount.id,
          userId,
          targetAccountId: shouldMigrate ? migrateToAccountId : undefined,
          migrateOpenObligations: shouldMigrate,
        },
        isDemo
      );

      const migrationSummary =
        res.migratedTransactionsCount > 0 || res.migratedRecurrenceRulesCount > 0
          ? ` (${res.migratedTransactionsCount} obrigação(ões) e ${res.migratedRecurrenceRulesCount} recorrência(s) transferida(s))`
          : '';

      showToast(
        `Conta "${archiveTargetAccount.name}" arquivada com histórico preservado${migrationSummary}.`
      );
      if (selectedAccount?.id === archiveTargetAccount.id) {
        setSelectedAccount((prev) => (prev ? { ...prev, isArchived: true } : null));
      }
      setArchiveTargetAccount(null);
      await loadAccounts();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Falha ao arquivar conta com segurança.');
    } finally {
      setArchiveSubmitting(false);
    }
  };


  // Estorno compensatório (funciona tanto no modal da conta quanto no Livro-Razão Geral)
  const handleExecuteReversal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!movementToReverse) return;
    const targetAccountId = movementToReverse.accountId || selectedAccount?.id;
    if (!targetAccountId) return;

    if (!reversalReason.trim()) {
      setModalError('A justificativa do estorno é obrigatória conforme a arquitetura.');
      return;
    }

    setReversalSubmitting(true);
    setModalError(null);
    try {
      const res = await reverseMovement(
        targetAccountId,
        movementToReverse.id,
        userId,
        reversalReason.trim(),
        isDemo
      );

      showToast(
        `Estorno compensatório gravado com sucesso! Novo Saldo Projetado: ${formatCentsToBRL(
          res.newProjectedBalanceCents
        )}`
      );

      setIsReversalModalOpen(false);
      setMovementToReverse(null);
      setReversalReason('');

      // Recarrega histórico e contas
      if (selectedAccount && selectedAccount.id === targetAccountId) {
        await loadMovementsForAccount(selectedAccount);
        setSelectedAccount((prev) =>
          prev
            ? {
                ...prev,
                projectedBalanceCents: res.newProjectedBalanceCents,
              }
            : null
        );
      }
      const freshAccounts = await loadAccounts();
      if (viewMode === 'general_ledger' || generalLedgerMovements.length > 0) {
        await loadGeneralLedger(freshAccounts.length > 0 ? freshAccounts : undefined);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Falha ao executar estorno';
      setModalError(message);
    } finally {
      setReversalSubmitting(false);
    }
  };

  // Conjunto de IDs de movimentos que já possuem estorno compensatório registrado
  const reversedMovementIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of movements) {
      if (m.reversalOfMovementId) {
        ids.add(m.reversalOfMovementId);
      }
    }
    return ids;
  }, [movements]);

  const movementsWithBalance = useMemo(() => {
    return attachChronologicalRunningBalances(movements);
  }, [movements]);

  const nonCreditAccounts = useMemo(
    () => accounts.filter((a) => a.type !== 'credit'),
    [accounts]
  );

  const generalLedgerPeriods = useMemo(() => {
    const months = new Set<string>();
    for (const m of generalLedgerMovements) {
      if (m.effectiveDate && m.effectiveDate.length >= 7) {
        months.add(m.effectiveDate.slice(0, 7));
      }
    }
    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [generalLedgerMovements]);

  const filteredGeneralLedger = useMemo(() => {
    return generalLedgerMovements.filter((m) => {
      if (
        ledgerPeriodFilter !== 'all' &&
        (!m.effectiveDate || !m.effectiveDate.startsWith(ledgerPeriodFilter))
      ) {
        return false;
      }
      if (ledgerAccountFilter !== 'all' && m.accountId !== ledgerAccountFilter) {
        return false;
      }
      if (ledgerScopeFilter !== 'all' && m.scope !== ledgerScopeFilter) {
        return false;
      }
      if (ledgerSearch.trim()) {
        const q = ledgerSearch.trim().toLowerCase();
        const hay = `${m.description} ${m.categoryName} ${m.accountName} ${
          m.relatedAccountName || ''
        } ${m.originType} ${m.originId} ${m.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    generalLedgerMovements,
    ledgerPeriodFilter,
    ledgerAccountFilter,
    ledgerScopeFilter,
    ledgerSearch,
  ]);

  const generalLedgerTotals = useMemo(() => {
    let inflowsCents = 0;
    let outflowsCents = 0;
    for (const m of filteredGeneralLedger) {
      if (m.direction === 'inflow') inflowsCents += m.amountCents;
      else outflowsCents += m.amountCents;
    }
    return {
      inflowsCents,
      outflowsCents,
      netCents: inflowsCents - outflowsCents,
    };
  }, [filteredGeneralLedger]);

  // Contas filtradas
  const filteredAccounts = useMemo(() => {
    if (filterStatus === 'active') return accounts.filter((a) => !a.isArchived);
    if (filterStatus === 'archived') return accounts.filter((a) => a.isArchived);
    return accounts;
  }, [accounts, filterStatus]);

  // Métricas (exclui cartões de crédito da soma de saldo bancário/caixa)
  const totalBalanceCents = useMemo(() => {
    return accounts
      .filter((a) => !a.isArchived && a.type !== 'credit')
      .reduce((acc, curr) => acc + (curr.projectedBalanceCents || 0), 0);
  }, [accounts]);

  const activeCashAccountsCount = accounts.filter(
    (a) => !a.isArchived && a.type !== 'credit'
  ).length;
  const activeCreditCardsCount = accounts.filter(
    (a) => !a.isArchived && a.type === 'credit'
  ).length;
  const activeAccountsCount = accounts.filter((a) => !a.isArchived).length;
  const archivedAccountsCount = accounts.filter((a) => a.isArchived).length;

  const getAccountTypeIcon = (type: AccountType) => {
    switch (type) {
      case 'wallet':
        return <Wallet className="w-5 h-5" />;
      case 'checking':
        return <Building2 className="w-5 h-5" />;
      case 'savings':
        return <PiggyBank className="w-5 h-5" />;
      case 'credit':
        return <CreditCard className="w-5 h-5" />;
    }
  };

  const getAccountTypeLabel = (type: AccountType) => {
    switch (type) {
      case 'wallet':
        return 'Carteira Física / Dinheiro';
      case 'checking':
        return 'Conta Corrente';
      case 'savings':
        return 'Poupança / Reserva / Posse';
      case 'credit':
        return 'Cartão / Linha de Crédito';
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast de Sucesso */}
      {successToast && (
        <div className="fixed top-4 right-4 z-[60] flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl shadow-xl transition-all">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span className="text-sm font-medium">{successToast}</span>
        </div>
      )}

      {/* Alerta de Erro */}
      {error && (
        <div className="flex items-center justify-between p-4 bg-rose-500/15 border border-rose-500/30 text-rose-200 rounded-xl">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
            <span className="text-sm font-medium">{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-rose-300 hover:text-white text-sm font-bold ml-4 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header com Identificação Canônica v3.1 e Alternância Contas vs Livro-Razão Geral */}
      <div className="bg-slate-800/90 rounded-2xl p-6 shadow-sm border border-slate-700/80 flex flex-col gap-4">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase bg-indigo-500/15 text-indigo-300 rounded-md border border-indigo-500/30">
                Arquitetura v3.1 Homologada
              </span>
              {isDemo && (
                <span className="px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase bg-amber-500/15 text-amber-300 rounded-md border border-amber-500/30">
                  Modo Demonstração (Isolado)
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold text-white mt-1">
              Contas & Livro Financeiro (Ledger Oficial)
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Histórico imutável append-only com saldo resultante cronológico, livros dedicados para cartões e reconciliação contábil.
            </p>
          </div>

          <button
            onClick={() => {
              setEditingAccount(null);
              resetAccountForm();
              setIsCreateModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all cursor-pointer shrink-0"
          >
            <Plus className="w-4 h-4" />
            Nova Conta / Cartão
          </button>
        </div>

        {/* Abas Principais: Contas & Cartões | Livro-Razão Geral */}
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-700/70">
          <button
            type="button"
            onClick={() => setViewMode('accounts')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              viewMode === 'accounts'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-900/80 text-slate-300 hover:text-white border border-slate-700'
            }`}
          >
            <Building2 className="w-4 h-4" />
            Contas & Cartões ({accounts.length})
          </button>
          <button
            type="button"
            onClick={() => setViewMode('general_ledger')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              viewMode === 'general_ledger'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-900/80 text-slate-300 hover:text-white border border-slate-700'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            Livro-Razão Geral
          </button>
        </div>
      </div>

      {/* Cards de Métricas Consolidadas */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Saldo Total em Contas
            </span>
            <div className="p-2 bg-emerald-500/15 text-emerald-400 rounded-xl border border-emerald-500/30">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {formatCentsToBRL(totalBalanceCents)}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Soma de {activeCashAccountsCount} conta(s) bancária(s)/carteira (exclui cartões)
          </div>
        </div>

        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Contas & Cartões Ativos
            </span>
            <div className="p-2 bg-indigo-500/15 text-indigo-400 rounded-xl border border-indigo-500/30">
              <Building2 className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {activeAccountsCount}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {activeCashAccountsCount} conta(s) • {activeCreditCardsCount} cartão(ões) de crédito
          </div>
        </div>

        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Contas Arquivadas
            </span>
            <div className="p-2 bg-slate-700/50 text-slate-300 rounded-xl border border-slate-600/50">
              <Archive className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {archivedAccountsCount}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Histórico mantido sem novas operações
          </div>
        </div>
      </div>

      {viewMode === 'general_ledger' ? (
        <div className="space-y-4">
          {/* Painel de Filtros do Livro-Razão Geral */}
          <div className="bg-slate-800/90 p-4 rounded-2xl border border-slate-700/80 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
                <ListFilter className="w-4 h-4 text-indigo-400" />
                Filtros do Livro-Razão Geral
              </div>
              <button
                type="button"
                onClick={() => loadGeneralLedger()}
                disabled={loadingGeneralLedger}
                className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingGeneralLedger ? 'animate-spin' : ''}`} />
                Atualizar Livro-Razão
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Buscar descrição, categoria, origem ou ID..."
                  value={ledgerSearch}
                  onChange={(e) => setLedgerSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <select
                value={ledgerPeriodFilter}
                onChange={(e) => setLedgerPeriodFilter(e.target.value)}
                aria-label="Filtrar por período"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Todos os períodos</option>
                {generalLedgerPeriods.map((m) => (
                  <option key={m} value={m}>
                    Competência {m}
                  </option>
                ))}
              </select>

              <select
                value={ledgerAccountFilter}
                onChange={(e) => setLedgerAccountFilter(e.target.value)}
                aria-label="Filtrar por conta"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Todas as contas bancárias / carteiras</option>
                {nonCreditAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>

              <select
                value={ledgerScopeFilter}
                onChange={(e) => setLedgerScopeFilter(e.target.value as 'all' | LedgerScopeType)}
                aria-label="Filtrar por escopo"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Escopo: Todos (Individual + Compartilhado)</option>
                <option value="individual">Somente Individual</option>
                <option value="shared">Somente Compartilhado</option>
              </select>
            </div>

            {/* Resumo do Recorte */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-700/70 text-xs">
              <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-700/70">
                <span className="text-[10px] text-slate-400 uppercase block">Registros</span>
                <span className="font-mono font-bold text-white">
                  {filteredGeneralLedger.length}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-700/70">
                <span className="text-[10px] text-slate-400 uppercase block">Entradas (+)</span>
                <span className="font-mono font-bold text-emerald-400">
                  + {formatCentsToBRL(generalLedgerTotals.inflowsCents)}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-700/70">
                <span className="text-[10px] text-slate-400 uppercase block">Saídas (-)</span>
                <span className="font-mono font-bold text-rose-400">
                  - {formatCentsToBRL(generalLedgerTotals.outflowsCents)}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-700/70">
                <span className="text-[10px] text-slate-400 uppercase block">Resultado Líquido</span>
                <span
                  className={`font-mono font-bold ${
                    generalLedgerTotals.netCents >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                >
                  {formatCentsToBRL(generalLedgerTotals.netCents)}
                </span>
              </div>
            </div>
          </div>

          {generalLedgerError ? (
            <div className="p-6 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-center space-y-2">
              <AlertCircle className="w-8 h-8 text-rose-400 mx-auto" />
              <p className="text-sm font-semibold text-rose-200">{generalLedgerError}</p>
              <button
                type="button"
                onClick={() => loadGeneralLedger()}
                className="px-4 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-xl cursor-pointer"
              >
                Tentar Novamente
              </button>
            </div>
          ) : loadingGeneralLedger ? (
            <div className="text-center py-14 bg-slate-800/90 rounded-2xl border border-slate-700/80">
              <RefreshCw className="w-7 h-7 animate-spin text-indigo-400 mx-auto" />
              <p className="text-xs text-slate-400 mt-2">
                Consolidando movimentações e calculando saldo resultante cronológico...
              </p>
            </div>
          ) : filteredGeneralLedger.length === 0 ? (
            <div className="text-center py-14 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700 p-6">
              <FileSpreadsheet className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <h3 className="text-sm font-bold text-slate-200">
                {generalLedgerMovements.length === 0
                  ? 'Nenhuma movimentação registrada no Livro-Razão'
                  : 'Nenhuma movimentação encontrada para os filtros selecionados'}
              </h3>
              <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                {generalLedgerMovements.length === 0
                  ? 'Registre entradas, saídas, transferências ou pagamentos de fatura para visualizar o livro contábil aqui. Compras no cartão ficam no Livro do Cartão.'
                  : 'Ajuste o período, conta, escopo ou termo de busca para visualizar outros registros.'}
              </p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden lg:block overflow-x-auto rounded-2xl border border-slate-700/80 bg-slate-900/80 shadow-sm">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-800/90 text-slate-300 uppercase text-[10px] tracking-wider border-b border-slate-700">
                    <tr>
                      <th className="px-3.5 py-3">Data</th>
                      <th className="px-3.5 py-3">Descrição</th>
                      <th className="px-3.5 py-3">Categoria</th>
                      <th className="px-3.5 py-3">Origem</th>
                      <th className="px-3.5 py-3">Conta / Relacionada</th>
                      <th className="px-3.5 py-3">Escopo</th>
                      <th className="px-3.5 py-3 text-right">Entrada</th>
                      <th className="px-3.5 py-3 text-right">Saída</th>
                      <th className="px-3.5 py-3 text-right">Saldo Resultante</th>
                      <th className="px-3.5 py-3">ID Origem</th>
                      <th className="px-3.5 py-3 text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {filteredGeneralLedger.map((mov) => {
                      const isInflow = mov.direction === 'inflow';
                      const accObj = accounts.find((a) => a.id === mov.accountId);
                      return (
                        <tr
                          key={`${mov.accountId}-${mov.id}`}
                          className={`hover:bg-slate-800/40 ${
                            mov.isCompensatory
                              ? 'bg-amber-950/20'
                              : mov.isReversed
                              ? 'opacity-65'
                              : ''
                          }`}
                        >
                          <td className="px-3.5 py-3 font-mono text-slate-300 whitespace-nowrap">
                            {formatIsoDateBR(mov.effectiveDate)}
                          </td>
                          <td className="px-3.5 py-3 max-w-[240px]">
                            <div className="font-semibold text-white truncate" title={mov.description}>
                              {mov.description}
                            </div>
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {mov.isCompensatory && (
                                <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-900/60 text-amber-300 border border-amber-700/50">
                                  ESTORNO
                                </span>
                              )}
                              {mov.isReversed && !mov.isCompensatory && (
                                <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-slate-800 text-slate-300 border border-slate-700">
                                  ESTORNADO
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3.5 py-3 text-slate-300 whitespace-nowrap">
                            {mov.categoryName}
                          </td>
                          <td className="px-3.5 py-3 text-slate-400 font-mono text-[11px] whitespace-nowrap">
                            {mov.originType}
                          </td>
                          <td className="px-3.5 py-3">
                            <div className="font-semibold text-slate-200">{mov.accountName}</div>
                            {mov.relatedAccountName && (
                              <div className="text-[11px] text-indigo-300">
                                ↔ {mov.relatedAccountName}
                              </div>
                            )}
                          </td>
                          <td className="px-3.5 py-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 text-[10px] font-bold rounded border ${
                                mov.scope === 'shared'
                                  ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                                  : 'bg-slate-800 text-slate-300 border-slate-700'
                              }`}
                            >
                              {mov.scope === 'shared' ? 'Compartilhado' : 'Individual'}
                            </span>
                          </td>
                          <td className="px-3.5 py-3 text-right font-mono font-bold text-emerald-400 whitespace-nowrap">
                            {isInflow ? `+ ${formatCentsToBRL(mov.amountCents)}` : '—'}
                          </td>
                          <td className="px-3.5 py-3 text-right font-mono font-bold text-rose-400 whitespace-nowrap">
                            {!isInflow ? `- ${formatCentsToBRL(mov.amountCents)}` : '—'}
                          </td>
                          <td
                            className={`px-3.5 py-3 text-right font-mono font-black whitespace-nowrap ${
                              mov.runningBalanceCents >= 0 ? 'text-white' : 'text-rose-400'
                            }`}
                          >
                            {formatCentsToBRL(mov.runningBalanceCents)}
                          </td>
                          <td
                            className="px-3.5 py-3 font-mono text-[10px] text-slate-400 max-w-[110px] truncate"
                            title={mov.originId}
                          >
                            {mov.originId}
                          </td>
                          <td className="px-3.5 py-3 text-right whitespace-nowrap">
                            {!mov.isCompensatory && !mov.isReversed && !accObj?.isArchived ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setModalError(null);
                                  setMovementToReverse(mov);
                                  setReversalReason('');
                                  setIsReversalModalOpen(true);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-amber-300 bg-amber-950/50 hover:bg-amber-900/60 border border-amber-800/60 rounded-lg cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                Estornar
                              </button>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="lg:hidden space-y-2.5">
                {filteredGeneralLedger.map((mov) => {
                  const isInflow = mov.direction === 'inflow';
                  const accObj = accounts.find((a) => a.id === mov.accountId);
                  return (
                    <div
                      key={`${mov.accountId}-${mov.id}`}
                      className={`p-4 rounded-2xl border space-y-2 ${
                        mov.isCompensatory
                          ? 'bg-amber-950/25 border-amber-800/60'
                          : mov.isReversed
                          ? 'bg-slate-900/50 border-slate-800 opacity-65'
                          : 'bg-slate-800/80 border-slate-700/80'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-bold text-sm text-white truncate">
                            {mov.description}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {formatIsoDateBR(mov.effectiveDate)} • {mov.categoryName} •{' '}
                            {mov.accountName}
                            {mov.relatedAccountName ? ` ↔ ${mov.relatedAccountName}` : ''}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div
                            className={`text-sm font-black font-mono ${
                              isInflow ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isInflow ? '+ ' : '- '}
                            {formatCentsToBRL(mov.amountCents)}
                          </div>
                          <div className="text-[11px] text-slate-300 font-mono">
                            Saldo: {formatCentsToBRL(mov.runningBalanceCents)}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-700/60 text-[11px]">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300">
                            {mov.scope === 'shared' ? 'Compartilhado' : 'Individual'}
                          </span>
                          <span className="font-mono text-slate-400">{mov.originType}</span>
                        </div>

                        {!mov.isCompensatory && !mov.isReversed && !accObj?.isArchived && (
                          <button
                            type="button"
                            onClick={() => {
                              setModalError(null);
                              setMovementToReverse(mov);
                              setReversalReason('');
                              setIsReversalModalOpen(true);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-amber-300 bg-amber-950/50 border border-amber-800/60 rounded-lg cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Estornar
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Barra de Filtros e Status de Contas */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-700/80 rounded-xl">
              <button
                onClick={() => setFilterStatus('active')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                  filterStatus === 'active'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Ativas ({activeAccountsCount})
              </button>
              <button
                onClick={() => setFilterStatus('archived')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                  filterStatus === 'archived'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Arquivadas ({archivedAccountsCount})
              </button>
              <button
                onClick={() => setFilterStatus('all')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                  filterStatus === 'all'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Todas ({accounts.length})
              </button>
            </div>

            <button
              onClick={() => loadAccounts()}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/90 hover:bg-slate-700 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar Lista
            </button>
          </div>

          {/* Lista de Contas em Grid */}
          {loading ? (
            <div className="text-center py-16 bg-slate-800/90 rounded-2xl border border-slate-700/80">
              <RefreshCw className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
              <p className="text-sm font-medium text-slate-400 mt-3">
                Carregando contas financeiras...
              </p>
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="text-center py-16 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700 p-8">
              <Building2 className="w-12 h-12 text-slate-500 mx-auto mb-3" />
              <h3 className="text-base font-semibold text-slate-200">
                Nenhuma conta encontrada
              </h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                {filterStatus === 'archived'
                  ? 'Nenhuma conta arquivada no momento.'
                  : 'Cadastre sua primeira conta bancária para iniciar o registro contábil.'}
              </p>
              {filterStatus !== 'archived' && (
                <button
                  onClick={() => {
                    setEditingAccount(null);
                    resetAccountForm();
                    setIsCreateModalOpen(true);
                  }}
                  className="mt-4 px-4 py-2 bg-indigo-600 text-white text-xs font-semibold rounded-xl hover:bg-indigo-500 transition-all cursor-pointer"
                >
                  Criar Conta Agora
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAccounts.map((acc, accIdx) => {
                const accKey = acc.id ? `acc-${acc.id}-${accIdx}` : `acc-idx-${accIdx}`;
                const isSelected =
                  selectedAccount?.id === acc.id || selectedCreditCard?.id === acc.id;
                const isCreditCard = acc.type === 'credit';
                return (
                  <div
                    key={accKey}
                    onClick={() => handleSelectAccountForLedger(acc)}
                    className={`relative bg-slate-800/90 rounded-2xl border transition-all cursor-pointer p-5 flex flex-col justify-between hover:border-indigo-500/50 hover:shadow-lg ${
                      isSelected
                        ? 'border-indigo-500 ring-2 ring-indigo-500/30 shadow-md'
                        : 'border-slate-700/80'
                    } ${acc.isArchived ? 'opacity-70 bg-slate-900/40' : ''}`}
                  >
                    {/* Header do Card */}
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-xs shrink-0"
                            style={{ backgroundColor: acc.color || '#2563EB' }}
                          >
                            {getAccountTypeIcon(acc.type)}
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-base font-bold text-white leading-tight truncate">
                              {acc.name}
                            </h3>
                            <div className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
                              <span>{getAccountTypeLabel(acc.type)}</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            title="Editar Conta"
                            onClick={(e) => handleOpenEditAccount(acc, e)}
                            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/60 rounded-lg transition-all cursor-pointer"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title={acc.isArchived ? 'Desarquivar Conta' : 'Arquivar Conta'}
                            onClick={(e) => handleToggleArchive(acc, e)}
                            className="p-1.5 text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 rounded-lg transition-all cursor-pointer"
                          >
                            {acc.isArchived ? (
                              <ArchiveRestore className="w-3.5 h-3.5 text-amber-400" />
                            ) : (
                              <Archive className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Saldo Projetado (Contas) ou Resumo de Limite (Cartão de Crédito) */}
                      <div className="mt-5 pt-4 border-t border-slate-700/70">
                        {isCreditCard ? (
                          <div className="space-y-2">
                            <div>
                              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                                Limite Disponível
                              </span>
                              <div
                                className={`text-2xl font-black tracking-tight mt-0.5 font-mono ${
                                  (cardLimits[acc.id]?.availableLimitCents ??
                                    acc.creditLimitCents ??
                                    0) >= 0
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {formatCentsToBRL(
                                  cardLimits[acc.id]?.availableLimitCents ??
                                    acc.creditLimitCents ??
                                    0
                                )}
                              </div>
                            </div>

                            <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-700/70 space-y-1 text-[11px]">
                              <div className="flex items-center justify-between">
                                <span className="text-slate-400">Limite Total</span>
                                <span className="font-mono font-semibold text-slate-200">
                                  {formatCentsToBRL(
                                    cardLimits[acc.id]?.creditLimitCents ??
                                      acc.creditLimitCents ??
                                      0
                                  )}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-slate-400">Em Faturas Abertas</span>
                                <span className="font-mono font-semibold text-amber-300">
                                  {formatCentsToBRL(cardLimits[acc.id]?.usedAmountCents ?? 0)}
                                </span>
                              </div>
                              {(acc.closingDay || acc.dueDay) && (
                                <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800">
                                  Fecha dia {acc.closingDay || '—'} • Vence dia {acc.dueDay || '—'}
                                </div>
                              )}
                            </div>
                          </div>
                        ) : (
                          <>
                            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                              Saldo Projetado Oficial
                            </span>
                            <div
                              className={`text-2xl font-black tracking-tight mt-0.5 font-mono ${
                                acc.projectedBalanceCents >= 0 ? 'text-white' : 'text-rose-400'
                              }`}
                            >
                              {formatCentsToBRL(acc.projectedBalanceCents)}
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Footer do Card */}
                    <div className="mt-4 pt-3 flex items-center justify-between text-xs border-t border-slate-700/60">
                      <span
                        className={`px-2 py-0.5 rounded-md font-medium text-[11px] ${
                          acc.isArchived
                            ? 'bg-slate-700/50 text-slate-300 border border-slate-600/50'
                            : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        }`}
                      >
                        {acc.isArchived ? 'Arquivada' : 'Ativa'}
                      </span>

                      <span className="flex items-center gap-1 text-indigo-400 font-semibold group-hover:underline">
                        {isCreditCard ? (
                          <CreditCard className="w-3.5 h-3.5" />
                        ) : (
                          <BookOpen className="w-3.5 h-3.5" />
                        )}
                        {isCreditCard ? 'Abrir Livro do Cartão →' : 'Abrir Livro-Razão →'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* MODAL RESPONSIVO DO LIVRO DE MOVIMENTAÇÕES (FINANCIAL MOVEMENT LEDGER) */}
      {selectedAccount && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm sm:p-4"
          onClick={() => setSelectedAccount(null)}
        >
          <div
            className="bg-slate-900 w-full h-[100dvh] sm:h-auto sm:max-h-[88dvh] sm:max-w-4xl sm:rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header sticky do Livro da Conta */}
            <div className="p-4 sm:p-6 bg-slate-900 text-white flex flex-col gap-4 border-b border-slate-700/80 shrink-0">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedAccount(null)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Voltar
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedAccount(null)}
                  className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-all cursor-pointer"
                  title="Fechar Livro-Razão"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0 shadow-inner"
                    style={{
                      backgroundColor: resolveHexColor(selectedAccount.color, '#2563EB'),
                    }}
                  >
                    {selectedAccount.icon ? (
                      <i
                        className={`ph-fill ${resolvePhosphorCategoryIcon(
                          selectedAccount.icon
                        )} text-xl`}
                      />
                    ) : (
                      getAccountTypeIcon(selectedAccount.type)
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
                        Livro-Razão da Conta
                      </span>
                      {selectedAccount.isArchived && (
                        <span className="px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded font-bold border border-amber-500/30">
                          Arquivada (Somente Leitura)
                        </span>
                      )}
                    </div>
                    <h2 className="text-xl font-black mt-0.5 text-white truncate">
                      {selectedAccount.name}
                    </h2>
                    <div className="text-xs text-slate-400 mt-0.5 truncate">
                      ID: <code className="text-slate-300">{selectedAccount.id}</code>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="bg-slate-800/90 px-4 py-2 rounded-xl border border-slate-700">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">
                      Saldo Projetado
                    </span>
                    <span
                      className={`text-lg font-black font-mono ${
                        selectedAccount.projectedBalanceCents >= 0
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {formatCentsToBRL(selectedAccount.projectedBalanceCents)}
                    </span>
                  </div>

                  <button
                    onClick={handleReconcileBalance}
                    disabled={reconciling}
                    title="Recalcula a totalidade dos movimentos no livro para certificar consistência estrita"
                    className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition-all disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`}
                    />
                    {reconciling ? 'Reconciliando...' : 'Reconciliar Saldo'}
                  </button>

                  {!selectedAccount.isArchived && (
                    <>
                      {selectedAccount.type !== 'credit' && (
                        <button
                          onClick={() =>
                            onOpenNewTransaction?.({
                              presetAccountId: selectedAccount.id,
                              presetType: 'income',
                              presetIsPaid: true,
                            })
                          }
                          className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
                        >
                          <ArrowDownLeft className="w-4 h-4" />
                          Nova Entrada (+)
                        </button>
                      )}

                      <button
                        onClick={() =>
                          onOpenNewTransaction?.({
                            presetAccountId: selectedAccount.id,
                            presetType: 'expense',
                            presetIsPaid: true,
                          })
                        }
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
                      >
                        <ArrowUpRight className="w-4 h-4" />
                        Nova Saída (-)
                      </button>
                    </>
                  )}
                </div>
              </div>

              {selectedAccount.type === 'credit' && cardLimits[selectedAccount.id] && (
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800 text-xs">
                  <div className="bg-slate-800/70 rounded-xl px-3 py-2 border border-slate-700/70">
                    <span className="text-[10px] text-slate-400 uppercase block">Limite Total</span>
                    <span className="font-mono font-bold text-white">
                      {formatCentsToBRL(cardLimits[selectedAccount.id].creditLimitCents)}
                    </span>
                  </div>
                  <div className="bg-slate-800/70 rounded-xl px-3 py-2 border border-slate-700/70">
                    <span className="text-[10px] text-slate-400 uppercase block">Em Faturas</span>
                    <span className="font-mono font-bold text-amber-300">
                      {formatCentsToBRL(cardLimits[selectedAccount.id].usedAmountCents)}
                    </span>
                  </div>
                  <div className="bg-slate-800/70 rounded-xl px-3 py-2 border border-slate-700/70">
                    <span className="text-[10px] text-slate-400 uppercase block">Disponível</span>
                    <span className="font-mono font-bold text-emerald-400">
                      {formatCentsToBRL(cardLimits[selectedAccount.id].availableLimitCents)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Banner de Garantia Arquitetural */}
            <div className="bg-blue-950/40 border-b border-blue-900/50 px-6 py-2.5 flex items-center justify-between gap-3 text-xs text-blue-300 shrink-0">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
                <span>
                  <strong>Princípio Contábil Homologado v3.1:</strong> Registro estritamente append-only. Movimentações são imutáveis e estornos geram movimentos compensatórios opostos.
                </span>
              </div>
              <span className="font-semibold text-blue-400 shrink-0">
                {movements.length} registro(s)
              </span>
            </div>

            {/* Listagem Scrollável de Movimentações */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
              {loadingMovements ? (
                <div className="text-center py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-blue-400 mx-auto" />
                  <p className="text-xs text-slate-400 mt-2">
                    Carregando histórico do livro-razão...
                  </p>
                </div>
              ) : movements.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-slate-700/80 rounded-xl">
                  <FileSpreadsheet className="w-10 h-10 text-slate-500 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-200">
                    Livro-Razão sem lançamentos registrados
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Clique em "Nova Entrada" ou "Nova Saída" para registrar movimentações atômicas.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {movementsWithBalance.map((mov, movIdx) => {
                    const movKey = mov.id ? `mov-${mov.id}-${movIdx}` : `mov-idx-${movIdx}`;
                    const isInflow = mov.direction === 'inflow';
                    const isCompensatory = !!mov.reversalOfMovementId;
                    const isAlreadyReversed = reversedMovementIds.has(mov.id);

                    return (
                      <div
                        key={movKey}
                        className={`p-4 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                          isCompensatory
                            ? 'bg-amber-950/30 border-amber-800/60'
                            : isAlreadyReversed
                            ? 'bg-slate-900/40 border-slate-700/50 opacity-60'
                            : 'bg-slate-800/60 border-slate-700/70 hover:border-slate-600'
                        }`}
                      >
                        {/* Lado Esquerdo: Direção, Descrição, Metadados */}
                        <div className="flex items-start gap-3">
                          <div
                            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                              isCompensatory
                                ? 'bg-amber-900/40 text-amber-300 border border-amber-700/50'
                                : isInflow
                                ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/40'
                                : 'bg-rose-950/60 text-rose-400 border border-rose-800/40'
                            }`}
                          >
                            {isCompensatory ? (
                              <RotateCcw className="w-4 h-4" />
                            ) : isInflow ? (
                              <ArrowDownLeft className="w-4 h-4" />
                            ) : (
                              <ArrowUpRight className="w-4 h-4" />
                            )}
                          </div>

                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-white text-sm">
                                {mov.description}
                              </span>

                              {isCompensatory && (
                                <span className="px-2 py-0.5 bg-amber-900/60 text-amber-300 border border-amber-700/50 text-[10px] font-bold rounded">
                                  ESTORNO COMPENSATÓRIO
                                </span>
                              )}

                              {isAlreadyReversed && !isCompensatory && (
                                <span className="px-2 py-0.5 bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-semibold rounded">
                                  COMPENSADO POR ESTORNO
                                </span>
                              )}

                              <span className="px-1.5 py-0.5 bg-slate-800 text-slate-300 border border-slate-700 text-[10px] font-medium rounded">
                                {mov.originType}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-1">
                              <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {formatIsoDateBR(mov.effectiveDate)}
                              </span>
                              <span>•</span>
                              <span>Origem: {mov.originType}</span>
                              <span>•</span>
                              <span>ID: {mov.id.slice(0, 14)}...</span>
                            </div>

                            {mov.notes && (
                              <div className="text-xs text-slate-400 mt-1 italic">
                                "{mov.notes}"
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Lado Direito: Valor, Saldo Resultante e Ação de Estorno */}
                        <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-700/60">
                          <div className="text-right">
                            <span
                              className={`text-base font-black font-mono ${
                                isInflow ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {isInflow ? '+ ' : '- '}
                              {formatCentsToBRL(mov.amountCents)}
                            </span>
                            <span className="block text-[11px] font-mono text-slate-300">
                              Saldo Resultante: {formatCentsToBRL(mov.runningBalanceCents)}
                            </span>
                            <span className="block text-[10px] text-slate-400 uppercase font-semibold">
                              Status: {mov.confirmationStatus}
                            </span>
                          </div>

                          {/* Botão de Estorno: Apenas se ainda não foi estornado e não for compensatório */}
                          {!isCompensatory && !isAlreadyReversed && !selectedAccount.isArchived && (
                            <button
                              onClick={() => {
                                setModalError(null);
                                setMovementToReverse(mov);
                                setReversalReason('');
                                setIsReversalModalOpen(true);
                              }}
                              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-amber-300 bg-amber-950/50 hover:bg-amber-900/60 border border-amber-800/60 rounded-lg transition-all cursor-pointer"
                              title="Registra um movimento compensatório de direção oposta"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              Estornar
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL DEDICADO DO LIVRO-RAZÃO DO CARTÃO DE CRÉDITO */}
      {selectedCreditCard && (
        <CreditCardLedgerModal
          cardAccount={selectedCreditCard}
          accounts={accounts}
          userId={userId}
          isDemo={isDemo}
          refreshTrigger={refreshTrigger}
          onClose={() => setSelectedCreditCard(null)}
          onUpdated={async () => {
            const freshAccounts = await loadAccounts();
            if (viewMode === 'general_ledger' || generalLedgerMovements.length > 0) {
              await loadGeneralLedger(freshAccounts.length > 0 ? freshAccounts : undefined);
            }
          }}
          onOpenNewTransaction={onOpenNewTransaction}
        />
      )}

      {/* MODAL: CRIAR OU EDITAR CONTA */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <h3 className="text-lg font-bold text-white">
                {editingAccount ? 'Editar Conta Bancária' : 'Nova Conta Bancária'}
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsCreateModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveAccount} className="space-y-4 mt-4">
              {modalError && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/15 border border-rose-500/30 text-rose-200 rounded-xl text-xs">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{modalError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Nome da Conta *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Conta Principal, Itaú, Nubank, Carteira..."
                  value={accName}
                  onChange={(e) => setAccName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Tipo de Conta *
                </label>
                <select
                  value={accType}
                  onChange={(e) => setAccType(e.target.value as AccountType)}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="checking">Conta Corrente</option>
                  <option value="wallet">Carteira Física / Dinheiro</option>
                  <option value="savings">Poupança / Reserva / Posse</option>
                  <option value="credit">Cartão / Linha de Crédito</option>
                </select>
              </div>

              {accType === 'credit' && (
                <div className="p-3.5 rounded-xl bg-indigo-950/30 border border-indigo-800/50 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-300">
                    Parâmetros do Cartão de Crédito
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Limite Total (R$)
                    </label>
                    <input
                      type="text"
                      placeholder="Ex: 5000,00"
                      value={accCreditLimitInput}
                      onChange={(e) => setAccCreditLimitInput(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Dia Fechamento (1–31)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={accClosingDay}
                        onChange={(e) => setAccClosingDay(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Dia Vencimento (1–31)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={accDueDay}
                        onChange={(e) => setAccDueDay(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                </div>
              )}

              <IconGridPicker
                label="Ícone da Conta"
                value={accIcon}
                onChange={setAccIcon}
                compact
              />

              <ColorPalettePicker
                label="Cor de Identificação"
                mode="hex"
                value={accColor}
                onChange={setAccColor}
              />

              <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsCreateModalOpen(false);
                  }}
                  className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={accSubmitting}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50 cursor-pointer"
                >
                  {accSubmitting
                    ? 'Salvando...'
                    : editingAccount
                    ? 'Atualizar Conta'
                    : 'Criar Conta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* MODAL: ESTORNO COMPENSATÓRIO COM JUSTIFICATIVA */}
      {isReversalModalOpen && movementToReverse && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-amber-800/60">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-amber-950/60 text-amber-300 border border-amber-800/50">
                  <RotateCcw className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">
                    Estorno Compensatório
                  </h3>
                  <p className="text-xs text-amber-400 font-medium">
                    Regra Canônica v3.1: Sem exclusão física
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsReversalModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-4 p-4 bg-amber-950/40 rounded-xl border border-amber-800/60 text-xs space-y-1.5 text-amber-200">
              <div className="font-semibold text-amber-100">
                Movimentação a ser compensada:
              </div>
              <div>• Descrição: <strong className="text-white">{movementToReverse.description}</strong></div>
              <div>
                • Valor:{' '}
                <strong>
                  {movementToReverse.direction === 'inflow' ? '+ ' : '- '}
                  {formatCentsToBRL(movementToReverse.amountCents)}
                </strong>
              </div>
              <div>• Data Efetiva: {formatIsoDateBR(movementToReverse.effectiveDate)}</div>
              <div className="mt-2 pt-2 border-t border-amber-800/60 text-[11px] text-amber-300">
                Um novo movimento de direção{' '}
                <strong>
                  {movementToReverse.direction === 'inflow' ? 'SAÍDA (-)' : 'ENTRADA (+)'}
                </strong>{' '}
                será gravado no livro para anular o impacto contábil.
              </div>
            </div>

            <form onSubmit={handleExecuteReversal} className="space-y-4">
              {modalError && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/15 border border-rose-500/30 text-rose-200 rounded-xl text-xs">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{modalError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Justificativa Obrigatória do Estorno *
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="Ex: Lançamento em duplicidade, valor incorreto, cancelamento de operação..."
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsReversalModalOpen(false);
                  }}
                  className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={reversalSubmitting}
                  className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50 cursor-pointer"
                >
                  {reversalSubmitting ? 'Gravando Estorno...' : 'Confirmar Estorno Oficial'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ENCERRAMENTO / ARQUIVAMENTO SEGURO GUIADO */}
      {archiveTargetAccount && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  <Archive className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">
                    Arquivar Conta com Segurança
                  </h3>
                  <p className="text-xs text-slate-400">
                    Conta: <strong className="text-slate-200">{archiveTargetAccount.name}</strong>
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setModalError(null);
                  setArchiveTargetAccount(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConfirmSafeArchive} className="space-y-4 mt-4">
              {modalError && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/15 border border-rose-500/30 text-rose-200 rounded-xl text-xs">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{modalError}</span>
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-blue-950/40 border border-blue-800/50 text-xs text-blue-200 flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <span>
                  O livro-razão e todas as movimentações históricas da conta serão preservados integralmente em modo somente leitura. Nenhum registro contábil é excluído.
                </span>
              </div>

              {archiveScan.loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                  Verificando obrigações, recorrências e faturas vinculadas...
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <div className="p-3 rounded-xl bg-slate-800/80 border border-slate-700">
                    <span className="text-[10px] uppercase text-slate-400 block">
                      Lançamentos em Aberto
                    </span>
                    <span className="text-base font-black text-white">
                      {archiveScan.openTransactionsCount}
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-800/80 border border-slate-700">
                    <span className="text-[10px] uppercase text-slate-400 block">
                      Recorrências Ativas
                    </span>
                    <span className="text-base font-black text-white">
                      {archiveScan.activeRecurrenceRulesCount}
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-800/80 border border-slate-700">
                    <span className="text-[10px] uppercase text-slate-400 block">
                      Faturas Pendentes
                    </span>
                    <span className="text-base font-black text-amber-300 font-mono">
                      {formatCentsToBRL(archiveScan.unpaidInvoicesBalanceCents)}
                    </span>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Destino para Pendências e Recorrências Ativas
                </label>
                <select
                  value={migrateToAccountId}
                  onChange={(e) => setMigrateToAccountId(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">
                    Apenas arquivar mantendo histórico somente leitura
                  </option>
                  {accounts
                    .filter((a) => !a.isArchived && a.id !== archiveTargetAccount.id)
                    .map((dest) => (
                      <option key={dest.id} value={dest.id}>
                        Migrar obrigações/recorrências para: {dest.name} (
                        {formatCentsToBRL(dest.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Se escolher uma conta de destino, lançamentos em aberto e regras de recorrência vinculadas serão redirecionados antes do arquivamento.
                </p>
              </div>

              <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setArchiveTargetAccount(null);
                  }}
                  className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={archiveSubmitting || archiveScan.loading}
                  className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50 cursor-pointer"
                >
                  {archiveSubmitting ? 'Arquivando...' : 'Confirmar Arquivamento Seguro'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

