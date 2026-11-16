import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  ensureFirebaseAdminInitialized,
  resolveFirebaseAdminConfig,
} from './adminInit.js';

test('FASE A — Inicialização Segura do Firebase Admin SDK (functions/adminInit.js)', async (t) => {
  await t.test('1. Falha de forma segura (fail-closed) quando nenhuma variável oficial de projeto está configurada (sem fallback demo)', () => {
    assert.throws(
      () => resolveFirebaseAdminConfig({}),
      /Nenhum projeto Firebase oficial configurado/
    );
    assert.throws(
      () =>
        resolveFirebaseAdminConfig({
          FUNCTIONS_EMULATOR: 'true',
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        }),
      /Nenhum projeto Firebase oficial configurado/
    );
  });

  await t.test('2. Falha de forma segura quando FIREBASE_CONFIG está malformada ou contém placeholder inválido', () => {
    assert.throws(
      () => resolveFirebaseAdminConfig({ FIREBASE_CONFIG: '{json-invalido' }),
      /Falha ao interpretar FIREBASE_CONFIG/
    );
    assert.throws(
      () => resolveFirebaseAdminConfig({ FIREBASE_CONFIG: '/caminho/nao-json' }),
      /deve conter um JSON válido/
    );
    assert.throws(
      () => resolveFirebaseAdminConfig({ GOOGLE_CLOUD_PROJECT: 'your-project-id' }),
      /Nenhum projeto Firebase oficial configurado/
    );
    assert.throws(
      () =>
        resolveFirebaseAdminConfig({
          FIREBASE_CONFIG: JSON.stringify({ projectId: 'proj-homolog', storageBucket: '' }),
        }),
      /storageBucket em FIREBASE_CONFIG é inválido/
    );
  });

  await t.test('3. Falha de forma segura quando variáveis oficiais de projeto são inconsistentes entre si', () => {
    assert.throws(
      () =>
        resolveFirebaseAdminConfig({
          FIREBASE_CONFIG: JSON.stringify({ projectId: 'projeto-homolog-a' }),
          GOOGLE_CLOUD_PROJECT: 'projeto-homolog-b',
        }),
      /Inconsistência entre variáveis de projeto/
    );
    assert.throws(
      () =>
        resolveFirebaseAdminConfig({
          GOOGLE_CLOUD_PROJECT: 'projeto-homolog-a',
          GCLOUD_PROJECT: 'demo-projeto-beta-v3',
        }),
      /Inconsistência entre variáveis de projeto/
    );
  });

  await t.test('4. Bloqueia projeto demo-* fora do Firebase Emulator Suite', () => {
    assert.throws(
      () =>
        resolveFirebaseAdminConfig({
          GCLOUD_PROJECT: 'demo-projeto-beta-v3',
        }),
      /não é permitido fora do Firebase Emulator Suite/
    );
    assert.throws(
      () =>
        resolveFirebaseAdminConfig({
          FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-teste' }),
        }),
      /não é permitido fora do Firebase Emulator Suite/
    );
  });

  await t.test('5. Aceita configuração oficial do Cloud Functions / Google Cloud quando consistente', () => {
    const cfg = resolveFirebaseAdminConfig({
      FIREBASE_CONFIG: JSON.stringify({
        projectId: 'projeto-beta-homolog',
        storageBucket: 'projeto-beta-homolog.firebasestorage.app',
      }),
      GOOGLE_CLOUD_PROJECT: 'projeto-beta-homolog',
    });

    assert.equal(cfg.projectId, 'projeto-beta-homolog');
    assert.equal(cfg.isEmulator, false);
    assert.deepEqual(cfg.appOptions, {
      projectId: 'projeto-beta-homolog',
      storageBucket: 'projeto-beta-homolog.firebasestorage.app',
    });
  });

  await t.test('6. Aceita projeto demo-* exclusivamente quando em execução no Firebase Emulator Suite', () => {
    const cfg = resolveFirebaseAdminConfig({
      FUNCTIONS_EMULATOR: 'true',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      GCLOUD_PROJECT: 'demo-projeto-beta-v3',
      FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-projeto-beta-v3' }),
    });

    assert.equal(cfg.projectId, 'demo-projeto-beta-v3');
    assert.equal(cfg.isEmulator, true);
  });

  await t.test('7. ensureFirebaseAdminInitialized inicializa exatamente uma vez e detecta divergência em app já inicializado', () => {
    let initCalls = 0;
    const createdApps = [];

    const first = ensureFirebaseAdminInitialized({
      env: {
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'projeto-beta-homolog' }),
      },
      getAppsImpl: () => createdApps,
      initializeAppImpl: (opts) => {
        initCalls++;
        const app = { name: '[DEFAULT]', options: opts };
        createdApps.push(app);
        return app;
      },
    });

    assert.equal(first.initializedNow, true);
    assert.equal(initCalls, 1);
    assert.equal(first.app.options.projectId, 'projeto-beta-homolog');

    const second = ensureFirebaseAdminInitialized({
      env: {
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'projeto-beta-homolog' }),
      },
      getAppsImpl: () => createdApps,
      initializeAppImpl: () => {
        throw new Error('Não deveria reinicializar');
      },
    });
    assert.equal(second.initializedNow, false);
    assert.equal(second.app, first.app);

    assert.throws(
      () =>
        ensureFirebaseAdminInitialized({
          env: {
            GOOGLE_CLOUD_PROJECT: 'outro-projeto',
          },
          getAppsImpl: () => createdApps,
          initializeAppImpl: () => first.app,
        }),
      /divergente do projeto oficial do ambiente/
    );
  });

  await t.test('8. functions/index.js falha na carga sem variáveis oficiais e carrega em modo discovery (FUNCTIONS_CONTROL_API=true)', () => {
    const functionsIndexPath = path.resolve(process.cwd(), 'functions/index.js');
    const importUrl = new URL(`file:///${functionsIndexPath.replace(/\\/g, '/')}`).href;

    const cleanEnv = { ...process.env };
    delete cleanEnv.FIREBASE_CONFIG;
    delete cleanEnv.GOOGLE_CLOUD_PROJECT;
    delete cleanEnv.GCLOUD_PROJECT;
    delete cleanEnv.FUNCTIONS_EMULATOR;
    delete cleanEnv.FIRESTORE_EMULATOR_HOST;
    delete cleanEnv.FIREBASE_AUTH_EMULATOR_HOST;
    delete cleanEnv.FIREBASE_STORAGE_EMULATOR_HOST;
    delete cleanEnv.FUNCTIONS_CONTROL_API;

    assert.throws(() => {
      execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(importUrl)});`], {
        env: cleanEnv,
        stdio: 'pipe',
      });
    });

    const discoveryOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const mod = await import(${JSON.stringify(importUrl)}); console.log(typeof mod.createSpaceOfficial);`,
      ],
      {
        env: { ...cleanEnv, FUNCTIONS_CONTROL_API: 'true' },
        encoding: 'utf8',
      }
    );
    assert.equal(discoveryOutput.trim(), 'function');
  });
});
