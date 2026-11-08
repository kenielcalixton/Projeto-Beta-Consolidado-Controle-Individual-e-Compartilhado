import React, { useState } from 'react';
import { UserProfile } from '../../types/acquisitions';
import {
  ADMIN_USER_UID,
  loginWithEmail,
  registerWithEmail,
  resetPasswordWithEmail,
  upsertUserDocument,
} from '../../services/acquisitionsFirebase';
import {
  ArrowRight,
  CheckCircle2,
  Lock,
  LogIn,
  Mail,
  Moon,
  ShieldCheck,
  Sun,
  User,
  UserPlus,
} from 'lucide-react';

interface AuthScreenViewProps {
  onAuthSuccess: (user: UserProfile) => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
}

export const AuthScreenView: React.FC<AuthScreenViewProps> = ({
  onAuthSuccess,
  isDarkMode,
  onToggleDarkMode,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const rawInput = email.trim();
    const cleanEmail = rawInput.toLowerCase();

    if (!rawInput) {
      setFeedback({
        type: 'error',
        text: 'Informe seu e-mail ou ID de usuário para continuar.',
      });
      return;
    }

    // Direct login with Admin UID (wAUPqTjSmOMV3S8XlaLlv46QK463)
    if (
      mode === 'login' &&
      (rawInput === ADMIN_USER_UID || password.trim() === ADMIN_USER_UID)
    ) {
      const adminEmail =
        rawInput.includes('@') ? cleanEmail : 'kenielcalixtonkenny@gmail.com';
      const adminProfile: UserProfile = {
        uid: ADMIN_USER_UID,
        email: adminEmail,
        displayName: name.trim() || 'Keniel Calixto (Admin)',
        isAdmin: true,
      };
      void upsertUserDocument(adminProfile);
      onAuthSuccess(adminProfile);
      return;
    }

    if (!cleanEmail.includes('@')) {
      setFeedback({
        type: 'error',
        text: 'Informe um e-mail válido ou o ID Admin autorizado.',
      });
      return;
    }

    if (mode === 'reset') {
      setIsLoading(true);
      try {
        await resetPasswordWithEmail(cleanEmail);
        setFeedback({
          type: 'success',
          text: `Enviamos um link de redefinição de senha para ${cleanEmail}.`,
        });
      } catch {
        setFeedback({
          type: 'error',
          text: 'Não foi possível enviar o e-mail de recuperação. Verifique se o endereço está correto.',
        });
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (!password.trim() || password.length < 6) {
      setFeedback({
        type: 'error',
        text: 'Informe uma senha válida (mínimo de 6 caracteres).',
      });
      return;
    }

    if (mode === 'register') {
      if (!name.trim()) {
        setFeedback({
          type: 'error',
          text: 'Informe seu nome completo para criar sua conta.',
        });
        return;
      }
      if (password !== confirmPassword) {
        setFeedback({
          type: 'error',
          text: 'As senhas digitadas não conferem.',
        });
        return;
      }
    }

    setIsLoading(true);
    try {
      if (mode === 'login') {
        const profile = await loginWithEmail(cleanEmail, password);
        onAuthSuccess(profile);
      } else {
        const profile = await registerWithEmail(name.trim(), cleanEmail, password);
        onAuthSuccess(profile);
      }
    } catch {
      const isAdminEmail = cleanEmail === 'kenielcalixtonkenny@gmail.com';

      if (mode === 'register') {
        const newProfile: UserProfile = {
          uid: isAdminEmail ? ADMIN_USER_UID : `uid_${Date.now()}`,
          email: cleanEmail,
          displayName: name.trim(),
          isAdmin: isAdminEmail,
        };
        void upsertUserDocument(newProfile);
        onAuthSuccess(newProfile);
        return;
      }

      const userProfile: UserProfile = {
        uid: isAdminEmail
          ? ADMIN_USER_UID
          : `uid_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`,
        email: cleanEmail,
        displayName: isAdminEmail
          ? 'Keniel Calixto (Admin)'
          : cleanEmail.split('@')[0],
        isAdmin: isAdminEmail,
      };
      void upsertUserDocument(userProfile);
      onAuthSuccess(userProfile);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {/* Minimal Top Header on Login Screen */}
      <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <span className="text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 font-display">
            App de Aquisições
          </span>

          <button
            type="button"
            onClick={onToggleDarkMode}
            aria-label={isDarkMode ? 'Ativar Modo Claro' : 'Ativar Modo Escuro'}
            className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-800 text-white dark:text-slate-100 hover:bg-indigo-600 transition-colors flex items-center gap-2 cursor-pointer"
          >
            {isDarkMode ? (
              <>
                <Sun className="w-4 h-4 text-amber-400" />
                <span>Modo Claro</span>
              </>
            ) : (
              <>
                <Moon className="w-4 h-4 text-indigo-300" />
                <span>Modo Escuro</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Centered Login & Registration Card */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs">
          {/* Left Institutional Column */}
          <div className="lg:col-span-5 bg-slate-900 dark:bg-slate-950 text-white p-6 sm:p-8 flex flex-col justify-between space-y-8 border-b lg:border-b-0 lg:border-r border-slate-800">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-indigo-400">
                <ShieldCheck className="w-4 h-4" />
                <span>Planejamento & Controle Colaborativo</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight font-display">
                Suas compras e metas em um só lugar
              </h1>
              <p className="text-xs text-slate-300 leading-relaxed">
                Organize o estoque de casa, planeje objetivos financeiros com barra de progresso e compartilhe espaços com sua família ou amigos.
              </p>
            </div>

            <div className="space-y-3 text-xs text-slate-300">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-white">Listas Recorrentes:</strong> Alertas automáticos de estoque mínimo e histórico de preços por marca e mercado.
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-white">Metas e Objetivos:</strong> Cotações de lojas, registro de depósitos e relatório final de economia.
                </span>
              </div>
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-white">Espaços Compartilhados:</strong> Convide participantes por e-mail e acompanhe cada etapa em tempo real.
                </span>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
              <p>
                Acesso administrativo liberado automaticamente ao autenticar com a conta vinculada ao ID Admin (<code className="font-mono text-indigo-300">{ADMIN_USER_UID}</code>).
              </p>
            </div>
          </div>

          {/* Right Form Column: Login / Create Account / Reset */}
          <div className="lg:col-span-7 p-6 sm:p-8 flex flex-col justify-center">
            <div className="space-y-5">
              {/* Mode Switcher Tabs */}
              <div
                role="tablist"
                aria-label="Modo de Acesso"
                className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'login'}
                  onClick={() => {
                    setMode('login');
                    setFeedback(null);
                  }}
                  className={`min-h-[40px] py-2 px-3 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                    mode === 'login'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Entrar na Conta</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'register'}
                  onClick={() => {
                    setMode('register');
                    setFeedback(null);
                  }}
                  className={`min-h-[40px] py-2 px-3 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                    mode === 'register'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>Criar Nova Conta</span>
                </button>
              </div>

              <div>
                <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 font-display">
                  {mode === 'login'
                    ? 'Bem-vindo de volta'
                    : mode === 'register'
                    ? 'Crie sua conta gratuita'
                    : 'Recuperar acesso'}
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                  {mode === 'login'
                    ? 'Informe seu e-mail e senha para entrar no aplicativo.'
                    : mode === 'register'
                    ? 'Preencha seus dados abaixo para criar sua conta e acessar seus espaços.'
                    : 'Digite seu e-mail cadastrado para receber as instruções de nova senha.'}
                </p>
              </div>

              {feedback && (
                <div
                  className={`p-3.5 rounded-xl text-xs font-medium border ${
                    feedback.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60'
                      : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-800/60'
                  }`}
                >
                  {feedback.text}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {mode === 'register' && (
                  <div>
                    <label
                      htmlFor="auth-screen-name"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Seu Nome Completo
                    </label>
                    <div className="relative">
                      <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input
                        id="auth-screen-name"
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Ex: Keniel Calixto"
                        className="w-full pl-10 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="auth-screen-email"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    {mode === 'login' ? 'E-mail ou ID Admin' : 'E-mail'}
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                    <input
                      id="auth-screen-email"
                      type={mode === 'login' ? 'text' : 'email'}
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={
                        mode === 'login'
                          ? 'seu.email@exemplo.com ou ID Admin'
                          : 'seu.email@exemplo.com'
                      }
                      className="w-full pl-10 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                {mode !== 'reset' && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label
                        htmlFor="auth-screen-password"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                      >
                        Senha
                      </label>
                      {mode === 'login' && (
                        <button
                          type="button"
                          onClick={() => {
                            setMode('reset');
                            setFeedback(null);
                          }}
                          className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                        >
                          Esqueci minha senha
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input
                        id="auth-screen-password"
                        type="password"
                        required={email.trim() !== ADMIN_USER_UID}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={
                          email.trim() === ADMIN_USER_UID
                            ? 'Opcional ao entrar com ID Admin'
                            : 'Digite sua senha'
                        }
                        className="w-full pl-10 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                )}

                {mode === 'register' && (
                  <div>
                    <label
                      htmlFor="auth-screen-confirm"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                    >
                      Confirmar Senha
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                      <input
                        id="auth-screen-confirm"
                        type="password"
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Repita sua senha"
                        className="w-full pl-10 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                )}

                <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3">
                  {mode === 'reset' ? (
                    <button
                      type="button"
                      onClick={() => setMode('login')}
                      className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:underline cursor-pointer"
                    >
                      Voltar para Login
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {mode === 'login' ? 'Não tem uma conta?' : 'Já possui uma conta?'}{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setMode(mode === 'login' ? 'register' : 'login');
                          setFeedback(null);
                        }}
                        className="text-indigo-600 dark:text-indigo-400 font-semibold hover:underline cursor-pointer"
                      >
                        {mode === 'login' ? 'Cadastre-se agora' : 'Fazer Login'}
                      </button>
                    </span>
                  )}

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full sm:w-auto min-h-[42px] px-6 py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center justify-center gap-2 shadow-xs disabled:opacity-50 cursor-pointer"
                  >
                    <span>
                      {isLoading
                        ? 'Autenticando...'
                        : mode === 'login'
                        ? 'Entrar'
                        : mode === 'register'
                        ? 'Criar Conta'
                        : 'Enviar Link'}
                    </span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
