import React, { useEffect, useState } from 'react';
import {
  AcquisitionItem,
  AcquisitionList,
  TaxonomyGroup,
  UserProfile,
  Workspace,
} from '../../types/acquisitions';
import {
  ADMIN_USER_UID,
  fetchAllUsersFromFirestore,
  fetchAllWorkspacesFromFirestore,
  firebaseConfig,
  syncAllDataToFirestore,
  upsertUserDocument,
} from '../../services/acquisitionsFirebase';
import { formatCurrencyBRL } from '../../utils/stateMachine';
import {
  ArrowRight,
  Check,
  CloudUpload,
  Copy,
  Database,
  FolderKanban,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
} from 'lucide-react';

interface AdminEnvironmentViewProps {
  currentUser: UserProfile;
  workspaces: Workspace[];
  lists: AcquisitionList[];
  items: AcquisitionItem[];
  taxonomyGroups: TaxonomyGroup[];
  onSwitchToAdmin: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onGrantAdminAccessToWorkspace: (workspaceId: string) => void;
  onRemoteWorkspacesLoaded?: (remoteWorkspaces: Workspace[]) => void;
}

const FIREBASE_JSON_CONTENT = `{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  },
  "firestore": { "rules": "firestore.rules" },
  "storage": { "rules": "storage.rules" }
}`;

const FIREBASERC_CONTENT = `{
  "projects": {
    "default": "teste-beta-fin-e-list"
  }
}`;

