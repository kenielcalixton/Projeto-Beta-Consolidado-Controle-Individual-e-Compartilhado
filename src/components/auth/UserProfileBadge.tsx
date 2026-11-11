import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface UserProfileBadgeProps {
  onLogoutRequested?: () => Promise<void> | void;
}

export const UserProfileBadge: React.FC<UserProfileBadgeProps> = ({ onLogoutRequested }) => {
  const { user, logout, loading } = useAuth();
  const [copiedUid, setCopiedUid] = useState(false);
  const [showConfirmLogout, setShowConfirmLogout] = useState(false);

  if (!user) return null;

  const initials = (user.displayName || user.email || 'U')
    .split(' ')
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('');

  const handleCopyUid = () => {
    if (user.uid) {
      navigator.clipboard.writeText(user.uid);
      setCopiedUid(true);
      setTimeout(() => setCopiedUid(false), 2000);
    }
  };

  const handlePerformLogout = async () => {
    setShowConfirmLogout(false);
    if (onLogoutRequested) {
      await onLogoutRequested();
    } else {
      await logout();
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5 p-1.5 md:p-2 bg-slate-800/80 border border-slate-700/70 rounded-2xl">
        {/* Avatar / Iniciais */}
        <div className="relative shrink-0">
          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt={user.displayName || 'Avatar'}
              className="w-9 h-9 rounded-xl object-cover border border-slate-700"
            />
          ) : (
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white font-bold text-xs flex items-center justify-center shadow-sm">
              {initials}
            </div>
          )}
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-800 ${
              user.isDemo ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
            title={user.isDemo ? 'Modo Demonstração' : 'Conectado via Firebase Auth'}
          />
        </div>

        {/* Detalhes do Usuário */}
        <div className="hidden sm:flex flex-col min-w-0 pr-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-100 truncate max-w-[130px]">
              {user.displayName}
            </span>
            {user.isDemo && (
              <span className="px-1.5 py-0.2 bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-medium rounded">
                Demo
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-slate-400">
            <span className="truncate max-w-[140px]" title={user.email}>
              {user.email}
            </span>
            <button
              type="button"
              onClick={handleCopyUid}
              className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer shrink-0 ml-0.5"
              title={`Copiar UID canônico: ${user.uid}`}
            >
              <i className={`ph ${copiedUid ? 'ph-check text-emerald-400' : 'ph-copy'}`}></i>
            </button>
          </div>
        </div>

        {/* Botão de Logout */}
        <button
          type="button"
          onClick={() => setShowConfirmLogout(true)}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition-all cursor-pointer"
          title="Encerrar sessão com segurança"
        >
          <i className="ph-bold ph-sign-out text-base"></i>
        </button>
      </div>

      {/* Modal de Confirmação de Logout */}
      {showConfirmLogout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mb-4">
              <i className="ph-bold ph-sign-out text-2xl"></i>
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Encerrar Sessão</h3>
            <p className="text-xs text-slate-400 mb-6 leading-relaxed">
              Deseja realmente sair da sua conta? Todos os dados em memória serão limpos com segurança e você precisará autenticar novamente.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowConfirmLogout(false)}
                className="flex-1 py-2.5 px-4 bg-slate-700/60 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
              >
                Permanecer
              </button>
              <button
                type="button"
                onClick={handlePerformLogout}
                disabled={loading}
                className="flex-1 py-2.5 px-4 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer shadow-lg shadow-rose-600/30 flex items-center justify-center gap-1.5"
              >
                {loading ? 'Saindo...' : 'Sim, Sair'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
