import React, { useMemo, useState } from 'react';
import {
  Account,
  ADMIN_UID,
  AdminUserSummary,
  Category,
  Space,
  Transaction,
  UserProfile,
} from '../types/finance';
import {
  buildAdminUserSummaries,
  formatCurrency,
  resolveTransactionStatus,
} from '../utils/financeEngine';
import {
  AcquisitionItem,
  AcquisitionList,
  TaxonomyGroup,
  UserProfile as AcqUserProfile,
  Workspace,
} from '../types/acquisitions';
import {
  INITIAL_ITEMS,
  INITIAL_LISTS,
  INITIAL_TAXONOMY_GROUPS,
  INITIAL_WORKSPACES,
} from '../data/acquisitionsSeedData';
import { AdminEnvironmentView } from './acquisitions/AdminEnvironmentView';

interface AdminDashboardViewProps {
  users: UserProfile[];
  accounts: Account[];
  categories: Category[];
  spaces: Space[];
  transactions: Transaction[];
  currentUser?: {
    uid: string;
    name: string;
    email: string;
    isDemo: boolean;
  };
  onSwitchToPersonalView?: () => void;
  onInspectAcquisitionWorkspace?: (workspaceId: string) => void;
}

type AdminSection = 'finance' | 'acquisitions';
type InspectTab = 'all' | 'transactions' | 'spaces' | 'accounts' | 'categories';

const STATUS_META: Record<
  string,
  { label: string; badgeClass: string; icon: string }
