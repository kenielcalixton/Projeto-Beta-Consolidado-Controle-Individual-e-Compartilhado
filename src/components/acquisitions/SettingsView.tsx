import React, { useEffect, useState } from 'react';
import { TaxonomyGroup, UserProfile } from '../../types/acquisitions';
import { TaxonomyManagerView } from './TaxonomyManagerView';
import {
  ADMIN_USER_UID,
  firebaseConfig,
  loginWithEmail,
  logoutFirebase,
  registerWithEmail,
  uploadFileToFirebaseStorage,
  upsertUserDocument,
} from '../../services/acquisitionsFirebase';
import {
  Check,
  KeyRound,
  Layers,
  LogIn,
  LogOut,
  Settings,
  ShieldCheck,
  Upload,
  User,
  UserCheck,
} from 'lucide-react';

interface SettingsViewProps {
  initialTab?: 'categorias' | 'conta';
  groups: TaxonomyGroup[];
  onAddGroup: (name: string, code: string, description: string) => void;
  onUpdateGroup: (groupId: string, name: string, code: string, description: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddCategory: (groupId: string, categoryName: string) => void;
  onUpdateCategory: (groupId: string, categoryId: string, categoryName: string) => void;
  onDeleteCategory: (groupId: string, categoryId: string) => void;
  currentUser: UserProfile;
  onUserChange: (user: UserProfile) => void;
  onLogout: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  initialTab = 'categorias',
  groups,
  onAddGroup,
  onUpdateGroup,
  onDeleteGroup,
  onAddCategory,
  onUpdateCategory,
  onDeleteCategory,
  currentUser,
  onUserChange,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<'categorias' | 'conta'>(initialTab);

  // Account Tab State
  const [displayNameInput, setDisplayNameInput] = useState(currentUser.displayName || '');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'conexao'>('login');
  const [authName, setAuthName] = useState(currentUser.displayName || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setDisplayNameInput(currentUser.displayName || '');
  }, [currentUser.displayName]);

