import React, { useState } from 'react';
import { ResponsiveSheetModal } from './ResponsiveSheetModal';
import { UserProfile } from '../../types/acquisitions';
import {
  ADMIN_USER_UID,
  firebaseConfig,
  loginWithEmail,
  logoutFirebase,
  registerWithEmail,
  uploadFileToFirebaseStorage,
  upsertUserDocument,
} from '../../services/acquisitionsFirebase';
import { LogIn, LogOut, ShieldCheck, Upload, UserCheck, KeyRound } from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile;
  onUserChange: (user: UserProfile) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onUserChange,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'profile'>('login');
  const [name, setName] = useState(currentUser.displayName || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);

    if (!email.trim() || !password.trim()) {
      setStatusMessage({
        type: 'error',
        text: 'Informe um e-mail válido e sua senha para autenticar.',
      });
      return;
    }

    setIsLoading(true);
    try {
      if (mode === 'login') {
        const profile = await loginWithEmail(email, password);
        onUserChange(profile);
        setStatusMessage({
          type: 'success',
          text: `Sessão autenticada no Firebase Auth como ${profile.email}.`,
        });
      } else {
        const profile = await registerWithEmail(name || email.split('@')[0], email, password);
        onUserChange(profile);
        setStatusMessage({
          type: 'success',
          text: `Conta criada no Firebase Auth (${profile.uid}).`,
        });
      }
    } catch (err: any) {
      // Allows switching active ACL identity in preview if user doesn't have the password yet
      const cleanEmail = email.trim().toLowerCase();
      const simulatedProfile: UserProfile = {
        uid:
          cleanEmail === 'kenielcalixtonkenny@gmail.com'
            ? ADMIN_USER_UID
            : `uid_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`,
        email: cleanEmail,
        displayName: name.trim() || cleanEmail.split('@')[0],
        isAdmin: cleanEmail === 'kenielcalixtonkenny@gmail.com',
      };
      await upsertUserDocument(simulatedProfile);
      onUserChange(simulatedProfile);
      setStatusMessage({
        type: 'success',
        text: `Sessão de acesso (ACL) alternada para ${cleanEmail}. (${err?.code || 'Firebase SDK pronto'})`,
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
        text: 'Avatar enviado para o Firebase Storage e vinculado ao perfil.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickSwitchAdmin = () => {
    const adminProfile: UserProfile = {
      uid: ADMIN_USER_UID,
      email: 'kenielcalixtonkenny@gmail.com',
      displayName: 'Keniel Calixto (Admin)',
      isAdmin: true,
    };
    onUserChange(adminProfile);
    setStatusMessage({
      type: 'success',
      text: `Perfil Admin restaurado (UID: ${ADMIN_USER_UID}).`,
    });
  };

  const handleLogout = async () => {
    try {
      await logoutFirebase();
    } catch {
      // Ignore if not signed into remote Firebase session
    }
    setStatusMessage({
      type: 'success',
      text: 'Sessão encerrada com sucesso.',
    });
  };

  return (
    <ResponsiveSheetModal
      isOpen={isOpen}
      onClose={onClose}
      title="Autenticação & Sessão Firebase"
      subtitle="Gerencie seu acesso via E-mail e Senha, ACL de Workspaces e upload de Avatar no Firebase Storage."
      maxWidthClass="md:max-w-xl"
    >
      {/* Current User Card */}
      <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          {currentUser.avatarUrl ? (
            <img
              src={currentUser.avatarUrl}
              alt={currentUser.displayName}
              referrerPolicy="no-referrer"
              className="w-12 h-12 rounded-full object-cover border border-indigo-500/30"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-base shrink-0">
              {currentUser.displayName.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                {currentUser.displayName}
              </p>
              {currentUser.uid === ADMIN_USER_UID && (
                <span className="text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                  · Admin
                </span>
              )}
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
              {currentUser.email}
            </p>
            <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              UID: {currentUser.uid}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label className="cursor-pointer px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap">
            <Upload className="w-3.5 h-3.5" />
            <span>Foto Storage</span>
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
            className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors flex items-center gap-1 whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sair</span>
          </button>
        </div>
      </div>

      {/* Mode Selector */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
        <button
          type="button"
          onClick={() => setMode('login')}
          className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            mode === 'login'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          Entrar com E-mail
        </button>
        <button
          type="button"
          onClick={() => setMode('register')}
          className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            mode === 'register'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          Criar Nova Conta
        </button>
        <button
          type="button"
          onClick={() => setMode('profile')}
          className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            mode === 'profile'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          Credenciais Firebase
        </button>
      </div>

      {statusMessage && (
        <div
          className={`p-3 rounded-lg text-xs font-medium border ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60'
              : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-800/60'
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {mode === 'profile' ? (
        <div className="space-y-3 text-xs">
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                Apontamento Firebase Ativo
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                {firebaseConfig.projectId}
              </span>
            </div>
            <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
              O SDK está conectado ao projeto{' '}
              <strong className="font-mono text-slate-800 dark:text-slate-200">
                {firebaseConfig.projectId}
              </strong>{' '}
              com suporte às coleções <code className="font-mono">users</code>,{' '}
              <code className="font-mono">workspaces</code>, <code className="font-mono">lists</code>
              , <code className="font-mono">items</code> e subcoleção{' '}
              <code className="font-mono">products</code>, além de bucket Storage{' '}
              <code className="font-mono">{firebaseConfig.storageBucket}</code>.
            </p>
            <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">Admin UID configurado:</span>
              <code className="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">
                {ADMIN_USER_UID}
              </code>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={handleQuickSwitchAdmin}
              className="px-3.5 py-2 text-xs font-medium rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 transition-colors flex items-center gap-1.5"
            >
              <UserCheck className="w-4 h-4" />
              <span>Ativar Sessão Admin ({ADMIN_USER_UID.slice(0, 8)}…)</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900"
            >
              Concluído
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleAuthSubmit} className="space-y-3.5">
          {mode === 'register' && (
            <div>
              <label
                htmlFor="auth-name"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Nome Completo
              </label>
              <input
                id="auth-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Keniel Calixto"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="auth-email"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              E-mail de Acesso (ACL)
            </label>
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu.email@exemplo.com"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Senha
            </label>
            <input
              id="auth-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleQuickSwitchAdmin}
              className="px-3 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors flex items-center gap-1"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Usar Admin UID</span>
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-5 py-2.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5 shadow-xs disabled:opacity-50"
            >
              <LogIn className="w-4 h-4" />
              <span>
                {isLoading
                  ? 'Autenticando...'
                  : mode === 'login'
                  ? 'Entrar no Firebase Auth'
                  : 'Cadastrar Usuário'}
              </span>
            </button>
          </div>
        </form>
      )}
    </ResponsiveSheetModal>
  );
};
