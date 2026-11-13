import React, { useEffect, useRef, useState } from 'react';
import {
  ArcElement,
  Chart,
  ChartConfiguration,
  DoughnutController,
  Legend,
  Tooltip,
} from 'chart.js';
import { Space, Transaction } from '../types/finance';
import { AcquisitionItem, AcquisitionList } from '../types/acquisitions';
import {
  formatCurrency,
  getTodayDateString,
  resolveTransactionStatus,
} from '../utils/financeEngine';

Chart.register(DoughnutController, ArcElement, Tooltip, Legend);

interface DashboardViewProps {
  transactions: Transaction[];
  spaces: Space[];
  selectedMonth: string; // YYYY-MM
  userName: string;
  userEmail: string;
  userIsAdmin?: boolean;
  activeScope: string; // 'overview' | 'individual' | space.id
  onChangeScope: (scope: string) => void;
  onOpenNewTransaction: (presetSpaceId?: string) => void;
  onOpenSpaceLedger: (space: Space) => void;
  onSelectTransaction: (tx: Transaction) => void;
  acquisitionLists?: AcquisitionList[];
  acquisitionItems?: AcquisitionItem[];
  onNavigateToLists?: (spaceId?: string) => void;
}

type DrilldownFilter =
  | { kind: 'income'; title: string }
  | { kind: 'expense'; title: string }
  | { kind: 'all'; title: string }
  | { kind: 'category'; categoryName: string; title: string };

const COLOR_HEX_MAP: Record<string, string> = {
  indigo: '#6366f1',
  emerald: '#10b981',
  rose: '#f43f5e',
  amber: '#f59e0b',
  purple: '#a855f7',
  sky: '#0ea5e9',
  teal: '#14b8a6',
};

const STATUS_BADGE: Record<
  string,
  { label: string; className: string; icon: string }
> = {
  paid: {
    label: 'Pago',
    className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    icon: 'ph-check-circle',
  },
  partially_paid: {
    label: 'Parcialmente pago',
    className: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    icon: 'ph-circle-half',
  },
  due_today: {
    label: 'Vence hoje',
    className: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    icon: 'ph-calendar-check',
  },
  upcoming: {
    label: 'A vencer',
    className: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    icon: 'ph-clock',
  },
  pending: {
    label: 'A vencer',
    className: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    icon: 'ph-clock',
  },
  forecast: {
    label: 'Previsto',
    className: 'bg-slate-700/70 text-slate-300 border-slate-600/80',
    icon: 'ph-sparkle',
  },
  overdue: {
    label: 'Vencido',
    className: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
    icon: 'ph-warning-circle',
  },
  validating: {
    label: 'Em Validação',
    className: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    icon: 'ph-hourglass-high',
  },
  rejected: {
    label: 'Recusado',
    className: 'bg-slate-700 text-slate-300 border-slate-600',
    icon: 'ph-x-circle',
  },
};