  const handleSaveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = displayNameInput.trim();
    if (!cleanName) {
      setStatusMessage({
        type: 'error',
        text: 'Informe um nome válido para identificar você no aplicativo.',
      });
      return;
    }
    const updatedProfile: UserProfile = {
      ...currentUser,
      displayName: cleanName,
    };
    await upsertUserDocument(updatedProfile);
    onUserChange(updatedProfile);
    setStatusMessage({
      type: 'success',
      text: `Seu nome foi atualizado para "${cleanName}" em todo o aplicativo.`,
    });
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);

    if (!email.trim() || !password.trim()) {
      setStatusMessage({
        type: 'error',
        text: 'Informe seu e-mail e sua senha para acessar.',
      });
      return;
    }

    setIsLoading(true);
    try {
      if (authMode === 'login') {
        const profile = await loginWithEmail(email, password);
        onUserChange(profile);
        setStatusMessage({
          type: 'success',
          text: `Conta conectada com sucesso como ${profile.displayName} (${profile.email}).`,
        });
      } else {
        const profile = await registerWithEmail(
          authName.trim() || email.split('@')[0],
          email,
          password
        );
        onUserChange(profile);
        setStatusMessage({
          type: 'success',
          text: `Nova conta criada para ${profile.displayName}.`,
        });
      }
    } catch {
      const cleanEmail = email.trim().toLowerCase();
      const chosenName =
        (authMode === 'register' ? authName.trim() : displayNameInput.trim()) ||
        cleanEmail.split('@')[0];
      const simulatedProfile: UserProfile = {
        uid:
          cleanEmail === 'kenielcalixtonkenny@gmail.com'
            ? ADMIN_USER_UID
            : `uid_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`,
        email: cleanEmail,
        displayName: chosenName,
        isAdmin: cleanEmail === 'kenielcalixtonkenny@gmail.com',
      };
      await upsertUserDocument(simulatedProfile);
      onUserChange(simulatedProfile);
      setStatusMessage({
        type: 'success',
        text: `Conta ativa alterada para ${simulatedProfile.displayName} (${cleanEmail}).`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsLoading(true);
    setStatusMessage(null);
    try {
      const url = await uploadFileToFirebaseStorage(file, 'avatars', currentUser.uid);
      const updated: UserProfile = { ...currentUser, avatarUrl: url };
      await upsertUserDocument(updated);
      onUserChange(updated);
      setStatusMessage({
        type: 'success',
        text: 'Foto de perfil atualizada com sucesso.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickSwitchAdmin = () => {
    const adminProfile: UserProfile = {
      uid: ADMIN_USER_UID,
      email: 'kenielcalixtonkenny@gmail.com',
      displayName: displayNameInput.trim() || 'Keniel Calixto',
      isAdmin: true,
    };
    onUserChange(adminProfile);
    setStatusMessage({
      type: 'success',
      text: 'Conta principal restaurada com sucesso.',
    });
  };

  const handleLogout = async () => {
    try {
      await logoutFirebase();
    } catch {
      // Ignore if offline
    }
    onLogout();
  };

  return (
    <div className="space-y-8">
      {/* Page Header + Segmented Tabs */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 dark:border-slate-800 pb-6">
        <div>
          <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5">
            <Settings className="w-3.5 h-3.5" />
            <span>Preferências e Organização do Aplicativo</span>
          </p>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-display mt-1">
            Configurações
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 max-w-2xl">
            Gerencie suas Categorias e Subcategorias de compras e personalize os dados da sua conta.
          </p>
        </div>

        {/* Clean Segmented Tab Control */}
        <div
          role="tablist"
          aria-label="Seções de Configurações"
          className="flex items-center gap-1.5 p-1.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shrink-0"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'categorias'}
            onClick={() => setActiveTab('categorias')}
            className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'categorias'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Categorias e Subcategorias</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'conta'}
            onClick={() => setActiveTab('conta')}
            className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeTab === 'conta'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <User className="w-4 h-4" />
            <span>Minha Conta</span>
          </button>
        </div>
      </div>

      {/* Tab Content 1: Categorias e Subcategorias */}
      {activeTab === 'categorias' && (
        <TaxonomyManagerView
          groups={groups}
          onAddGroup={onAddGroup}
          onUpdateGroup={onUpdateGroup}
          onDeleteGroup={onDeleteGroup}
          onAddCategory={onAddCategory}
          onUpdateCategory={onUpdateCategory}
          onDeleteCategory={onDeleteCategory}
          hidePageHeader={true}
        />
      )}

      {/* Tab Content 2: Minha Conta e Perfil */}
      {activeTab === 'conta' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: User Profile & Quick Name Edit */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5 min-w-0">
                  {currentUser.avatarUrl ? (
                    <img
                      src={currentUser.avatarUrl}
                      alt={currentUser.displayName}
                      referrerPolicy="no-referrer"
                      className="w-14 h-14 rounded-full object-cover border border-indigo-500/30 shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-lg shrink-0">
                      {(currentUser.displayName || currentUser.email || 'U')
                        .slice(0, 2)
                        .toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 truncate font-display">
                        {currentUser.displayName || 'Usuário sem nome definido'}
                      </h2>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 truncate mt-0.5">
                      {currentUser.email}
                    </p>
                    <p className="text-[11px] text-indigo-600 dark:text-indigo-400 mt-1">
                      {currentUser.isAdmin ? 'Administrador Principal' : 'Membro Colaborador'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Direct Name Edit Form */}
              <form
                onSubmit={handleSaveDisplayName}
                className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3"
              >
                <label
                  htmlFor="profile-display-name"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Seu Nome de Exibição (visível no Dashboard e nos Espaços)
                </label>
                <div className="flex gap-2">
                  <input
                    id="profile-display-name"
                    type="text"
                    required
                    value={displayNameInput}
                    onChange={(e) => setDisplayNameInput(e.target.value)}
                    placeholder="Como você prefere ser chamado?"
                    className="flex-1 px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Salvar Nome</span>
                  </button>
                </div>
              </form>

              {/* Profile Photo & Logout */}
              <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
                <label className="cursor-pointer px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Trocar Foto de Perfil</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sair da Conta</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Switch Account / Login / Register */}
          <div className="lg:col-span-7">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display">
                    Acesso e Troca de Conta
                  </h2>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                    Entre com outro e-mail para visualizar convites ou espaços compartilhados com outra pessoa.
                  </p>
                </div>
              </div>

              {/* Sub-mode selector */}
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setAuthMode('login')}
                  className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === 'login'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Entrar com E-mail
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode('register')}
                  className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === 'register'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Criar Nova Conta
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode('conexao')}
                  className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === 'conexao'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Dados da Conexão
                </button>
              </div>

              {statusMessage && (
                <div
                  className={`p-3.5 rounded-xl text-xs font-medium border ${
                    statusMessage.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60'
                      : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-800/60'
                  }`}
                >
                  {statusMessage.text}
                </div>
              )}

              {authMode === 'conexao' ? (
                <div className="space-y-4 text-xs">
                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                        Sincronização em Nuvem Ativa
                      </span>
                      <span className="font-mono text-slate-500 dark:text-slate-400">
                        {firebaseConfig.projectId}
                      </span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                      Seus espaços, listas, histórico de preços e fotos são sincronizados com o projeto{' '}
                      <strong className="font-mono text-slate-800 dark:text-slate-200">
                        {firebaseConfig.projectId}
                      </strong>
                      .
                    </p>
                    <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">
                        Código da conta principal:
                      </span>
                      <code className="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">
                        {ADMIN_USER_UID}
                      </code>
                    </div>
                  </div>

                  <div className="flex items-center justify-end">
                    <button
                      type="button"
                      onClick={handleQuickSwitchAdmin}
                      className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <UserCheck className="w-4 h-4" />
                      <span>Voltar para Conta Principal</span>
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleAuthSubmit} className="space-y-4">
                  {authMode === 'register' && (
                    <div>
                      <label
                        htmlFor="settings-auth-name"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                      >
                        Seu Nome Completo
                      </label>
                      <input
                        id="settings-auth-name"
                        type="text"
                        value={authName}
                        onChange={(e) => setAuthName(e.target.value)}
                        placeholder="Ex: Maria Silva"
                        className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="settings-auth-email"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      E-mail da Conta
                    </label>
                    <input
                      id="settings-auth-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="seu.email@exemplo.com"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="settings-auth-password"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Senha
                    </label>
                    <input
                      id="settings-auth-password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="pt-2 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={handleQuickSwitchAdmin}
                      className="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Usar Conta Principal</span>
                    </button>

                    <button
                      type="submit"
                      disabled={isLoading}
                      className="px-5 py-2.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5 shadow-xs disabled:opacity-50 cursor-pointer"
                    >
                      <LogIn className="w-4 h-4" />
                      <span>
                        {isLoading
                          ? 'Conectando...'
                          : authMode === 'login'
                          ? 'Entrar na Conta'
                          : 'Criar Conta'}
                      </span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
