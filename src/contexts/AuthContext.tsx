import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../services/firebase';
import {
  CanonicalAuthUser,
  formatAuthError,
  loginWithEmailPassword,
  loginWithGoogle as authLoginWithGoogle,
  logoutUser,
  mapFirebaseUser,
  registerWithEmailPassword,
  sendPasswordReset,
  updateUserDisplayName,
} from '../services/authService';
import { universalStorage } from '../utils/universalStorage';

const PRIVATE_FINANCE_STORAGE_KEYS = [
  'mpf_active_demo_profile',
  'mpf_v3_demo_accounts',
  'mpf_v3_demo_movements',
  'mpf_v3_demo_personal_transactions',
  'mpf_v3_demo_transaction_payments',
  'mpf_v3_demo_card_invoices',
  'mpf_v3_demo_invoice_payments',
  'mpf_v3_demo_invoice_carry_overs',
  'mpf_v3_demo_internal_transfers',
  'mpf_v3_demo_budgets',
  'mpf_v3_demo_personal_refunds',
  'mpf_v3_demo_refund_receipts',
  'mpf_v3_demo_categories',
];

/**
 * Interface dos dados e métodos disponibilizados pelo AuthContext.
 */
export interface AuthContextType {
  /** Usuário autenticado com UID canônico, ou null se deslogado */
  user: CanonicalAuthUser | null;
  /** UID canônico e imutável do usuário autenticado (ou null) */
  uid: string | null;
  /** Booleano que indica se o usuário possui sessão ativa válida */
  isAuthenticated: boolean;
  /** Indica se a validação inicial da sessão do Firebase Auth já foi concluída */
  authReady: boolean;
  /** Indica se alguma operação de autenticação está em processamento */
  loading: boolean;
  /** Mensagem amigável de erro recente, se houver */
  error: string | null;
  /** Realiza login com e-mail e senha */
  login: (email: string, pass: string) => Promise<CanonicalAuthUser>;
  /** Realiza cadastro de novo usuário com nome, e-mail e senha */
  register: (name: string, email: string, pass: string) => Promise<CanonicalAuthUser>;
  /** Encerra a sessão ativa do usuário no Firebase */
  logout: () => Promise<void>;
  /** Dispara envio de link para recuperação e redefinição de senha */
  resetPassword: (email: string) => Promise<void>;
  /** Realiza login via pop-up com Google */
  loginWithGoogle: () => Promise<CanonicalAuthUser>;
  /** Entra em sessão local de demonstração (para testes e transição) */
  enterDemoMode: (profile: { uid: string; name: string; email: string }) => void;
  /** Atualiza nome de exibição do usuário no Auth, Firestore e sessão local */
  updateDisplayName: (newName: string) => Promise<string>;
  /** Limpa qualquer mensagem de erro do estado */
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<CanonicalAuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Monitora o estado de autenticação oficial do Firebase (apenas 1 listener central)
  useEffect(() => {
    let isMounted = true;

    // Checa se havia sessão demo persistida localmente
    let hasRestoredDemo = false;
    try {
      const savedDemoRaw = localStorage.getItem('mpf_active_demo_profile');
      if (savedDemoRaw) {
        const demoProfile = JSON.parse(savedDemoRaw);
        if (demoProfile?.uid && isMounted) {
          setUser({
            uid: demoProfile.uid,
            displayName: demoProfile.name || 'Usuário Demonstração',
            email: demoProfile.email || 'demo@meupainel.com',
            emailVerified: true,
            isAnonymous: false,
            photoURL: null,
            isDemo: true,
          });
          hasRestoredDemo = true;
        }
      }
    } catch {}

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (!isMounted) return;

      if (firebaseUser) {
        // Remove qualquer rastro de modo demo se há usuário real autenticado
        try {
          localStorage.removeItem('mpf_active_demo_profile');
        } catch {}

        const mapped = mapFirebaseUser(firebaseUser, false);
        setUser(mapped);
      } else if (!hasRestoredDemo) {
        setUser(null);
      }

      setAuthReady(true);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (email: string, pass: string): Promise<CanonicalAuthUser> => {
    setLoading(true);
    setError(null);
    try {
      const loggedUser = await loginWithEmailPassword(email, pass);
      setUser(loggedUser);
      return loggedUser;
    } catch (err: unknown) {
      const friendlyMessage = formatAuthError(err);
      setError(friendlyMessage);
      throw new Error(friendlyMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(
    async (name: string, email: string, pass: string): Promise<CanonicalAuthUser> => {
      setLoading(true);
      setError(null);
      try {
        const newUser = await registerWithEmailPassword(name, email, pass);
        setUser(newUser);
        return newUser;
      } catch (err: unknown) {
        const friendlyMessage = formatAuthError(err);
        setError(friendlyMessage);
        throw new Error(friendlyMessage);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const logout = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      try {
        for (const key of PRIVATE_FINANCE_STORAGE_KEYS) {
          universalStorage.removeItem(key);
          localStorage.removeItem(key);
        }
      } catch {}

      if (user && !user.isDemo) {
        await logoutUser();
      }
      setUser(null);
    } catch (err: unknown) {
      const friendlyMessage = formatAuthError(err);
      setError(friendlyMessage);
      throw new Error(friendlyMessage);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const resetPassword = useCallback(async (email: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await sendPasswordReset(email);
    } catch (err: unknown) {
      const friendlyMessage = formatAuthError(err);
      setError(friendlyMessage);
      throw new Error(friendlyMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  const loginWithGoogle = useCallback(async (): Promise<CanonicalAuthUser> => {
    setLoading(true);
    setError(null);
    try {
      const loggedUser = await authLoginWithGoogle();
      setUser(loggedUser);
      return loggedUser;
    } catch (err: unknown) {
      const friendlyMessage = formatAuthError(err);
      setError(friendlyMessage);
      throw new Error(friendlyMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  const enterDemoMode = useCallback((profile: { uid: string; name: string; email: string }) => {
    try {
      localStorage.setItem('mpf_active_demo_profile', JSON.stringify(profile));
    } catch {}
    setUser({
      uid: profile.uid,
      displayName: profile.name,
      email: profile.email,
      emailVerified: true,
      isAnonymous: false,
      photoURL: null,
      isDemo: true,
    });
    setError(null);
  }, []);

  const updateDisplayName = useCallback(
    async (newName: string): Promise<string> => {
      const cleanName = newName.trim().slice(0, 100);
      if (cleanName.length < 2) {
        throw new Error('O nome de exibição deve conter pelo menos 2 caracteres.');
      }

      if (!user) {
        throw new Error('Nenhum usuário autenticado para atualizar.');
      }

      if (user.isDemo) {
        try {
          const savedRaw = localStorage.getItem('mpf_active_demo_profile');
          const parsed = savedRaw ? JSON.parse(savedRaw) : { uid: user.uid, email: user.email };
          localStorage.setItem(
            'mpf_active_demo_profile',
            JSON.stringify({ ...parsed, name: cleanName })
          );
        } catch {}
        setUser((prev) => (prev ? { ...prev, displayName: cleanName } : prev));
        return cleanName;
      }

      const persistedName = await updateUserDisplayName(cleanName);
      setUser((prev) => (prev ? { ...prev, displayName: persistedName } : prev));
      return persistedName;
    },
    [user]
  );

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      uid: user?.uid ?? null,
      isAuthenticated: !!user,
      authReady,
      loading,
      error,
      login,
      register,
      logout,
      resetPassword,
      loginWithGoogle,
      enterDemoMode,
      updateDisplayName,
      clearError,
    }),
    [
      user,
      authReady,
      loading,
      error,
      login,
      register,
      logout,
      resetPassword,
      loginWithGoogle,
      enterDemoMode,
      updateDisplayName,
      clearError,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * Hook customizado para acesso tipado e seguro ao contexto de autenticação.
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser utilizado obrigatoriamente dentro de um <AuthProvider>');
  }
  return context;
}
