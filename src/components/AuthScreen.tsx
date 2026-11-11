import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { validateRegistration, validateEmail, validatePassword } from '../services/authService';

interface AuthScreenProps {
  onEnterDemoMode?: (profile: { uid: string; name: string; email: string }) => void;
}

type AuthMode = 'login' | 'register' | 'reset';

export const AuthScreen: React.FC<AuthScreenProps> = ({ onEnterDemoMode }) => {
  const {
    login,
    register,
    resetPassword,
    loginWithGoogle,
    enterDemoMode: contextEnterDemoMode,
    loading,
    error: contextError,
    clearError,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const activeError = localError || contextError;

  const handleSwitchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setLocalError(null);
    setInfoMsg(null);
    clearError();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setInfoMsg(null);
    clearError();

    const normalizedEmail = email.trim().toLowerCase();

    // 1. FLUXO DE RECUPERAÇÃO DE SENHA
    if (mode === 'reset') {
      const emailVal = validateEmail(normalizedEmail);
      if (!emailVal.isValid) {
        setLocalError(emailVal.error || 'Informe um e-mail válido.');
        return;
      }

      try {
        await resetPassword(normalizedEmail);
        setInfoMsg(
          `E-mail de redefinição enviado para ${normalizedEmail}. Verifique sua caixa de entrada e a pasta de spam.`
        );
      } catch (err: unknown) {
        // O erro do contexto já foi formatado em português
      }
      return;
    }

    // 2. FLUXO DE CADASTRO
    if (mode === 'register') {
      const regVal = validateRegistration(name, normalizedEmail, password, confirmPassword);
      if (!regVal.isValid) {
        setLocalError(regVal.error || 'Preencha os campos corretamente.');
        return;
      }

      try {
        await register(name.trim(), normalizedEmail, password);
        // O onAuthStateChanged do AuthProvider sincronizará a sessão automaticamente
      } catch (err: unknown) {
        // Erro formatado no contexto
      }
      return;
    }

    // 3. FLUXO DE LOGIN
    const emailVal = validateEmail(normalizedEmail);
    if (!emailVal.isValid) {
      setLocalError(emailVal.error || 'Informe um e-mail válido.');
      return;
    }

    const passVal = validatePassword(password);
    if (!passVal.isValid) {
      setLocalError(passVal.error || 'Informe sua senha.');
      return;
    }

    try {
      await login(normalizedEmail, password);
    } catch (err: unknown) {
      // Erro formatado no contexto
    }
  };

  const handleGoogleSignIn = async () => {
    setLocalError(null);
    setInfoMsg(null);
    clearError();

    try {
      await loginWithGoogle();
    } catch (err: unknown) {
      // Erro formatado no contexto
    }
  };

  const handleDemoAccess = () => {
    const demoProfile = {
      uid: 'demo_user_default',
      name: 'Usuário Demonstração',
      email: 'demo@meupainel.com',
    };

    if (onEnterDemoMode) {
      onEnterDemoMode(demoProfile);
    } else {
      contextEnterDemoMode(demoProfile);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-center items-center p-4 md:p-8">
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 bg-slate-800/90 border border-slate-700/80 rounded-3xl overflow-hidden shadow-2xl">
        {/* Coluna Institucional / Apresentação */}
        <div className="lg:col-span-6 p-8 md:p-10 bg-slate-800 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-700/80">
          <div>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-11 h-11 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
                <i className="ph-fill ph-wallet text-2xl"></i>
              </div>
              <span className="text-xl font-bold tracking-tight text-white">
                Meu Painel Financeiro
              </span>
            </div>

            <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight mb-4">
              Controle financeiro inteligente com Livro-Razão auditável.
            </h1>
            <p className="text-slate-400 text-sm md:text-base leading-relaxed mb-8">
              Autenticação segura via Firebase Authentication com identidade canônica por UID, separação estrita de dados bancários privados e suporte a rateios colaborativos.
            </p>

            <div className="space-y-4">
              <div className="flex items-start gap-3.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0 mt-0.5">
                  <i className="ph-fill ph-shield-check text-lg"></i>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Identidade Canônica & Segurança
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Sessão persistente baseada no UID do Firebase Auth, sem exposição de credenciais privadas.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
                  <i className="ph-fill ph-arrows-split text-lg"></i>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Financeiro Individual & Espaços
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Utilize suas contas pessoais de forma totalmente independente ou colabore em espaços com governança de rateios.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center shrink-0 mt-0.5">
                  <i className="ph-fill ph-lock-key text-lg"></i>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Isolamento Físico de Metadados
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Comprovantes e dados bancários restritos unicamente ao seu titular, sem vazamento entre participantes.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-700/60 flex items-center justify-between text-xs text-slate-400">
            <span>Firebase Auth v13</span>
            <span aria-hidden="true">·</span>
            <span>Identidade Canônica UID</span>
            <span aria-hidden="true">·</span>
            <span>Arquitetura v3.1</span>
          </div>
        </div>

        {/* Coluna Formulário de Autenticação */}
        <div className="lg:col-span-6 p-8 md:p-10 bg-slate-900/60 flex flex-col justify-center">
          {/* Alternância Login / Cadastro */}
          <div className="flex items-center p-1 bg-slate-800 border border-slate-700/80 rounded-2xl mb-6">
            <button
              type="button"
              onClick={() => handleSwitchMode('login')}
              className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                mode === 'login'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Entrar na Conta
            </button>
            <button
              type="button"
              onClick={() => handleSwitchMode('register')}
              className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                mode === 'register'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Criar Cadastro
            </button>
          </div>

          <div className="mb-6">
            <h2 className="text-xl font-bold text-white">
              {mode === 'login'
                ? 'Bem-vindo de volta'
                : mode === 'register'
                ? 'Crie sua conta no sistema'
                : 'Recuperação de Senha'}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {mode === 'login'
                ? 'Acesse suas contas, cartões e espaços compartilhados.'
                : mode === 'register'
                ? 'Preencha seus dados para iniciar seu controle financeiro seguro.'
                : 'Informe seu e-mail cadastrado para receber o link de redefinição.'}
            </p>
          </div>

          {activeError && (
            <div
              role="alert"
              className="mb-4 p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in duration-150"
            >
              <i className="ph-fill ph-warning-circle text-base shrink-0 mt-0.5"></i>
              <span>{activeError}</span>
            </div>
          )}

          {infoMsg && (
            <div
              role="status"
              className="mb-4 p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-start gap-2.5 animate-in fade-in duration-150"
            >
              <i className="ph-fill ph-check-circle text-base shrink-0 mt-0.5"></i>
              <span>{infoMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label
                  htmlFor="auth-name"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Nome Completo
                </label>
                <div className="relative">
                  <i className="ph ph-user absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    id="auth-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Keniel Calixto"
                    maxLength={100}
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                </div>
              </div>
            )}

            <div>
              <label
                htmlFor="auth-email"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                E-mail
              </label>
              <div className="relative">
                <i className="ph ph-envelope-simple absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu.email@exemplo.com"
                  maxLength={160}
                  disabled={loading}
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                />
              </div>
            </div>

            {mode !== 'reset' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="auth-password"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Senha
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => handleSwitchMode('reset')}
                      className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer"
                    >
                      Esqueci a senha
                    </button>
                  )}
                </div>
                <div className="relative">
                  <i className="ph ph-lock-key absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 6 caracteres"
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                </div>
              </div>
            )}

            {mode === 'register' && (
              <div>
                <label
                  htmlFor="auth-confirm-password"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Confirmação de Senha
                </label>
                <div className="relative">
                  <i className="ph ph-check-square-offset absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    id="auth-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repita a senha escolhida"
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl shadow-lg shadow-indigo-600/25 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              {loading ? (
                <span>Processando...</span>
              ) : mode === 'login' ? (
                <>
                  <i className="ph-bold ph-sign-in"></i>
                  <span>Entrar no Painel</span>
                </>
              ) : mode === 'register' ? (
                <>
                  <i className="ph-bold ph-user-plus"></i>
                  <span>Concluir Cadastro</span>
                </>
              ) : (
                <>
                  <i className="ph-bold ph-paper-plane-tilt"></i>
                  <span>Enviar Link de Recuperação</span>
                </>
              )}
            </button>

            {mode === 'reset' && (
              <button
                type="button"
                onClick={() => handleSwitchMode('login')}
                className="w-full py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                Voltar para o Login
              </button>
            )}
          </form>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px bg-slate-700/80 flex-1"></div>
            <span className="text-xs text-slate-400">ou continue com</span>
            <div className="h-px bg-slate-700/80 flex-1"></div>
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs font-semibold text-slate-200 transition-colors flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <i className="ph-bold ph-google-logo text-indigo-400 text-base"></i>
            <span>Entrar com Google</span>
          </button>

          <button
            type="button"
            onClick={handleDemoAccess}
            disabled={loading}
            className="mt-3 w-full py-2.5 px-4 bg-slate-900/60 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 rounded-xl text-xs font-medium text-slate-300 transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <i className="ph-bold ph-lightning text-amber-400"></i>
            <span>Acessar Modo Demonstração Rápido</span>
          </button>
        </div>
      </div>
    </div>
  );
};
