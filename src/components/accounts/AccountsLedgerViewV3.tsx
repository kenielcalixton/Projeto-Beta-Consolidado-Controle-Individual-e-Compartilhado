import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Calendar,
  X,
  Edit2,
  DollarSign,
  ShieldCheck,
  FileSpreadsheet,
} from 'lucide-react';
import { Account, FinancialMovement, AccountType } from '../../types/financeV3';
import {
  getUserAccounts,
  createAccount,
  updateAccount,
  archiveAccount,
  CreateAccountInput,
} from '../../services/accountService';
import {
  getAccountMovements,
  recordMovement,
  reverseMovement,
  reconcileAndSyncAccountBalance,
} from '../../services/ledgerService';
import {
  formatCentsToBRL,
  parseBRLToCents,
  validatePositiveCents,
} from '../../utils/movementLedger';

interface AccountsLedgerViewV3Props {
  userId: string;
  isDemo?: boolean;
}

export const AccountsLedgerViewV3: React.FC<AccountsLedgerViewV3Props> = ({
  userId,
  isDemo = false,
}) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Filtros
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'archived'>('active');

  // Conta selecionada para visualização do Livro-Razão (Ledger)
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [movements, setMovements] = useState<FinancialMovement[]>([]);
  const [loadingMovements, setLoadingMovements] = useState(false);

  // Modais
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [isMovementModalOpen, setIsMovementModalOpen] = useState(false);
  const [movementDirection, setMovementDirection] = useState<'inflow' | 'outflow'>('inflow');
  const [isReversalModalOpen, setIsReversalModalOpen] = useState(false);
  const [movementToReverse, setMovementToReverse] = useState<FinancialMovement | null>(null);

  // Formulário de Conta
  const [accName, setAccName] = useState('');
  const [accType, setAccType] = useState<AccountType>('checking');
  const [accColor, setAccColor] = useState('#2563EB');
  const [accSubmitting, setAccSubmitting] = useState(false);

  // Formulário de Movimentação
  const [movDescription, setMovDescription] = useState('');
  const [movAmountInput, setMovAmountInput] = useState('');
  const [movEffectiveDate, setMovEffectiveDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [movIdempotencyKey, setMovIdempotencyKey] = useState('');
  const [movSubmitting, setMovSubmitting] = useState(false);

  // Formulário de Estorno
  const [reversalReason, setReversalReason] = useState('');
  const [reversalSubmitting, setReversalSubmitting] = useState(false);

  // Estado de Reconciliação
  const [reconciling, setReconciling] = useState(false);

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 4000);
  };

  // Carrega contas
  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getUserAccounts(userId, true, isDemo);
      const validAccounts = (list || []).filter(
        (a): a is Account => !!a && typeof a.id === 'string' && a.id.trim().length > 0
      );
      setAccounts(validAccounts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar contas';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [userId, isDemo]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

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

  const handleSelectAccountForLedger = (acc: Account) => {
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
      // Atualiza conta selecionada e lista
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

  // Salvar nova conta ou atualizar conta existente
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accName.trim()) {
      setError('O nome da conta é obrigatório.');
      return;
    }
    setAccSubmitting(true);
    setError(null);
    try {
      if (editingAccount) {
        await updateAccount(
          editingAccount.id,
          userId,
          {
            name: accName.trim(),
            type: accType,
            color: accColor,
          },
          isDemo
        );
        showToast('Conta atualizada com sucesso.');
      } else {
        const payload: CreateAccountInput = {
          name: accName.trim(),
          type: accType,
          color: accColor,
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
      setError(message);
    } finally {
      setAccSubmitting(false);
    }
  };

  const resetAccountForm = () => {
    setAccName('');
    setAccType('checking');
    setAccColor('#2563EB');
  };

  const handleOpenEditAccount = (acc: Account, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingAccount(acc);
    setAccName(acc.name);
    setAccType(acc.type);
    setAccColor(acc.color || '#2563EB');
    setIsCreateModalOpen(true);
  };

  const handleToggleArchive = async (acc: Account, e: React.MouseEvent) => {
    e.stopPropagation();
    const shouldArchive = !acc.isArchived;
    const actionLabel = shouldArchive ? 'arquivar' : 'desarquivar';
    if (!window.confirm(`Deseja realmente ${actionLabel} a conta "${acc.name}"?`)) {
      return;
    }
    try {
      await archiveAccount(acc.id, userId, shouldArchive, isDemo);
      showToast(`Conta ${shouldArchive ? 'arquivada' : 'desarquivada'} com sucesso.`);
      if (selectedAccount?.id === acc.id) {
        setSelectedAccount((prev) => (prev ? { ...prev, isArchived: shouldArchive } : null));
      }
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erro ao alterar estado da conta';
      setError(message);
    }
  };

  // Gravar movimentação simples (entrada ou saída avulsa)
  const handleRecordMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount) return;

    if (!movDescription.trim()) {
      setError('A descrição da movimentação é obrigatória.');
      return;
    }

    let amountCents = 0;
    try {
      amountCents = parseBRLToCents(movAmountInput);
      validatePositiveCents(amountCents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    setMovSubmitting(true);
    setError(null);
    try {
      const activeIdemKey =
        movIdempotencyKey ||
        `idem_manual_${selectedAccount.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!movIdempotencyKey) {
        setMovIdempotencyKey(activeIdemKey);
      }

      const newMov = await recordMovement(
        {
          accountId: selectedAccount.id,
          userId,
          amountCents,
          direction: movementDirection,
          originType: 'manual_adjustment',
          originId: activeIdemKey,
          authorUid: userId,
          description: movDescription.trim(),
          effectiveDate: movEffectiveDate,
          notes: `Lançamento manual registrado no Livro-Razão v3.1`,
          idempotencyKey: activeIdemKey,
        },
        isDemo
      );

      showToast(
        `Movimentação de ${movementDirection === 'inflow' ? 'entrada' : 'saída'} gravada: ${formatCentsToBRL(
          newMov.amountCents
        )}`
      );

      setIsMovementModalOpen(false);
      setMovDescription('');
      setMovAmountInput('');
      setMovIdempotencyKey('');

      // Recarrega conta e movimentos
      await loadMovementsForAccount(selectedAccount);
      await loadAccounts();

      // Atualiza saldo local projetado na gaveta
      const delta = movementDirection === 'inflow' ? amountCents : -amountCents;
      setSelectedAccount((prev) =>
        prev
          ? {
              ...prev,
              projectedBalanceCents: prev.projectedBalanceCents + delta,
            }
          : null
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Falha ao registrar movimentação';
      setError(message);
    } finally {
      setMovSubmitting(false);
    }
  };

  // Estorno compensatório
  const handleExecuteReversal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount || !movementToReverse) return;

    if (!reversalReason.trim()) {
      setError('A justificativa do estorno é obrigatória conforme a arquitetura.');
      return;
    }

    setReversalSubmitting(true);
    setError(null);
    try {
      const res = await reverseMovement(
        selectedAccount.id,
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
      await loadMovementsForAccount(selectedAccount);
      await loadAccounts();
      setSelectedAccount((prev) =>
        prev
          ? {
              ...prev,
              projectedBalanceCents: res.newProjectedBalanceCents,
            }
          : null
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Falha ao executar estorno';
      setError(message);
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

  // Contas filtradas
  const filteredAccounts = useMemo(() => {
    if (filterStatus === 'active') return accounts.filter((a) => !a.isArchived);
    if (filterStatus === 'archived') return accounts.filter((a) => a.isArchived);
    return accounts;
  }, [accounts, filterStatus]);

  // Métricas
  const totalBalanceCents = useMemo(() => {
    return accounts
      .filter((a) => !a.isArchived)
      .reduce((acc, curr) => acc + (curr.projectedBalanceCents || 0), 0);
  }, [accounts]);

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
        return 'Poupança / Reserva';
      case 'credit':
        return 'Cartão / Linha de Crédito';
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast de Sucesso */}
      {successToast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl shadow-xl transition-all">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span className="text-sm font-medium">{successToast}</span>
        </div>
      )}

      {/* Alerta de Erro */}
      {error && (
        <div className="flex items-center justify-between p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-600" />
            <span className="text-sm font-medium">{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-rose-600 hover:text-rose-800 text-sm font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header com Identificação Canônica v3.1 */}
      <div className="bg-slate-800/90 rounded-2xl p-6 shadow-sm border border-slate-700/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
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
            Histórico imutável append-only com projeção de saldos em centavos inteiros e reconciliação contábil.
          </p>
        </div>

        <button
          onClick={() => {
            setEditingAccount(null);
            resetAccountForm();
            setIsCreateModalOpen(true);
          }}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Nova Conta Bancária
        </button>
      </div>

      {/* Cards de Métricas Consolidadas */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Saldo Total Projetado
            </span>
            <div className="p-2 bg-emerald-500/15 text-emerald-400 rounded-xl border border-emerald-500/30">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {formatCentsToBRL(totalBalanceCents)}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Soma contábil das contas ativas ({activeAccountsCount})
          </div>
        </div>

        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Contas Ativas
            </span>
            <div className="p-2 bg-indigo-500/15 text-indigo-400 rounded-xl border border-indigo-500/30">
              <Building2 className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {activeAccountsCount}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Prontas para novas movimentações
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

      {/* Barra de Filtros e Status */}
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
          onClick={loadAccounts}
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
            const isSelected = selectedAccount?.id === acc.id;
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

                  {/* Saldo Projetado */}
                  <div className="mt-5 pt-4 border-t border-slate-700/70">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      Saldo Projetado Oficial
                    </span>
                    <div
                      className={`text-2xl font-black tracking-tight mt-0.5 font-mono ${
                        acc.projectedBalanceCents >= 0
                          ? 'text-white'
                          : 'text-rose-400'
                      }`}
                    >
                      {formatCentsToBRL(acc.projectedBalanceCents)}
                    </div>
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
                    <BookOpen className="w-3.5 h-3.5" />
                    Abrir Livro-Razão →
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* PAINEL DO LIVRO DE MOVIMENTAÇÕES (FINANCIAL MOVEMENT LEDGER) */}
      {selectedAccount && (
        <div className="bg-slate-800/90 rounded-2xl border border-slate-700/80 shadow-sm overflow-hidden mt-8">
          {/* Header do Livro da Conta */}
          <div className="p-6 bg-slate-900 text-white flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-700/80">
            <div className="flex items-center gap-4">
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0 shadow-inner"
                style={{ backgroundColor: selectedAccount.color || '#2563EB' }}
              >
                {getAccountTypeIcon(selectedAccount.type)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
                    Livro-Razão da Conta
                  </span>
                  {selectedAccount.isArchived && (
                    <span className="px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded font-bold">
                      Arquivada
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-black mt-0.5 text-white">
                  {selectedAccount.name}
                </h2>
                <div className="text-xs text-slate-400 mt-0.5">
                  ID: <code className="text-slate-300">{selectedAccount.id}</code>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700">
                <span className="text-[10px] text-slate-400 uppercase font-semibold block">
                  Saldo Projetado
                </span>
                <span className="text-lg font-black text-emerald-400">
                  {formatCentsToBRL(selectedAccount.projectedBalanceCents)}
                </span>
              </div>

              <button
                onClick={handleReconcileBalance}
                disabled={reconciling}
                title="Recalcula a totalidade dos movimentos no livro para certificar consistência estrita"
                className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition-all disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`}
                />
                {reconciling ? 'Reconciliando...' : 'Reconciliar Saldo'}
              </button>

              {!selectedAccount.isArchived && (
                <>
                  <button
                    onClick={() => {
                      setMovementDirection('inflow');
                      setMovDescription('');
                      setMovAmountInput('');
                      setMovIdempotencyKey(
                        `idem_manual_${selectedAccount.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
                      );
                      setIsMovementModalOpen(true);
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
                  >
                    <ArrowDownLeft className="w-4 h-4" />
                    Nova Entrada (+)
                  </button>

                  <button
                    onClick={() => {
                      setMovementDirection('outflow');
                      setMovDescription('');
                      setMovAmountInput('');
                      setMovIdempotencyKey(
                        `idem_manual_${selectedAccount.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
                      );
                      setIsMovementModalOpen(true);
                    }}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
                  >
                    <ArrowUpRight className="w-4 h-4" />
                    Nova Saída (-)
                  </button>
                </>
              )}

              <button
                onClick={() => setSelectedAccount(null)}
                className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-all"
                title="Fechar Livro-Razão"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Banner de Garantia Arquitetural */}
          <div className="bg-blue-950/40 border-b border-blue-900/50 px-6 py-2.5 flex items-center justify-between text-xs text-blue-300">
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

          {/* Listagem de Movimentações */}
          <div className="p-6">
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
                {movements.map((mov, movIdx) => {
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
                          : 'bg-slate-900/70 border-slate-700/70 hover:border-slate-600'
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
                              {new Date(mov.effectiveDate).toLocaleDateString('pt-BR')}
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

                      {/* Lado Direito: Valor e Ação de Estorno */}
                      <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-700/60">
                        <div className="text-right">
                          <span
                            className={`text-base font-black ${
                              isInflow ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isInflow ? '+ ' : '- '}
                            {formatCentsToBRL(mov.amountCents)}
                          </span>
                          <span className="block text-[10px] text-slate-400 uppercase font-semibold">
                            Status: {mov.confirmationStatus}
                          </span>
                        </div>

                        {/* Botão de Estorno: Apenas se ainda não foi estornado e não for compensatório */}
                        {!isCompensatory && !isAlreadyReversed && !selectedAccount.isArchived && (
                          <button
                            onClick={() => {
                              setMovementToReverse(mov);
                              setReversalReason('');
                              setIsReversalModalOpen(true);
                            }}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-amber-300 bg-amber-950/50 hover:bg-amber-900/60 border border-amber-800/60 rounded-lg transition-all"
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
      )}

      {/* MODAL: CRIAR OU EDITAR CONTA */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <h3 className="text-lg font-bold text-white">
                {editingAccount ? 'Editar Conta Bancária' : 'Nova Conta Bancária'}
              </h3>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveAccount} className="space-y-4 mt-4">
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
                  <option value="savings">Poupança / Reserva</option>
                  <option value="credit">Cartão / Linha de Crédito</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Cor de Identificação
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={accColor}
                    onChange={(e) => setAccColor(e.target.value)}
                    className="w-10 h-10 rounded-xl cursor-pointer border border-slate-700 p-0.5 bg-slate-800"
                  />
                  <span className="text-xs font-mono text-slate-400">{accColor}</span>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={accSubmitting}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
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

      {/* MODAL: NOVA ENTRADA / SAÍDA NO LIVRO */}
      {isMovementModalOpen && selectedAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <div
                  className={`p-2 rounded-xl text-white ${
                    movementDirection === 'inflow' ? 'bg-emerald-600' : 'bg-rose-600'
                  }`}
                >
                  {movementDirection === 'inflow' ? (
                    <ArrowDownLeft className="w-5 h-5" />
                  ) : (
                    <ArrowUpRight className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">
                    {movementDirection === 'inflow'
                      ? 'Nova Entrada (+)'
                      : 'Nova Saída (-)'}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Conta: <strong className="text-slate-200">{selectedAccount.name}</strong>
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsMovementModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRecordMovement} className="space-y-4 mt-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Descrição da Movimentação *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Salário, Depósito, Almoço, Manutenção..."
                  value={movDescription}
                  onChange={(e) => setMovDescription(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Valor em Reais (R$) *
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-sm font-bold text-slate-400">
                    R$
                  </span>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={movAmountInput}
                    onChange={(e) => setMovAmountInput(e.target.value)}
                    className="w-full pl-11 pr-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm font-semibold text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Exemplos: 150,00 ou 1.250,50 (convertido em centavos exatos)
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Data de Débito/Crédito Efetivo *
                </label>
                <input
                  type="date"
                  required
                  value={movEffectiveDate}
                  onChange={(e) => setMovEffectiveDate(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsMovementModalOpen(false)}
                  className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={movSubmitting}
                  className={`px-5 py-2.5 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50 ${
                    movementDirection === 'inflow'
                      ? 'bg-emerald-600 hover:bg-emerald-500'
                      : 'bg-rose-600 hover:bg-rose-500'
                  }`}
                >
                  {movSubmitting ? 'Registrando...' : 'Gravar Movimentação'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ESTORNO COMPENSATÓRIO COM JUSTIFICATIVA */}
      {isReversalModalOpen && movementToReverse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-amber-800/60">
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
                onClick={() => setIsReversalModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg"
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
              <div>• Data Efetiva: {movementToReverse.effectiveDate}</div>
              <div className="mt-2 pt-2 border-t border-amber-800/60 text-[11px] text-amber-300">
                Um novo movimento de direção{' '}
                <strong>
                  {movementToReverse.direction === 'inflow' ? 'SAÍDA (-)' : 'ENTRADA (+)'}
                </strong>{' '}
                será gravado no livro para anular o impacto contábil.
              </div>
            </div>

            <form onSubmit={handleExecuteReversal} className="space-y-4">
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
                  onClick={() => setIsReversalModalOpen(false)}
                  className="px-4 py-2 text-sm font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={reversalSubmitting}
                  className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                >
                  {reversalSubmitting ? 'Gravando Estorno...' : 'Confirmar Estorno Oficial'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