const FIRESTORE_RULES_CONTENT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() { return request.auth != null; }
    function isSystemAdmin() {
      return isSignedIn() && (
        request.auth.uid == 'GOgPDiSr6UP3VGR0zRcdFlgDseY2' ||
        request.auth.uid == 'cFlLuuez1TMfNhsNFKGpjQ8qYSG3' ||
        request.auth.uid == 'wAUPqTjSmOMV3S8XlaLlv46QK463'
      );
    }
    match /users/{userId} {
      allow read: if isSignedIn();
      allow write: if isSystemAdmin() || (isSignedIn() && request.auth.uid == userId);
    }
    match /workspaces/{workspaceId} {
      allow read, write: if isSystemAdmin() || isSignedIn();
    }
    match /lists/{listId} {
      allow read, write: if isSystemAdmin() || isSignedIn();
    }
    match /items/{itemId} {
      allow read, write: if isSystemAdmin() || isSignedIn();
      match /products/{productId} {
        allow read, write: if isSystemAdmin() || isSignedIn();
      }
    }
    match /taxonomy/{groupId} {
      allow read: if true;
      allow write: if isSystemAdmin() || isSignedIn();
    }
  }
}`;

export const AdminEnvironmentView: React.FC<AdminEnvironmentViewProps> = ({
  currentUser,
  workspaces,
  lists,
  items,
  taxonomyGroups,
  onSwitchToAdmin,
  onSelectWorkspace,
  onDeleteWorkspace,
  onGrantAdminAccessToWorkspace,
  onRemoteWorkspacesLoaded,
}) => {
  const isUserAdmin =
    currentUser.uid === ADMIN_USER_UID || Boolean(currentUser.isAdmin);

  const [activeTab, setActiveTab] = useState<
    'espacos' | 'usuarios' | 'hosting'
  >('espacos');

  // Registered users list (merged from workspaces + Firestore + localStorage)
  const [registeredUsers, setRegisteredUsers] = useState<UserProfile[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_admin_users');
    if (saved) return JSON.parse(saved);
    return [
      {
        uid: ADMIN_USER_UID,
        email: 'kenielcalixtonkenny@gmail.com',
        displayName: 'Keniel Calixto',
        isAdmin: true,
      },
      {
        uid: 'uid_marina_silva',
        email: 'marina.silva@familia.com',
        displayName: 'Marina Silva',
        isAdmin: false,
      },
      {
        uid: 'uid_lucas_ferreira',
        email: 'lucas.ferreira@amigos.com',
        displayName: 'Lucas Ferreira',
        isAdmin: false,
      },
      {
        uid: 'uid_bianca_rocha',
        email: 'bianca.rocha@estudio.com',
        displayName: 'Bianca Rocha',
        isAdmin: false,
      },
    ];
  });

  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserUid, setNewUserUid] = useState('');
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(
      'app_aquisicoes_admin_users',
      JSON.stringify(registeredUsers)
    );
  }, [registeredUsers]);

  // Attempt to load users & workspaces from Firestore on mount for Admin
  useEffect(() => {
    if (!isUserAdmin) return;
    fetchAllUsersFromFirestore().then((remoteUsers) => {
      if (remoteUsers.length > 0) {
        setRegisteredUsers((prev) => {
          const byEmail = new Map(prev.map((u) => [u.email.toLowerCase(), u]));
          remoteUsers.forEach((ru) =>
            byEmail.set(ru.email.toLowerCase(), ru)
          );
          return Array.from(byEmail.values());
        });
      }
    });
  }, [isUserAdmin]);

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedBlock(id);
    setTimeout(() => setCopiedBlock(null), 2000);
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserName.trim() || !newUserEmail.trim()) return;
    const cleanEmail = newUserEmail.trim().toLowerCase();
    const uid =
      newUserUid.trim() ||
      (cleanEmail === 'kenielcalixtonkenny@gmail.com'
        ? ADMIN_USER_UID
        : `uid_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`);

    const newProfile: UserProfile = {
      uid,
      email: cleanEmail,
      displayName: newUserName.trim(),
      isAdmin: uid === ADMIN_USER_UID,
    };

    await upsertUserDocument(newProfile);
    setRegisteredUsers((prev) => {
      const filtered = prev.filter((u) => u.email.toLowerCase() !== cleanEmail);
      return [newProfile, ...filtered];
    });
    setNewUserName('');
    setNewUserEmail('');
    setNewUserUid('');
    setSyncStatus(`Usuário ${newProfile.displayName} (${newProfile.uid}) registrado.`);
  };

  const handleSyncToFirestore = async () => {
    setIsSyncing(true);
    setSyncStatus('Sincronizando dados com o Firestore (app-de-aquiscao---beta-teste)...');
    try {
      const { syncedCount } = await syncAllDataToFirestore({
        users: registeredUsers,
        workspaces,
        lists,
        items,
        taxonomyGroups,
      });
      setSyncStatus(
        `Sincronização concluída! ${syncedCount} registros enviados para o projeto ${firebaseConfig.projectId}.`
      );
    } catch {
      setSyncStatus(
        'Dados preparados localmente. Verifique as regras do Firestore para escrita direta.'
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePullFromFirestore = async () => {
    setIsSyncing(true);
    setSyncStatus('Buscando espaços e usuários no Firestore...');
    try {
      const [remoteUsers, remoteWorkspaces] = await Promise.all([
        fetchAllUsersFromFirestore(),
        fetchAllWorkspacesFromFirestore(),
      ]);
      if (remoteUsers.length > 0) {
        setRegisteredUsers((prev) => {
          const byEmail = new Map(prev.map((u) => [u.email.toLowerCase(), u]));
          remoteUsers.forEach((ru) => byEmail.set(ru.email.toLowerCase(), ru));
          return Array.from(byEmail.values());
        });
      }
      if (remoteWorkspaces.length > 0 && onRemoteWorkspacesLoaded) {
        onRemoteWorkspacesLoaded(remoteWorkspaces);
      }
      setSyncStatus(
        `Consulta concluída no projeto ${firebaseConfig.projectId} (${remoteWorkspaces.length} espaços e ${remoteUsers.length} usuários no banco remoto).`
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const totalPlatformBudget = workspaces.reduce(
    (sum, w) => sum + (w.monthlyBudget ?? 0),
    0
  );

  // Guard screen if current session is not the Admin UID
  if (!isUserAdmin) {
    return (
      <div className="max-w-xl mx-auto py-12">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center space-y-5">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 font-display">
              Acesso Restrito ao Administrador
            </h1>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Este painel é exclusivo para o administrador do sistema configurado com o ID{' '}
              <code className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                {ADMIN_USER_UID}
              </code>
              . Sua sessão atual está identificada como{' '}
              <strong>{currentUser.email}</strong>.
            </p>
          </div>
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              type="button"
              onClick={onSwitchToAdmin}
              className="min-h-[42px] px-5 py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-2 cursor-pointer"
            >
              <KeyRound className="w-4 h-4" />
              <span>Autenticar como Admin ({ADMIN_USER_UID.slice(0, 8)}…)</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header do Ambiente Admin */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 dark:border-slate-800 pb-6">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-indigo-600 dark:text-indigo-400">
            <ShieldCheck className="w-4 h-4" />
            <span>Ambiente Administrativo · Projeto: {firebaseConfig.projectId}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">
              Admin UID: {ADMIN_USER_UID}
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-display">
            Painel do Administrador
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
            Gerencie todos os espaços de trabalho da plataforma, controle contas de usuários, sincronize o banco Firestore e prepare o envio para o Firebase Hosting.
          </p>
        </div>

        {/* Segmented Admin Tabs */}
        <div
          role="tablist"
          aria-label="Abas do Ambiente Admin"
          className="flex flex-wrap items-center gap-1.5 p-1.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shrink-0"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'espacos'}
            onClick={() => setActiveTab('espacos')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeTab === 'espacos'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <FolderKanban className="w-3.5 h-3.5" />
            <span>Todos os Espaços ({workspaces.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'usuarios'}
            onClick={() => setActiveTab('usuarios')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeTab === 'usuarios'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Usuários & Banco ({registeredUsers.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'hosting'}
            onClick={() => setActiveTab('hosting')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeTab === 'hosting'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>Firebase Hosting & Deploy</span>
          </button>
        </div>
      </div>

      {/* Global Platform KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Total de Espaços na Plataforma
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {workspaces.length}
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
            <FolderKanban className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Usuários Mapeados
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {registeredUsers.length}
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Listas & Itens Cadastrados
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {lists.length} / {items.length}
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Orçamentos Somados
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-indigo-600 dark:text-indigo-400 mt-1">
              {formatCurrencyBRL(totalPlatformBudget)}
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center">
            <Database className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/*Firestore Sync Action Bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
            <Database className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span>Banco de Dados Firestore ({firebaseConfig.projectId})</span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {syncStatus ||
              'Envie ou atualize todos os espaços, listas, itens e categorias diretamente no seu projeto Firebase.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={isSyncing}
            onClick={handlePullFromFirestore}
            className="min-h-[40px] px-3.5 py-2 text-xs font-semibold rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Carregar do Firestore</span>
          </button>

          <button
            type="button"
            disabled={isSyncing}
            onClick={handleSyncToFirestore}
            className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <CloudUpload className="w-4 h-4" />
            <span>Sincronizar Tudo com Firestore</span>
          </button>
        </div>
      </div>

      {/* TAB 1: TODOS OS ESPAÇOS DA PLATAFORMA */}
      {activeTab === 'espacos' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display">
              Auditoria Global de Espaços de Trabalho ({workspaces.length})
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              O Admin pode inspecionar, assumir acesso ou remover qualquer espaço
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {workspaces.map((ws) => {
              const wsLists = lists.filter((l) => l.workspaceId === ws.id);
              const wsItems = items.filter((i) => i.workspaceId === ws.id);
              const isAdminAccepted = ws.acceptedMemberEmails.includes(
                currentUser.email.toLowerCase()
              );

              return (
                <div
                  key={ws.id}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex flex-col justify-between space-y-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                          {ws.type}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Criador: {ws.ownerEmail}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {wsLists.length} listas / {wsItems.length} itens
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => onDeleteWorkspace(ws.id)}
                        aria-label={`Excluir espaço ${ws.name}`}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 font-display">
                        {ws.name}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                        {ws.description}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-xs space-y-1">
                      <span className="text-slate-400 block">
                        Participantes ({ws.members.length}):
                      </span>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-700 dark:text-slate-300">
                        {ws.members.map((m) => (
                          <span key={m.email}>
                            {m.name || m.email.split('@')[0]}{' '}
                            <span className="text-slate-400">({m.status})</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
                    <span className="text-xs font-mono text-slate-500 tabular-nums">
                      Orçamento: {formatCurrencyBRL(ws.monthlyBudget)}
                    </span>

                    <div className="flex items-center gap-2">
                      {!isAdminAccepted && (
                        <button
                          type="button"
                          onClick={() => onGrantAdminAccessToWorkspace(ws.id)}
                          className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 transition-colors cursor-pointer"
                        >
                          Liberar no Meu Painel
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectWorkspace(ws.id)}
                        className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-indigo-600 text-white hover:bg-indigo-600 dark:hover:bg-indigo-500 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <span>Inspecionar Quadro</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: GESTÃO DE USUÁRIOS & BANCO */}
      {activeTab === 'usuarios' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Add / Pre-register User Form */}
          <div className="lg:col-span-5">
            <form
              onSubmit={handleAddUser}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4"
            >
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display flex items-center gap-2">
                  <Plus className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>Registrar Usuário no Sistema</span>
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                  Adicione um usuário na coleção <code className="font-mono">users</code> do Firestore.
                </p>
              </div>

              <div>
                <label
                  htmlFor="admin-new-user-name"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Nome do Usuário
                </label>
                <input
                  id="admin-new-user-name"
                  type="text"
                  required
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="Ex: Carlos Mendes"
                  className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="admin-new-user-email"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  E-mail
                </label>
                <input
                  id="admin-new-user-email"
                  type="email"
                  required
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="carlos@exemplo.com"
                  className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="admin-new-user-uid"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  UID do Firebase Auth (opcional)
                </label>
                <input
                  id="admin-new-user-uid"
                  type="text"
                  value={newUserUid}
                  onChange={(e) => setNewUserUid(e.target.value)}
                  placeholder="Gerado automaticamente se vazio"
                  className="w-full px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                />
              </div>

              <button
                type="submit"
                className="w-full min-h-[42px] px-4 py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Salvar Usuário no Firestore</span>
              </button>
            </form>
          </div>

          {/* Users Directory Table */}
          <div className="lg:col-span-7">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display">
                  Contas Registradas ({registeredUsers.length})
                </h2>
                <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400">
                  Admin UID: {ADMIN_USER_UID}
                </span>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-b border-slate-100 dark:border-slate-800">
                {registeredUsers.map((u) => {
                  const isMainAdmin = u.uid === ADMIN_USER_UID;
                  return (
                    <div
                      key={u.uid}
                      className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-slate-100">
                            {u.displayName}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              isMainAdmin
                                ? 'font-semibold text-indigo-600 dark:text-indigo-400'
                                : 'text-slate-500'
                            }
                          >
                            {isMainAdmin ? 'Administrador Principal' : 'Usuário Padrão'}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 truncate">
                          {u.email}
                        </p>
                        <p className="font-mono text-[11px] text-slate-400">
                          UID: {u.uid}
                        </p>
                      </div>

                      {!isMainAdmin && (
                        <button
                          type="button"
                          onClick={() =>
                            setRegisteredUsers((prev) =>
                              prev.filter((item) => item.uid !== u.uid)
                            )
                          }
                          className="px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors self-start sm:self-center cursor-pointer"
                        >
                          Remover da Lista
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: FIREBASE HOSTING & ESTRUTURA DE DEPLOY */}
      {activeTab === 'hosting' && (
        <div className="space-y-6">
          {/* Quick Deploy Commands Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>Passo a Passo para Subir no Firebase Hosting</span>
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                  Os arquivos <code className="font-mono">firebase.json</code>,{' '}
                  <code className="font-mono">.firebaserc</code>,{' '}
                  <code className="font-mono">firestore.rules</code> e{' '}
                  <code className="font-mono">storage.rules</code> já estão prontos na raiz do projeto.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  handleCopyText(
                    'cmd',
                    'npm run build && npx firebase-tools deploy --project teste-beta-fin-e-list'
                  )
                }
                className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-800 text-white hover:bg-indigo-600 transition-colors flex items-center gap-1.5 self-start cursor-pointer"
              >
                {copiedBlock === 'cmd' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Comando Copiado</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar Comando de Deploy</span>
                  </>
                )}
              </button>
            </div>

            <pre className="p-4 rounded-xl bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto leading-relaxed">
{`# 1. Gere o pacote de produção (pasta dist)
npm run build

# 2. Autentique no Firebase CLI (caso ainda não esteja logado)
npx firebase-tools login

# 3. Envie o site (Hosting) e as regras para o projeto teste-beta-fin-e-list
npx firebase-tools deploy --project teste-beta-fin-e-list`}
            </pre>
          </div>

          {/* Config Files Preview Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold font-mono text-slate-900 dark:text-slate-100">
                  firebase.json + .firebaserc
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyText('fbjson', FIREBASE_JSON_CONTENT)}
                  className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedBlock === 'fbjson' ? 'Copiado!' : 'Copiar'}</span>
                </button>
              </div>
              <pre className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto">
                {FIREBASE_JSON_CONTENT}
                {'\n\n// .firebaserc\n'}
                {FIREBASERC_CONTENT}
              </pre>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold font-mono text-slate-900 dark:text-slate-100">
                  firestore.rules (Admin UID: {ADMIN_USER_UID})
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyText('rules', FIRESTORE_RULES_CONTENT)}
                  className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedBlock === 'rules' ? 'Copiado!' : 'Copiar'}</span>
                </button>
              </div>
              <pre className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto max-h-60">
                {FIRESTORE_RULES_CONTENT}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
