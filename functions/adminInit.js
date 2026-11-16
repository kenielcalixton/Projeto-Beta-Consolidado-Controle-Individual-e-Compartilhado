import { getApps, initializeApp } from 'firebase-admin/app';

const INVALID_PROJECT_PLACEHOLDERS = new Set([
  'undefined',
  'null',
  'your-project-id',
  'seu_projeto_prod',
  'my-project-id',
]);

/**
 * Detecta se o processo está executando dentro do Firebase Emulator Suite.
 */
export function isEmulatorEnvironment(env = process.env) {
  return (
    env.FUNCTIONS_EMULATOR === 'true' ||
    Boolean(env.FIRESTORE_EMULATOR_HOST && String(env.FIRESTORE_EMULATOR_HOST).trim()) ||
    Boolean(env.FIREBASE_AUTH_EMULATOR_HOST && String(env.FIREBASE_AUTH_EMULATOR_HOST).trim()) ||
    Boolean(env.FIREBASE_STORAGE_EMULATOR_HOST && String(env.FIREBASE_STORAGE_EMULATOR_HOST).trim()) ||
    Boolean(env.FIREBASE_DATABASE_EMULATOR_HOST && String(env.FIREBASE_DATABASE_EMULATOR_HOST).trim())
  );
}

/**
 * Faz o parse estrito de `FIREBASE_CONFIG` quando presente no ambiente oficial do Cloud Functions.
 */
export function parseFirebaseConfigEnv(rawFirebaseConfig) {
  if (rawFirebaseConfig === undefined || rawFirebaseConfig === null) {
    return null;
  }
  const trimmed = String(rawFirebaseConfig).trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith('{')) {
    throw new Error(
      '[Firebase Admin Config Error] Variável FIREBASE_CONFIG deve conter um JSON válido de configuração oficial do Firebase.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `[Firebase Admin Config Error] Falha ao interpretar FIREBASE_CONFIG como JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      '[Firebase Admin Config Error] FIREBASE_CONFIG deve representar um objeto JSON válido.'
    );
  }
  return parsed;
}

/**
 * Resolve e valida a configuração oficial do Firebase Admin SDK a partir do ambiente.
 * Falha de forma segura (fail-closed) se a configuração estiver ausente, malformada,
 * inconsistente entre variáveis oficiais ou tentar usar projeto `demo-*` fora do emulador.
 * Nunca faz fallback silencioso para projetos demo ou legados.
 */
export function resolveFirebaseAdminConfig(env = process.env) {
  const isEmulator = isEmulatorEnvironment(env);
  const parsedFirebaseConfig = parseFirebaseConfigEnv(env.FIREBASE_CONFIG);

  const firebaseConfigProjectId =
    typeof parsedFirebaseConfig?.projectId === 'string'
      ? parsedFirebaseConfig.projectId.trim()
      : '';
  const googleCloudProject =
    typeof env.GOOGLE_CLOUD_PROJECT === 'string' ? env.GOOGLE_CLOUD_PROJECT.trim() : '';
  const gcloudProject =
    typeof env.GCLOUD_PROJECT === 'string' ? env.GCLOUD_PROJECT.trim() : '';

  const candidateProjectIds = [
    firebaseConfigProjectId,
    googleCloudProject,
    gcloudProject,
  ].filter(Boolean);
  const uniqueProjectIds = Array.from(new Set(candidateProjectIds));

  if (uniqueProjectIds.length > 1) {
    throw new Error(
      `[Firebase Admin Config Error] Inconsistência entre variáveis de projeto no ambiente (${uniqueProjectIds.join(
        ' vs '
      )}). Verifique FIREBASE_CONFIG, GOOGLE_CLOUD_PROJECT e GCLOUD_PROJECT.`
    );
  }

  const projectId = uniqueProjectIds[0] || '';
  if (!projectId || INVALID_PROJECT_PLACEHOLDERS.has(projectId.toLowerCase())) {
    throw new Error(
      '[Firebase Admin Config Error] Nenhum projeto Firebase oficial configurado no ambiente (FIREBASE_CONFIG, GOOGLE_CLOUD_PROJECT ou GCLOUD_PROJECT ausentes ou inválidos). Fallback silencioso para projeto demo ou legado está desativado.'
    );
  }

  if (!isEmulator && projectId.startsWith('demo-')) {
    throw new Error(
      `[Firebase Admin Config Error] Projeto de demonstração/emulador ("${projectId}") não é permitido fora do Firebase Emulator Suite.`
    );
  }

  if (
    parsedFirebaseConfig?.storageBucket !== undefined &&
    (typeof parsedFirebaseConfig.storageBucket !== 'string' ||
      !parsedFirebaseConfig.storageBucket.trim())
  ) {
    throw new Error(
      '[Firebase Admin Config Error] Campo storageBucket em FIREBASE_CONFIG é inválido.'
    );
  }

  const appOptions = {
    ...(parsedFirebaseConfig || {}),
    projectId,
  };

  return {
    projectId,
    isEmulator,
    appOptions,
    sources: {
      firebaseConfigProjectId: firebaseConfigProjectId || null,
      googleCloudProject: googleCloudProject || null,
      gcloudProject: gcloudProject || null,
    },
  };
}

/**
 * Valida o ambiente oficial e garante a inicialização única e consistente do Firebase Admin SDK.
 */
export function ensureFirebaseAdminInitialized(options = {}) {
  const {
    env = process.env,
    getAppsImpl = getApps,
    initializeAppImpl = initializeApp,
  } = options;

  const config = resolveFirebaseAdminConfig(env);
  const existingApps = getAppsImpl();

  if (existingApps.length > 0) {
    const existingApp = existingApps[0];
    const existingProjectId = existingApp?.options?.projectId;
    if (existingProjectId && existingProjectId !== config.projectId) {
      throw new Error(
        `[Firebase Admin Config Error] Instância Firebase Admin já inicializada para o projeto "${existingProjectId}", divergente do projeto oficial do ambiente "${config.projectId}".`
      );
    }
    return {
      app: existingApp,
      config,
      initializedNow: false,
    };
  }

  const app = initializeAppImpl(config.appOptions);
  return {
    app,
    config,
    initializedNow: true,
  };
}