function getDashboardTxStatusBadge(tx: Transaction) {
  const eff = resolveTransactionStatus(tx);
  if (eff === 'pending') {
    const today = getTodayDateString();
    if (tx.dueDate === today) return STATUS_BADGE.due_today;
    return STATUS_BADGE.upcoming;
  }
  return STATUS_BADGE[eff] || STATUS_BADGE.upcoming;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  transactions,
  spaces,
  selectedMonth,
  userName,
  userEmail,
  userIsAdmin,
  activeScope,
  onChangeScope,
  onOpenNewTransaction,
  onOpenSpaceLedger,
  onSelectTransaction,
  acquisitionLists = [],
  acquisitionItems = [],
  onNavigateToLists,
}) => {
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<Chart | null>(null);
  const [drilldown, setDrilldown] = useState<DrilldownFilter | null>(null);

  // Trava a rolagem do body quando a gaveta de lista interativa do Dashboard está aberta
  useEffect(() => {
    if (!drilldown) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [drilldown]);

  // Filtra lançamentos do mês selecionado e do escopo ativo (Visão Geral, Individual ou Espaço Compartilhado)
  const monthTransactions = transactions.filter((tx) => {
    if (tx.invoiceMonth !== selectedMonth) return false;
    if (tx.status === 'rejected') return false;

    if (activeScope === 'overview') return true;
    if (activeScope === 'individual') return !tx.spaceId;
    return tx.spaceId === activeScope;
  });

  // Calcula valor efetivo considerando se estamos olhando um espaço específico, individual ou visão geral
  const getEffectiveAmount = (tx: Transaction): number => {
    if (activeScope === 'overview' && tx.splits && tx.splits.length > 0) {
      const myShare = tx.splits.find(
        (s) => s.email.toLowerCase() === userEmail.toLowerCase()
      );
      if (myShare) return myShare.responsibility;
    }
    return tx.amount;
  };

  const incomeTransactions = monthTransactions.filter(
    (tx) => tx.type === 'income'
  );
  const expenseTransactions = monthTransactions.filter(
    (tx) => tx.type === 'expense'
  );

  const totalIncome = incomeTransactions.reduce(
    (acc, tx) => acc + getEffectiveAmount(tx),
    0
  );

  const totalExpenses = expenseTransactions.reduce(
    (acc, tx) => acc + getEffectiveAmount(tx),
    0
  );

  const netBalance = totalIncome - totalExpenses;

  // Agrupamento de despesas por categoria para o gráfico de rosca
  const expensesByCategoryMap = new Map<
    string,
    { name: string; amount: number; color: string; icon: string; count: number }
  >();

  for (const tx of expenseTransactions) {
    const val = getEffectiveAmount(tx);
    const existing = expensesByCategoryMap.get(tx.categoryName) || {
      name: tx.categoryName,
      amount: 0,
      color: tx.categoryColor || 'indigo',
      icon: tx.categoryIcon || 'ph-tag',
      count: 0,
    };
    existing.amount = Number((existing.amount + val).toFixed(2));
    existing.count += 1;
    expensesByCategoryMap.set(tx.categoryName, existing);
  }

  const categoryBreakdown = Array.from(expensesByCategoryMap.values()).sort(
    (a, b) => b.amount - a.amount
  );

  // Ranking das 5 maiores despesas do mês no filtro selecionado
  const top5Expenses = [...expenseTransactions]
    .sort((a, b) => getEffectiveAmount(b) - getEffectiveAmount(a))
    .slice(0, 5);

  const activeSpaceObj = spaces.find((s) => s.id === activeScope);

  const isScopeFinanceEnabled =
    activeScope === 'overview' ||
    activeScope === 'individual' ||
    (activeSpaceObj
      ? !activeSpaceObj.enabledModules ||
        activeSpaceObj.enabledModules.includes('finance')
      : true);

  const isScopeAcquisitionsEnabled =
    activeScope === 'overview' ||
    (activeSpaceObj
      ? !activeSpaceObj.enabledModules ||
        activeSpaceObj.enabledModules.includes('acquisitions')
      : false);

  const isScopeOnlyAcquisitions =
    Boolean(activeSpaceObj) && !isScopeFinanceEnabled && isScopeAcquisitionsEnabled;

  // Filtra listas e itens de compras vinculados ao escopo ativo
  const filteredAcqLists = React.useMemo(() => {
    if (activeScope === 'overview' || activeScope === 'individual') {
      return acquisitionLists;
    }
    return acquisitionLists.filter(
      (l) => l.workspaceId === activeScope || l.workspaceId === `ws_${activeScope}`
    );
  }, [acquisitionLists, activeScope]);

  const filteredAcqListIds = React.useMemo(
    () => new Set(filteredAcqLists.map((l) => l.id)),
    [filteredAcqLists]
  );

  const filteredAcqItems = React.useMemo(() => {
    if (activeScope === 'overview' || activeScope === 'individual') {
      return acquisitionItems;
    }
    return acquisitionItems.filter(
      (i) =>
        i.workspaceId === activeScope ||
        i.workspaceId === `ws_${activeScope}` ||
        filteredAcqListIds.has(i.listId)
    );
  }, [acquisitionItems, activeScope, filteredAcqListIds]);

  const cartItems = React.useMemo(
    () => filteredAcqItems.filter((i) => i.stage === 'carrinho'),
    [filteredAcqItems]
  );

  const cartEstimatedTotal = React.useMemo(
    () =>
      cartItems.reduce((acc, i) => {
        const price =
          i.cartDraft?.unitPrice ||
          i.estimatedPrice ||
          i.productsHistory?.[0]?.unitPrice ||
          0;
        const qty = i.cartDraft?.quantity || 1;
        return acc + price * qty;
      }, 0),
    [cartItems]
  );

  const criticalStockItems = React.useMemo(
    () =>
      filteredAcqItems.filter(
        (i) =>
          i.listType === 'recorrente' &&
          i.stage === 'estoque' &&
          typeof i.currentStock === 'number' &&
          typeof i.minStock === 'number' &&
          i.currentStock <= i.minStock
      ),
    [filteredAcqItems]
  );

  const readyToBuyItems = React.useMemo(
    () =>
      filteredAcqItems.filter(
        (i) => i.listType === 'recorrente' && i.stage === 'comprar'
      ),
    [filteredAcqItems]
  );

  const activeGoals = React.useMemo(
    () =>
      filteredAcqItems.filter(
        (i) =>
          i.listType === 'objetivo' &&
          i.stage !== 'adquirido' &&
          typeof i.targetAmount === 'number' &&
          i.targetAmount > 0
      ),
    [filteredAcqItems]
  );

  const totalSavedInGoals = React.useMemo(
    () => activeGoals.reduce((acc, g) => acc + (g.savedAmount || 0), 0),
    [activeGoals]
  );

  const totalTargetInGoals = React.useMemo(
    () => activeGoals.reduce((acc, g) => acc + (g.targetAmount || 0), 0),
    [activeGoals]
  );

  // Lista filtrada quando o usuário clica em um card ou categoria do Dashboard
  const drilldownTransactions = React.useMemo(() => {
    if (!drilldown) return [];
    const base =
      drilldown.kind === 'income'
        ? incomeTransactions
        : drilldown.kind === 'expense'
        ? expenseTransactions
        : drilldown.kind === 'category'
        ? expenseTransactions.filter(
            (tx) => tx.categoryName === drilldown.categoryName
          )
        : monthTransactions;
    return [...base].sort((a, b) =>
      b.competenceDate.localeCompare(a.competenceDate)
    );
  }, [drilldown, monthTransactions, incomeTransactions, expenseTransactions]);

  useEffect(() => {
    if (!chartCanvasRef.current) return;

    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }

    if (categoryBreakdown.length === 0) return;

    const labels = categoryBreakdown.map((c) => c.name);
    const dataValues = categoryBreakdown.map((c) => c.amount);
    const backgroundColors = categoryBreakdown.map(
      (c) => COLOR_HEX_MAP[c.color] || '#6366f1'
    );

    const config: ChartConfiguration<'doughnut'> = {
      type: 'doughnut',
      data: {
        labels,
        datasets: [
          {
            data: dataValues,
            backgroundColor: backgroundColors,
            borderColor: '#1e293b',
            borderWidth: 3,
            hoverOffset: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        onClick: (_event, elements) => {
          if (elements && elements.length > 0) {
            const idx = elements[0].index;
            const clickedCat = categoryBreakdown[idx];
            if (clickedCat) {
              setDrilldown({
                kind: 'category',
                categoryName: clickedCat.name,
                title: `Categoria: ${clickedCat.name}`,
              });
            }
          }
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: '#0f172a',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            borderColor: '#334155',
            borderWidth: 1,
            padding: 12,
            callbacks: {
              label: (ctx) => {
                const value = Number(ctx.raw || 0);
                const pct =
                  totalExpenses > 0
                    ? ((value / totalExpenses) * 100).toFixed(1)
                    : '0.0';
                return ` ${formatCurrency(value)} (${pct}%) · Clique para listar`;
              },
            },
          },
        },
      },
    };

    chartInstanceRef.current = new Chart(chartCanvasRef.current, config);

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [selectedMonth, activeScope, transactions]);

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Saudação e Identificação do Usuário (Exibida exclusivamente no Dashboard) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-800/60 border border-slate-700/70 px-4 py-3.5 rounded-2xl">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 flex items-center justify-center font-bold text-sm shrink-0">
            {(userName || 'U').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base sm:text-lg font-bold text-white truncate">
                Olá, {userName}
              </h1>
              {userIsAdmin && (
                <span
                  data-testid="header-admin-badge"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold uppercase tracking-wide shrink-0"
                >
                  <i className="ph-fill ph-shield-check text-xs" aria-hidden="true"></i>
                  <span>Admin</span>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 truncate font-mono">
              {userEmail}
            </p>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400">
          <i className="ph-fill ph-sparkle text-indigo-400"></i>
          <span>Visão consolidada do seu painel no período {selectedMonth}</span>
        </div>
      </div>

      {/* Seletor de Escopo: Dropdown elegante no Celular (< sm) e Abas Horizontais no Desktop (sm+) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 bg-slate-800/90 border border-slate-700/80 p-2.5 sm:p-2 rounded-2xl">
        {/* Visão Mobile (Dropdown para alternar entre Visão Geral, Individual e Espaços sem apertar a tela) */}
        <div className="sm:hidden w-full space-y-2">
          <label
            htmlFor="mobile-dashboard-scope-select"
            className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between px-1"
          >
            <span>Escopo / Espaço no Painel</span>
            <span className="text-indigo-400 font-mono text-[10px]">
              {spaces.length} espaço(s)
            </span>
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 pl-3.5 flex items-center text-indigo-400">
              <i
                className={`ph-fill ${
                  activeScope === 'overview'
                    ? 'ph-squares-four'
                    : activeScope === 'individual'
                    ? 'ph-user'
                    : activeSpaceObj?.icon || 'ph-users-three'
                } text-base`}
              ></i>
            </div>
            <select
              id="mobile-dashboard-scope-select"
              aria-label="Selecionar escopo ou espaço do Dashboard"
              value={activeScope}
              onChange={(e) => onChangeScope(e.target.value)}
              className="w-full appearance-none bg-slate-900 border border-slate-700/90 focus:border-indigo-500 rounded-xl pl-10 pr-10 py-2.5 text-xs font-bold text-white outline-none transition-colors cursor-pointer"
            >
              <option value="overview">Visão Geral (Todos os lançamentos)</option>
              <option value="individual">Individual (Apenas pessoais)</option>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  Espaço: {space.name}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400">
              <i className="ph-bold ph-caret-down text-xs"></i>
            </div>
          </div>
        </div>

        {/* Visão Tablet/Desktop (Abas Horizontais) */}
        <div
          role="tablist"
          aria-label="Filtro de escopo do Dashboard"
          className="hidden sm:flex flex-wrap items-center gap-1.5"
        >
          <button
            role="tab"
            aria-selected={activeScope === 'overview'}
            onClick={() => onChangeScope('overview')}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeScope === 'overview'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
            }`}
          >
            <i className="ph-fill ph-squares-four text-sm"></i>
            <span>Visão Geral</span>
          </button>

          <button
            role="tab"
            aria-selected={activeScope === 'individual'}
            onClick={() => onChangeScope('individual')}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeScope === 'individual'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
            }`}
          >
            <i className="ph-fill ph-user text-sm"></i>
            <span>Individual</span>
          </button>

          {spaces.map((space) => (
            <button
              key={space.id}
              role="tab"
              aria-selected={activeScope === space.id}
              onClick={() => onChangeScope(space.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
                activeScope === space.id
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
              }`}
            >
              <i className={`ph-fill ${space.icon || 'ph-users-three'} text-sm`}></i>
              <span>{space.name}</span>
            </button>
          ))}
        </div>

        {activeSpaceObj && (
          <div className="flex flex-wrap items-center gap-2">
            {isScopeFinanceEnabled && (
              <button
                type="button"
                onClick={() => onOpenSpaceLedger(activeSpaceObj)}
                className="w-full sm:w-auto justify-center px-3.5 py-2.5 sm:py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                <i className="ph-fill ph-scales text-sm"></i>
                <span>Auditar Livro-Razão</span>
              </button>
            )}
            {isScopeAcquisitionsEnabled && onNavigateToLists && (
              <button
                type="button"
                onClick={() => onNavigateToLists(activeSpaceObj.id)}
                className="w-full sm:w-auto justify-center px-3.5 py-2.5 sm:py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                <i className="ph-fill ph-shopping-bag-open text-sm"></i>
                <span>Listas & Compras</span>
              </button>
            )}
          </div>
        )}
      </div>

      {isScopeFinanceEnabled && (
        <>
          {/* 3 Cards Totalizadores Interativos: Clicar abre a lista detalhada */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
        {/* Card Receitas (Clicável) */}
        <button
          type="button"
          onClick={() =>
            setDrilldown({
              kind: 'income',
              title: `Receitas no Período (${selectedMonth})`,
            })
          }
          className="text-left bg-slate-800 hover:bg-slate-800/90 border border-slate-700/80 hover:border-emerald-500/50 rounded-3xl p-5 sm:p-6 flex flex-col justify-between transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between mb-3 w-full">
            <span className="text-xs font-semibold text-slate-300">
              Receitas no Período
            </span>
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center group-hover:scale-105 transition-transform">
              <i className="ph-fill ph-arrow-circle-up-right text-xl"></i>
            </div>
          </div>
          <div className="w-full">
            <div className="text-2xl md:text-3xl font-bold text-emerald-400 font-mono tabular-nums tracking-tight">
              {formatCurrency(totalIncome)}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 mt-3 pt-2.5 border-t border-slate-700/60">
              <span>{incomeTransactions.length} lançamento(s)</span>
              <span className="text-emerald-400 font-semibold inline-flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                <span>Ver lista</span>
                <i className="ph-bold ph-caret-right"></i>
              </span>
            </div>
          </div>
        </button>

        {/* Card Despesas (Clicável) */}
        <button
          type="button"
          onClick={() =>
            setDrilldown({
              kind: 'expense',
              title: `Despesas no Período (${selectedMonth})`,
            })
          }
          className="text-left bg-slate-800 hover:bg-slate-800/90 border border-slate-700/80 hover:border-rose-500/50 rounded-3xl p-5 sm:p-6 flex flex-col justify-between transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between mb-3 w-full">
            <span className="text-xs font-semibold text-slate-300">
              Despesas no Período
            </span>
            <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center group-hover:scale-105 transition-transform">
              <i className="ph-fill ph-arrow-circle-down-right text-xl"></i>
            </div>
          </div>
          <div className="w-full">
            <div className="text-2xl md:text-3xl font-bold text-rose-400 font-mono tabular-nums tracking-tight">
              {formatCurrency(totalExpenses)}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 mt-3 pt-2.5 border-t border-slate-700/60">
              <span>{expenseTransactions.length} lançamento(s)</span>
              <span className="text-rose-400 font-semibold inline-flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                <span>Ver lista</span>
                <i className="ph-bold ph-caret-right"></i>
              </span>
            </div>
          </div>
        </button>

        {/* Card Saldo Líquido / Todos do Mês (Clicável) */}
        <button
          type="button"
          onClick={() =>
            setDrilldown({
              kind: 'all',
              title: `Todas as Movimentações (${selectedMonth})`,
            })
          }
          className="text-left bg-slate-800 hover:bg-slate-800/90 border border-slate-700/80 hover:border-indigo-500/50 rounded-3xl p-5 sm:p-6 flex flex-col justify-between transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between mb-3 w-full">
            <span className="text-xs font-semibold text-slate-300">
              Saldo Líquido do Mês
            </span>
            <div
              className={`w-10 h-10 rounded-2xl flex items-center justify-center border group-hover:scale-105 transition-transform ${
                netBalance >= 0
                  ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400'
                  : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
              }`}
            >
              <i className="ph-fill ph-scales text-xl"></i>
            </div>
          </div>
          <div className="w-full">
            <div
              className={`text-2xl md:text-3xl font-bold font-mono tabular-nums tracking-tight ${
                netBalance >= 0 ? 'text-slate-100' : 'text-rose-400'
              }`}
            >
              {formatCurrency(netBalance)}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 mt-3 pt-2.5 border-t border-slate-700/60">
              <span>{monthTransactions.length} movimentação(ões)</span>
              <span className="text-indigo-400 font-semibold inline-flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                <span>Ver extrato do filtro</span>
                <i className="ph-bold ph-caret-right"></i>
              </span>
            </div>
          </div>
        </button>
      </div>

      {/* Gráfico de Rosca (Chart.js) por Categoria + Ranking das 5 Maiores Despesas */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Gráfico de Rosca por Categoria (Clicável) */}
        <div className="lg:col-span-6 bg-slate-800 border border-slate-700/80 rounded-3xl p-5 sm:p-6 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-white">
                Distribuição por Categoria
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Toque em qualquer categoria ou fatia do gráfico para listar os lançamentos
              </p>
            </div>
            <span className="text-xs text-slate-400 font-mono tabular-nums shrink-0">
              {categoryBreakdown.length} categorias
            </span>
          </div>

          {categoryBreakdown.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-2xl bg-slate-700/50 text-slate-400 flex items-center justify-center mb-3">
                <i className="ph ph-chart-donut text-2xl"></i>
              </div>
              <p className="text-sm font-medium text-slate-300">
                Nenhuma despesa registrada neste filtro
              </p>
              <p className="text-xs text-slate-400 mt-1 mb-4">
                Adicione um lançamento para visualizar a alocação por categoria.
              </p>
              <button
                type="button"
                onClick={() =>
                  onOpenNewTransaction(
                    activeScope !== 'overview' && activeScope !== 'individual'
                      ? activeScope
                      : undefined
                  )
                }
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Novo Lançamento
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-6 items-center my-auto">
              <div className="sm:col-span-6 relative h-56 flex items-center justify-center cursor-pointer">
                <canvas
                  ref={chartCanvasRef}
                  aria-label="Gráfico de rosca de despesas por categoria"
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[11px] text-slate-400">Total Gasto</span>
                  <span className="text-sm font-bold text-white font-mono tabular-nums mt-0.5">
                    {formatCurrency(totalExpenses)}
                  </span>
                </div>
              </div>

              <div className="sm:col-span-6 space-y-2">
                {categoryBreakdown.map((cat) => {
                  const pct =
                    totalExpenses > 0
                      ? ((cat.amount / totalExpenses) * 100).toFixed(1)
                      : '0.0';
                  return (
                    <button
                      key={cat.name}
                      type="button"
                      onClick={() =>
                        setDrilldown({
                          kind: 'category',
                          categoryName: cat.name,
                          title: `Categoria: ${cat.name}`,
                        })
                      }
                      className="w-full p-2.5 rounded-2xl bg-slate-900/50 hover:bg-slate-900 border border-slate-700/50 hover:border-indigo-500/40 flex items-center justify-between gap-2 text-xs transition-all cursor-pointer group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="w-3 h-3 rounded-md shrink-0"
                          style={{
                            backgroundColor:
                              COLOR_HEX_MAP[cat.color] || '#6366f1',
                          }}
                        />
                        <div className="text-left min-w-0">
                          <span className="text-slate-100 font-semibold truncate block">
                            {cat.name}
                          </span>
                          <span className="text-[10px] text-slate-400 block">
                            {cat.count} item(ns) · {pct}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 font-mono tabular-nums">
                        <span className="text-slate-100 font-bold">
                          {formatCurrency(cat.amount)}
                        </span>
                        <i className="ph-bold ph-caret-right text-slate-400 group-hover:text-indigo-400"></i>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Ranking das 5 Maiores Despesas (Cada item abre o Detalhe do Lançamento ao clicar) */}
        <div className="lg:col-span-6 bg-slate-800 border border-slate-700/80 rounded-3xl p-5 sm:p-6 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-white">
                Ranking das 5 Maiores Despesas
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Clique em qualquer despesa para abrir os detalhes, pagar, editar ou excluir
              </p>
            </div>
            <i className="ph-fill ph-ranking text-xl text-indigo-400 shrink-0"></i>
          </div>

          {top5Expenses.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-slate-400">
                Sem despesas para exibir o ranking neste período.
              </p>
            </div>
          ) : (
            <div className="space-y-3 my-auto">
              {top5Expenses.map((tx, index) => {
                const effectiveVal = getEffectiveAmount(tx);
                const shareOfTotal =
                  totalExpenses > 0
                    ? Math.min(
                        100,
                        Math.round((effectiveVal / totalExpenses) * 100)
                      )
                    : 0;
                const st = getDashboardTxStatusBadge(tx);

                return (
                  <button
                    key={tx.id}
                    type="button"
                    onClick={() => onSelectTransaction(tx)}
                    className="w-full text-left p-3.5 rounded-2xl bg-slate-900/60 hover:bg-slate-900 border border-slate-700/60 hover:border-indigo-500/50 flex flex-col gap-2 transition-all cursor-pointer group"
                  >
                    <div className="flex items-start justify-between gap-3 w-full">
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <span className="text-xs font-mono font-bold text-slate-400 w-5 shrink-0 pt-0.5">
                          0{index + 1}.
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold text-slate-100 group-hover:text-white break-words leading-snug">
                              {tx.description}
                            </p>
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-bold ${st.className}`}
                            >
                              <i className={`ph-fill ${st.icon}`}></i>
                              <span>{st.label}</span>
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400 mt-1">
                            <span>{tx.categoryName}</span>
                            <span aria-hidden="true">·</span>
                            <span>{tx.accountName}</span>
                            {tx.spaceName && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-indigo-400 font-medium">
                                  {tx.spaceName}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="text-right shrink-0 flex items-center gap-2">
                        <div>
                          <div className="text-sm font-bold text-rose-400 font-mono tabular-nums">
                            {formatCurrency(effectiveVal)}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                            {shareOfTotal}% do total
                          </div>
                        </div>
                        <i className="ph-bold ph-caret-right text-slate-400 group-hover:text-indigo-400 text-sm"></i>
                      </div>
                    </div>

                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-rose-500 rounded-full transition-all"
                        style={{ width: `${shareOfTotal}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
        </>
      )}

      {/* Bloco de Aquisições & Listas de Compras Integradas */}
      {isScopeAcquisitionsEnabled && (
        <div className="bg-slate-800 border border-slate-700/80 rounded-3xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-700/60">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                <i className="ph-fill ph-shopping-cart text-xl"></i>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-white">
                    {activeSpaceObj ? `Compras & Listas: ${activeSpaceObj.name}` : 'Aquisições & Compras Integradas'}
                  </h2>
                  <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold">
                    {filteredAcqLists.length} lista(s)
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Estoque de despensa, cotação de metas e itens adicionados ao carrinho
                </p>
              </div>
            </div>

            {onNavigateToLists && (
              <button
                type="button"
                onClick={() => onNavigateToLists(activeSpaceObj?.id)}
                className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-2 whitespace-nowrap self-start sm:self-auto shadow-md shadow-amber-500/20 cursor-pointer transition-colors"
              >
                <i className="ph-bold ph-arrow-right"></i>
                <span>Abrir Quadro de Listas</span>
              </button>
            )}
          </div>

          {/* Cards de Métricas de Aquisições */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Carrinho de Compras */}
            <div className="bg-slate-900/60 border border-slate-700/50 rounded-2xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                <span className="font-semibold text-slate-300">No Carrinho</span>
                <span className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                  <i className="ph-bold ph-shopping-bag text-sm"></i>
                </span>
              </div>
              <div>
                <div className="text-xl font-bold font-mono text-white tabular-nums">
                  {formatCurrency(cartEstimatedTotal)}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {cartItems.length} item(ns) aguardando conferência
                </div>
              </div>
            </div>

            {/* Card 2: Estoque Crítico */}
            <div className="bg-slate-900/60 border border-slate-700/50 rounded-2xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                <span className="font-semibold text-slate-300">Despensa em Alerta</span>
                <span
                  className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                    criticalStockItems.length > 0
                      ? 'bg-rose-500/10 text-rose-400'
                      : 'bg-emerald-500/10 text-emerald-400'
                  }`}
                >
                  <i
                    className={`ph-bold ${
                      criticalStockItems.length > 0
                        ? 'ph-warning'
                        : 'ph-check-circle'
                    } text-sm`}
                  ></i>
                </span>
              </div>
              <div>
                <div
                  className={`text-xl font-bold font-mono tabular-nums ${
                    criticalStockItems.length > 0
                      ? 'text-rose-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {criticalStockItems.length} crítico(s)
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {readyToBuyItems.length} pronto(s) para compra
                </div>
              </div>
            </div>

            {/* Card 3: Metas de Poupança */}
            <div className="bg-slate-900/60 border border-slate-700/50 rounded-2xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                <span className="font-semibold text-slate-300">Metas & Poupança</span>
                <span className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                  <i className="ph-bold ph-piggy-bank text-sm"></i>
                </span>
              </div>
              <div>
                <div className="text-xl font-bold font-mono text-emerald-400 tabular-nums">
                  {formatCurrency(totalSavedInGoals)}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  de {formatCurrency(totalTargetInGoals)} ({activeGoals.length} meta(s))
                </div>
              </div>
            </div>

            {/* Card 4: Orçamento do Espaço */}
            <div className="bg-slate-900/60 border border-slate-700/50 rounded-2xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                <span className="font-semibold text-slate-300">Teto de Compras</span>
                <span className="w-7 h-7 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
                  <i className="ph-bold ph-wallet text-sm"></i>
                </span>
              </div>
              <div>
                <div className="text-xl font-bold font-mono text-amber-400 tabular-nums">
                  {activeSpaceObj?.monthlyBudget
                    ? formatCurrency(activeSpaceObj.monthlyBudget)
                    : 'Sem Teto'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {activeSpaceObj?.monthlyBudget
                    ? `Saldo previsto: ${formatCurrency(
                        Math.max(
                          0,
                          activeSpaceObj.monthlyBudget - cartEstimatedTotal
                        )
                      )}`
                    : 'Sem limite fixado'}
                </div>
              </div>
            </div>
          </div>

          {/* Itens com estoque em alerta ou no carrinho para reposição imediata */}
          {(criticalStockItems.length > 0 || cartItems.length > 0) && (
            <div className="pt-2">
              <h3 className="text-xs font-semibold text-slate-300 mb-2.5 flex items-center gap-2">
                <i className="ph-bold ph-bell-ringing text-amber-400"></i>
                <span>Atenção Imediata na Despensa & Carrinho:</span>
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {criticalStockItems.slice(0, 3).map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-xl bg-slate-900/80 border border-rose-500/30 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-bold text-white block truncate">
                        {item.name}
                      </span>
                      <span className="text-[10px] text-rose-300">
                        Estoque: {item.currentStock ?? 0} {item.unit || 'un'} (Mín:{' '}
                        {item.minStock ?? 1})
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded-lg bg-rose-500/20 text-rose-300 text-[10px] font-bold shrink-0">
                      Repor
                    </span>
                  </div>
                ))}
                {cartItems.slice(0, 3).map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-xl bg-slate-900/80 border border-indigo-500/30 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-bold text-white block truncate">
                        {item.name}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {item.cartDraft
                          ? `${item.cartDraft.quantity}x ${formatCurrency(
                              item.cartDraft.unitPrice
                            )}`
                          : 'No carrinho'}
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded-lg bg-indigo-500/20 text-indigo-300 text-[10px] font-bold shrink-0">
                      Carrinho
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal / Gaveta de Lista Interativa do Dashboard (Drill-Down de Receitas, Despesas, Saldo ou Categoria) */}
      {drilldown && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={drilldown.title}
          onClick={() => setDrilldown(null)}
        >
          <div
            className="w-full sm:max-w-2xl bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[88dvh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Cabeçalho da Lista Interativa */}
            <div className="px-5 py-4 bg-slate-800 border-b border-slate-700/80 flex items-center justify-between gap-3 shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[11px] font-bold">
                    {drilldownTransactions.length} registro(s)
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    Total:{' '}
                    <strong className="text-white">
                      {formatCurrency(
                        drilldownTransactions.reduce(
                          (acc, t) =>
                            acc +
                            (drilldown.kind === 'all'
                              ? t.type === 'income'
                                ? getEffectiveAmount(t)
                                : -getEffectiveAmount(t)
                              : getEffectiveAmount(t)),
                          0
                        )
                      )}
                    </strong>
                  </span>
                </div>
                <h3 className="text-base sm:text-lg font-bold text-white truncate mt-1">
                  {drilldown.title}
                </h3>
                <p className="text-xs text-slate-400">
                  Toque em qualquer item abaixo para abrir o detalhe completo, pagar, editar ou excluir.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setDrilldown(null)}
                aria-label="Fechar lista"
                className="w-9 h-9 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer shrink-0"
              >
                <i className="ph-bold ph-x"></i>
              </button>
            </div>

            {/* Corpo Rolável Único da Lista */}
            <div className="p-4 sm:p-5 overflow-y-auto flex-1 space-y-2.5 overscroll-contain">
              {drilldownTransactions.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  Nenhum lançamento encontrado para este recorte.
                </div>
              ) : (
                drilldownTransactions.map((tx) => {
                  const st = getDashboardTxStatusBadge(tx);
                  return (
                    <button
                      key={tx.id}
                      type="button"
                      onClick={() => onSelectTransaction(tx)}
                      className="w-full text-left p-3.5 rounded-2xl bg-slate-800/90 hover:bg-slate-800 border border-slate-700/70 hover:border-indigo-500/50 flex items-center justify-between gap-3 transition-all cursor-pointer group"
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div
                          className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                            tx.type === 'income'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : 'bg-indigo-500/15 text-indigo-400'
                          }`}
                        >
                          <i
                            className={`ph-fill ${
                              tx.categoryIcon || 'ph-tag'
                            } text-lg`}
                          ></i>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-bold text-white group-hover:text-indigo-300 transition-colors break-words">
                              {tx.description}
                            </span>
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-bold ${st.className}`}
                            >
                              <i className={`ph-fill ${st.icon}`}></i>
                              <span>{st.label}</span>
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400 mt-1">
                            <span>{tx.categoryName}</span>
                            <span>·</span>
                            <span>{tx.accountName}</span>
                            <span>·</span>
                            <span className="font-mono">Venc: {tx.dueDate}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-right font-mono tabular-nums">
                          <div
                            className={`text-sm font-bold ${
                              tx.type === 'income'
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {tx.type === 'income' ? '+' : '-'}
                            {formatCurrency(getEffectiveAmount(tx))}
                          </div>
                          <span className="text-[10px] text-indigo-400 font-sans font-semibold">
                            Ver detalhes
                          </span>
                        </div>
                        <i className="ph-bold ph-caret-right text-slate-400 group-hover:text-indigo-400"></i>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Rodapé da Lista Interativa */}
            <div className="px-5 py-3.5 bg-slate-800 border-t border-slate-700/80 flex items-center justify-between gap-3 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setDrilldown(null);
                  onOpenNewTransaction(
                    activeScope !== 'overview' && activeScope !== 'individual'
                      ? activeScope
                      : undefined
                  );
                }}
                className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <i className="ph-bold ph-plus"></i>
                <span>Novo Lançamento</span>
              </button>

              <button
                type="button"
                onClick={() => setDrilldown(null)}
                className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer"
              >
                Fechar Lista
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