> = {
  paid: {
    label: 'Pago / Efetivado',
    badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    icon: 'ph-check-circle',
  },
  pending: {
    label: 'Pendente',
    badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    icon: 'ph-clock',
  },
  overdue: {
    label: 'Vencido',
    badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    icon: 'ph-warning-circle',
  },
  validating: {
    label: 'Em Validação',
    badgeClass: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    icon: 'ph-hourglass-medium',
  },
  rejected: {
    label: 'Recusado',
    badgeClass: 'bg-slate-700 text-slate-300 border-slate-600',
    icon: 'ph-x-circle',
  },
};

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  users,
  accounts,
  categories,
  spaces,
  transactions,
  currentUser,
  onSwitchToPersonalView,
  onInspectAcquisitionWorkspace,
}) => {
  const [adminSection, setAdminSection] = useState<AdminSection>('finance');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUserUid, setSelectedUserUid] = useState<string | null>(null);
  const [inspectTab, setInspectTab] = useState<InspectTab>('all');

  // Estados sincronizados do Módulo de Aquisições para administração unificada
  const [acqWorkspaces, setAcqWorkspaces] = useState<Workspace[]>(() => {
    try {
      const saved = localStorage.getItem('app_aquisicoes_workspaces');
      return saved ? JSON.parse(saved) : INITIAL_WORKSPACES;
    } catch {
      return INITIAL_WORKSPACES;
    }
  });

  const [acqLists] = useState<AcquisitionList[]>(() => {
    try {
      const saved = localStorage.getItem('app_aquisicoes_lists');
      return saved ? JSON.parse(saved) : INITIAL_LISTS;
    } catch {
      return INITIAL_LISTS;
    }
  });

  const [acqItems] = useState<AcquisitionItem[]>(() => {
    try {
      const saved = localStorage.getItem('app_aquisicoes_items');
      return saved ? JSON.parse(saved) : INITIAL_ITEMS;
    } catch {
      return INITIAL_ITEMS;
    }
  });

  const [acqTaxonomy] = useState<TaxonomyGroup[]>(() => {
    try {
      const saved = localStorage.getItem('app_aquisicoes_taxonomy');
      return saved ? JSON.parse(saved) : INITIAL_TAXONOMY_GROUPS;
    } catch {
      return INITIAL_TAXONOMY_GROUPS;
    }
  });

  const acqAdminUser: AcqUserProfile = {
    uid: currentUser?.uid || ADMIN_UID,
    email: currentUser?.email || 'kenielcalixtonkenny@gmail.com',
    displayName: currentUser?.name || 'Administrador Master',
    isAdmin: true,
  };

  const handleDeleteAcqWorkspace = (workspaceId: string) => {
    setAcqWorkspaces((prev) => {
      const next = prev.filter((w) => w.id !== workspaceId);
      localStorage.setItem('app_aquisicoes_workspaces', JSON.stringify(next));
      return next;
    });
  };

  const handleGrantAdminAccessToAcqWorkspace = (workspaceId: string) => {
    const adminEmail = acqAdminUser.email.toLowerCase();
    setAcqWorkspaces((prev) => {
      const next = prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const acceptedEmails = Array.from(
          new Set([...ws.acceptedMemberEmails, adminEmail])
        );
        return {
          ...ws,
          acceptedMemberEmails: acceptedEmails,
        };
      });
      localStorage.setItem('app_aquisicoes_workspaces', JSON.stringify(next));
      return next;
    });
  };

  const userSummaries = useMemo(
    () =>
      buildAdminUserSummaries({
        users,
        accounts,
        categories,
        spaces,
        transactions,
      }),
    [users, accounts, categories, spaces, transactions]
  );

  const filteredUsers = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return userSummaries;
    return userSummaries.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q)
    );
  }, [userSummaries, searchTerm]);

  const activeUser: AdminUserSummary | null = useMemo(() => {
    if (selectedUserUid) {
      const found = userSummaries.find((u) => u.uid === selectedUserUid);
      if (found) return found;
    }
    return filteredUsers[0] || userSummaries[0] || null;
  }, [selectedUserUid, filteredUsers, userSummaries]);

  const totalSystemRecords =
    accounts.length + categories.length + spaces.length + transactions.length;

  return (
    <div className="space-y-6">
      {/* Cabeçalho Unificado da Central Administrativa */}
      <div className="bg-gradient-to-r from-indigo-950/90 via-slate-800/95 to-slate-800/90 border border-indigo-500/40 rounded-3xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                data-testid="admin-view-badge"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm"
              >
                <i className="ph-fill ph-shield-check text-sm" aria-hidden="true"></i>
                Central Administrativa Unificada
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-mono text-indigo-300 bg-indigo-500/15 border border-indigo-500/30">
                Master UID: {ADMIN_UID}
              </span>
            </div>
            <h2 className="text-xl md:text-2xl font-bold text-white tracking-tight">
              Governança Global: Finanças, Aquisições & Firebase Deploy
            </h2>
            <p className="text-xs md:text-sm text-slate-300 max-w-3xl">
              Audite usuários, lançamentos e espaços do módulo financeiro ou gerencie os espaços de compras, listas, sincronização com o Firestore e comandos de deploy do Firebase Hosting em um único painel.
            </p>
          </div>

          {onSwitchToPersonalView && (
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={onSwitchToPersonalView}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600/80 text-xs font-semibold text-slate-200 transition-colors flex items-center gap-2 cursor-pointer whitespace-nowrap"
              >
                <i className="ph-bold ph-wallet text-indigo-400 text-sm" aria-hidden="true"></i>
                <span>Voltar ao Painel Pessoal</span>
              </button>
            </div>
          )}
        </div>

        {/* Seletor de Domínio Administrativo (Finanças vs. Aquisições & Deploy) */}
        <div className="pt-4 border-t border-slate-700/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 bg-slate-900/90 border border-slate-700/80 p-1.5 rounded-2xl">
            <button
              type="button"
              onClick={() => setAdminSection('finance')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                adminSection === 'finance'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <i className="ph-fill ph-chart-pie-slice text-sm" aria-hidden="true"></i>
              <span>Auditoria Financeira & Usuários ({userSummaries.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setAdminSection('acquisitions')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                adminSection === 'acquisitions'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <i className="ph-fill ph-shopping-cart text-sm" aria-hidden="true"></i>
              <span>Gestão de Aquisições, Firestore Sync & Deploy ({acqWorkspaces.length})</span>
            </button>
          </div>

          <div className="text-[11px] text-slate-400 font-mono">
            Projeto ativo: <strong className="text-emerald-400">teste-beta-fin-e-list</strong>
          </div>
        </div>
      </div>

      {/* SEÇÃO 2: GESTÃO DE AQUISIÇÕES, FIRESTORE SYNC & DEPLOY */}
      {adminSection === 'acquisitions' && (
        <AdminEnvironmentView
          currentUser={acqAdminUser}
          workspaces={acqWorkspaces}
          lists={acqLists}
          items={acqItems}
          taxonomyGroups={acqTaxonomy}
          onSwitchToAdmin={() => {}}
          onSelectWorkspace={(wsId) => {
            localStorage.setItem('app_aquisicoes_selected_ws', wsId);
            if (onInspectAcquisitionWorkspace) {
              onInspectAcquisitionWorkspace(wsId);
            }
          }}
          onDeleteWorkspace={handleDeleteAcqWorkspace}
          onGrantAdminAccessToWorkspace={handleGrantAdminAccessToAcqWorkspace}
          onRemoteWorkspacesLoaded={(remoteWs) => {
            setAcqWorkspaces((prev) => {
              const byId = new Map(prev.map((w) => [w.id, w]));
              remoteWs.forEach((rw) => byId.set(rw.id, rw));
              const merged = Array.from(byId.values());
              localStorage.setItem('app_aquisicoes_workspaces', JSON.stringify(merged));
              return merged;
            });
          }}
        />
      )}

      {/* SEÇÃO 1: AUDITORIA FINANCEIRA & USUÁRIOS */}
      {adminSection === 'finance' && (
        <>
          {/* KPIs Globais do Banco de Dados Financeiro */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Usuários no Firestore</span>
                <i className="ph-fill ph-users-three text-indigo-400 text-base" aria-hidden="true"></i>
              </div>
              <div className="text-2xl font-bold text-white font-mono tabular-nums">
                {userSummaries.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Contas mapeadas na base
              </div>
            </div>

            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Total de Registros</span>
                <i className="ph-fill ph-database text-emerald-400 text-base" aria-hidden="true"></i>
              </div>
              <div className="text-2xl font-bold text-emerald-400 font-mono tabular-nums">
                {totalSystemRecords}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Documentos ativos nas coleções
              </div>
            </div>

            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Espaços Compartilhados</span>
                <i className="ph-fill ph-scales text-purple-400 text-base" aria-hidden="true"></i>
              </div>
              <div className="text-2xl font-bold text-purple-300 font-mono tabular-nums">
                {spaces.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Grupos de rateio criados
              </div>
            </div>

            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Transações Totais</span>
                <i className="ph-fill ph-list-checks text-amber-400 text-base" aria-hidden="true"></i>
              </div>
              <div className="text-2xl font-bold text-amber-300 font-mono tabular-nums">
                {transactions.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Lançamentos em todas as contas
              </div>
            </div>
          </div>

          {/* Tabela / Lista de Todos os Usuários do Firestore */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-3xl overflow-hidden shadow-lg">
            <div className="p-6 border-b border-slate-700/80 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <i className="ph-fill ph-users text-indigo-400" aria-hidden="true"></i>
                  <span>Usuários Cadastrados no Banco de Dados ({filteredUsers.length})</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Clique em qualquer usuário da lista abaixo para inspecionar todos os dados gerados por ele.
                </p>
              </div>

              <div className="relative w-full md:w-80">
                <i
                  className="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                ></i>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar por e-mail, nome ou UID..."
                  aria-label="Buscar usuário por e-mail, nome ou UID"
                  className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {/* VISÃO MOBILE DE USUÁRIOS */}
            <div className="md:hidden divide-y divide-slate-700/60">
              {filteredUsers.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  Nenhum usuário encontrado com o filtro informado.
                </div>
              ) : (
                filteredUsers.map((u) => {
                  const isSelected = activeUser?.uid === u.uid;
                  return (
                    <div
                      key={u.uid}
                      onClick={() => setSelectedUserUid(u.uid)}
                      className={`p-4 space-y-3 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-indigo-600/15'
                          : 'hover:bg-slate-700/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${
                              u.isAdminUser
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                            }`}
                          >
                            {u.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-white text-sm truncate">
                                {u.name}
                              </span>
                              {u.isAdminUser && (
                                <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                  Admin
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-300 font-mono truncate">
                              {u.email}
                            </div>
                            <div className="text-[10px] text-slate-400 font-mono truncate">
                              UID: {u.uid}
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedUserUid(u.uid);
                          }}
                          aria-label={`Ver dados de ${u.email}`}
                          className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer inline-flex items-center gap-1 shrink-0 ${
                            isSelected
                              ? 'bg-indigo-600 text-white shadow-sm'
                              : 'bg-slate-900 hover:bg-slate-700 text-slate-200 border border-slate-700'
                          }`}
                        >
                          <i className="ph-bold ph-eye text-xs" aria-hidden="true"></i>
                          <span>{isSelected ? 'Ativo' : 'Ver Dados'}</span>
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-300 font-mono pt-1">
                        <span className="inline-flex items-center gap-1 text-slate-400">
                          <i className="ph ph-calendar-blank" aria-hidden="true"></i>
                          <span>Criado: {u.createdAtFormatted}</span>
                        </span>
                        <span className="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-700 text-white font-bold">
                          {u.totalRecords} registros
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 p-2.5 rounded-2xl bg-slate-900/70 border border-slate-700/60 text-center font-mono text-xs">
                        <div>
                          <span className="text-[10px] text-slate-400 block">Contas</span>
                          <span className="font-bold text-slate-200">{u.accountsCount}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block">Espaços</span>
                          <span className="font-bold text-purple-300">{u.spacesCount}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-slate-400 block">Transações</span>
                          <span className="font-bold text-emerald-300">{u.transactionsCount}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* VISÃO DESKTOP DE USUÁRIOS */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-700/80 text-[11px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-900/50">
                    <th className="py-3.5 px-6">Usuário / E-mail</th>
                    <th className="py-3.5 px-4">Data de Criação da Conta</th>
                    <th className="py-3.5 px-4 text-center">Contas</th>
                    <th className="py-3.5 px-4 text-center">Espaços</th>
                    <th className="py-3.5 px-4 text-center">Transações</th>
                    <th className="py-3.5 px-4 text-center">Total de Registros</th>
                    <th className="py-3.5 px-6 text-right">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60 text-sm">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400 text-xs">
                        Nenhum usuário encontrado com o filtro informado.
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => {
                      const isSelected = activeUser?.uid === u.uid;
                      return (
                        <tr
                          key={u.uid}
                          onClick={() => setSelectedUserUid(u.uid)}
                          className={`transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-indigo-600/15 hover:bg-indigo-600/20'
                              : 'hover:bg-slate-700/40'
                          }`}
                        >
                          <td className="py-4 px-6">
                            <div className="flex items-center gap-3">
                              <div
                                className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${
                                  u.isAdminUser
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                    : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                                }`}
                              >
                                {u.name.charAt(0).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-semibold text-white truncate">
                                    {u.name}
                                  </span>
                                  {u.isAdminUser && (
                                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                      Admin
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-300 font-mono truncate">
                                  {u.email}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono truncate">
                                  UID: {u.uid}
                                </div>
                              </div>
                            </div>
                          </td>

                          <td className="py-4 px-4 whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5 text-xs text-slate-200 font-mono">
                              <i
                                className="ph ph-calendar-blank text-slate-400"
                                aria-hidden="true"
                              ></i>
                              <span>{u.createdAtFormatted}</span>
                            </div>
                          </td>

                          <td className="py-4 px-4 text-center font-mono text-xs text-slate-200 tabular-nums">
                            {u.accountsCount}
                          </td>

                          <td className="py-4 px-4 text-center font-mono text-xs text-purple-300 tabular-nums">
                            {u.spacesCount}
                          </td>

                          <td className="py-4 px-4 text-center font-mono text-xs text-emerald-300 tabular-nums">
                            {u.transactionsCount}
                          </td>

                          <td className="py-4 px-4 text-center">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-bold font-mono bg-slate-900 border border-slate-700 text-white tabular-nums">
                              {u.totalRecords} registros
                            </span>
                          </td>

                          <td className="py-4 px-6 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedUserUid(u.uid);
                              }}
                              aria-label={`Ver dados de ${u.email}`}
                              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer inline-flex items-center gap-1.5 ${
                                isSelected
                                  ? 'bg-indigo-600 text-white shadow-sm'
                                  : 'bg-slate-900 hover:bg-slate-700 text-slate-200 border border-slate-700'
                              }`}
                            >
                              <i className="ph-bold ph-eye text-xs" aria-hidden="true"></i>
                              <span>{isSelected ? 'Inspecionando' : 'Ver Dados'}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Painel Detalhado de Inspeção do Usuário Selecionado */}
          {activeUser && (
            <div
              data-testid="admin-user-inspector"
              className="bg-slate-800/90 border border-slate-700/80 rounded-3xl p-4 sm:p-6 space-y-6 shadow-xl"
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-700/80">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="px-2.5 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-semibold">
                      Inspeção de Usuário
                    </span>
                    {activeUser.isAdminUser && (
                      <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase">
                        Administrador
                      </span>
                    )}
                    <span className="text-xs text-slate-400 font-mono">
                      Criado em: {activeUser.createdAtFormatted}
                    </span>
                  </div>
                  <h3 className="text-lg sm:text-xl font-bold text-white break-words">
                    {activeUser.name}{' '}
                    <span className="text-xs sm:text-sm font-normal text-slate-400 font-mono break-all">
                      ({activeUser.email})
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 font-mono break-all">
                    UID Firestore: {activeUser.uid}
                  </p>
                </div>

                {/* Resumo Financeiro do Usuário Inspecionado */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 shrink-0">
                  <div className="px-3.5 py-2.5 rounded-2xl bg-slate-900/90 border border-slate-700/80 flex sm:block items-center justify-between">
                    <div className="text-[11px] text-slate-400">Registros Criados</div>
                    <div className="text-sm font-bold text-white font-mono tabular-nums sm:mt-0.5">
                      {activeUser.totalRecords} itens
                    </div>
                  </div>
                  <div className="px-3.5 py-2.5 rounded-2xl bg-slate-900/90 border border-slate-700/80 flex sm:block items-center justify-between">
                    <div className="text-[11px] text-slate-400">Receitas do Usuário</div>
                    <div className="text-sm font-bold text-emerald-400 font-mono tabular-nums sm:mt-0.5">
                      {formatCurrency(activeUser.totalIncome)}
                    </div>
                  </div>
                  <div className="px-3.5 py-2.5 rounded-2xl bg-slate-900/90 border border-slate-700/80 flex sm:block items-center justify-between">
                    <div className="text-[11px] text-slate-400">Despesas do Usuário</div>
                    <div className="text-sm font-bold text-rose-400 font-mono tabular-nums sm:mt-0.5">
                      {formatCurrency(activeUser.totalExpenses)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Abas de Filtro dos Dados Gerados pelo Usuário */}
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    {
                      id: 'all',
                      label: `Visão Completa (${activeUser.totalRecords})`,
                      icon: 'ph-squares-four',
                    },
                    {
                      id: 'transactions',
                      label: `Transações (${activeUser.transactionsCount})`,
                      icon: 'ph-list-checks',
                    },
                    {
                      id: 'spaces',
                      label: `Espaços (${activeUser.spacesCount})`,
                      icon: 'ph-scales',
                    },
                    {
                      id: 'accounts',
                      label: `Contas & Cartões (${activeUser.accountsCount})`,
                      icon: 'ph-credit-card',
                    },
                    {
                      id: 'categories',
                      label: `Categorias (${activeUser.categoriesCount})`,
                      icon: 'ph-tag',
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setInspectTab(tab.id)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                      inspectTab === tab.id
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-slate-900 text-slate-300 hover:text-white border border-slate-700/80'
                    }`}
                  >
                    <i className={`ph-fill ${tab.icon}`} aria-hidden="true"></i>
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* Seção 1: Transações Geradas pelo Usuário */}
              {(inspectTab === 'all' || inspectTab === 'transactions') && (
                <div className="space-y-3">
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <i className="ph-fill ph-list-checks text-emerald-400" aria-hidden="true"></i>
                    <span>
                      Transações Criadas por {activeUser.name} ({activeUser.transactions.length})
                    </span>
                  </h4>

                  {activeUser.transactions.length === 0 ? (
                    <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-700/60 text-xs text-slate-400 text-center">
                      Nenhuma transação registrada por este usuário.
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-slate-700/80 bg-slate-900/60 overflow-hidden">
                      <div className="md:hidden divide-y divide-slate-800">
                        {activeUser.transactions.map((tx) => {
                          const effectiveStatus = resolveTransactionStatus(tx);
                          const st = STATUS_META[effectiveStatus] || STATUS_META.pending;
                          return (
                            <div key={tx.id} className="p-3.5 space-y-2 text-xs">
                              <div className="flex items-start justify-between gap-2">
                                <span className="font-bold text-white break-words">
                                  {tx.description}
                                </span>
                                <span
                                  className={`font-mono font-bold tabular-nums shrink-0 ${
                                    tx.type === 'income'
                                      ? 'text-emerald-400'
                                      : 'text-rose-400'
                                  }`}
                                >
                                  {tx.type === 'income' ? '+' : '-'}{' '}
                                  {formatCurrency(tx.amount)}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                                <span>{tx.categoryName}</span>
                                <span>·</span>
                                <span>{tx.accountName}</span>
                                <span>·</span>
                                <span>{tx.spaceName || 'Individual'}</span>
                              </div>
                              <div className="flex items-center justify-between pt-1">
                                <span className="font-mono text-[11px] text-slate-400">
                                  Venc: {tx.dueDate}
                                </span>
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${st.badgeClass}`}
                                >
                                  <i className={`ph-fill ${st.icon}`} aria-hidden="true"></i>
                                  <span>{st.label}</span>
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-slate-700/80 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                              <th className="py-3 px-4">Descrição</th>
                              <th className="py-3 px-4">Categoria / Conta</th>
                              <th className="py-3 px-4">Espaço</th>
                              <th className="py-3 px-4">Vencimento</th>
                              <th className="py-3 px-4">Status</th>
                              <th className="py-3 px-4 text-right">Valor</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800 text-xs">
                            {activeUser.transactions.map((tx) => {
                              const effectiveStatus = resolveTransactionStatus(tx);
                              const st = STATUS_META[effectiveStatus] || STATUS_META.pending;
                              return (
                                <tr key={tx.id} className="hover:bg-slate-800/50">
                                  <td className="py-3 px-4 font-semibold text-white">
                                    {tx.description}
                                  </td>
                                  <td className="py-3 px-4 text-slate-300">
                                    {tx.categoryName} · {tx.accountName}
                                  </td>
                                  <td className="py-3 px-4 text-slate-300">
                                    {tx.spaceName || 'Individual'}
                                  </td>
                                  <td className="py-3 px-4 font-mono text-slate-300">
                                    {tx.dueDate}
                                  </td>
                                  <td className="py-3 px-4">
                                    <span
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${st.badgeClass}`}
                                    >
                                      <i className={`ph-fill ${st.icon}`} aria-hidden="true"></i>
                                      <span>{st.label}</span>
                                    </span>
                                  </td>
                                  <td
                                    className={`py-3 px-4 text-right font-mono font-bold tabular-nums ${
                                      tx.type === 'income' ? 'text-emerald-400' : 'text-rose-400'
                                    }`}
                                  >
                                    {tx.type === 'income' ? '+' : '-'} {formatCurrency(tx.amount)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Seção 2: Espaços Compartilhados Criados pelo Usuário */}
              {(inspectTab === 'all' || inspectTab === 'spaces') && (
                <div className="space-y-3">
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <i className="ph-fill ph-scales text-purple-400" aria-hidden="true"></i>
                    <span>
                      Espaços Compartilhados Criados por {activeUser.name} ({activeUser.spaces.length})
                    </span>
                  </h4>

                  {activeUser.spaces.length === 0 ? (
                    <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-700/60 text-xs text-slate-400 text-center">
                      Nenhum espaço compartilhado criado por este usuário.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {activeUser.spaces.map((sp) => (
                        <div
                          key={sp.id}
                          className="p-4 rounded-2xl bg-slate-900/70 border border-slate-700/80 flex flex-col justify-between gap-3"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <h5 className="text-sm font-bold text-white">{sp.name}</h5>
                              <span className="text-[11px] font-mono text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded-lg border border-purple-500/30">
                                {sp.participants.length} participantes
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-1">{sp.description}</p>
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono truncate">
                            Membros: {sp.participantEmails.join(', ')}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Seção 3: Contas Bancárias e Cartões Criados pelo Usuário */}
              {(inspectTab === 'all' || inspectTab === 'accounts') && (
                <div className="space-y-3">
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <i className="ph-fill ph-credit-card text-indigo-400" aria-hidden="true"></i>
                    <span>
                      Contas e Cartões de {activeUser.name} ({activeUser.accounts.length})
                    </span>
                  </h4>

                  {activeUser.accounts.length === 0 ? (
                    <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-700/60 text-xs text-slate-400 text-center">
                      Nenhuma conta ou cartão registrado por este usuário.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {activeUser.accounts.map((acc) => (
                        <div
                          key={acc.id}
                          className="p-4 rounded-2xl bg-slate-900/70 border border-slate-700/80 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-white truncate">
                              {acc.name}
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                                acc.type === 'credit'
                                  ? 'bg-purple-500/20 text-purple-300'
                                  : 'bg-indigo-500/20 text-indigo-300'
                              }`}
                            >
                              {acc.type === 'credit' ? 'Cartão' : 'Conta'}
                            </span>
                          </div>
                          <div className="text-sm font-bold font-mono text-slate-200 tabular-nums">
                            {acc.type === 'credit'
                              ? `Limite: ${formatCurrency(acc.limit)}`
                              : `Saldo: ${formatCurrency(acc.balance)}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Seção 4: Categorias do Usuário */}
              {(inspectTab === 'all' || inspectTab === 'categories') && (
                <div className="space-y-3">
                  <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <i className="ph-fill ph-tag text-amber-400" aria-hidden="true"></i>
                    <span>
                      Categorias de {activeUser.name} ({activeUser.categories.length})
                    </span>
                  </h4>

                  {activeUser.categories.length === 0 ? (
                    <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-700/60 text-xs text-slate-400 text-center">
                      Nenhuma categoria personalizada encontrada para este usuário.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {activeUser.categories.map((cat) => (
                        <span
                          key={cat.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/80 border border-slate-700 text-xs text-slate-200"
                        >
                          <i className={`ph-fill ${cat.icon} text-indigo-400`} aria-hidden="true"></i>
                          <span>{cat.name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
