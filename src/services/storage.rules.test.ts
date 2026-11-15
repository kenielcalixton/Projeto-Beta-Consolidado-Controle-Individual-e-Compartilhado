import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

const PROJECT_ID = 'demo-projeto-beta-v3';
const SAMPLE_BYTES = new Uint8Array(Buffer.from('Comprovante RC1 Storage Rules Test'));

function putAsPromise(
  storageRef: ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['storage']>['ref'] extends (
    path?: string
  ) => infer R
    ? R
    : never,
  bytes: Uint8Array,
  contentType: string
): Promise<unknown> {
  return Promise.resolve(storageRef.put(bytes, { contentType }));
}

test('STORAGE SECURITY RULES — Validação Real no Storage Emulator', async (t) => {
  const rulesPath = path.resolve(process.cwd(), 'storage.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  let testEnv: RulesTestEnvironment;

  t.before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      storage: {
        host: '127.0.0.1',
        port: 9199,
        rules,
      },
    });
  });

  t.after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  t.beforeEach(async () => {
    await testEnv.clearStorage();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminStorage = context.storage();
      await putAsPromise(
        adminStorage.ref('users/uid_alice/receipts/recibo_existente.txt'),
        SAMPLE_BYTES,
        'text/plain'
      );
      await putAsPromise(
        adminStorage.ref('spaces/space_1/legado_ou_indevido.txt'),
        SAMPLE_BYTES,
        'text/plain'
      );
    });
  });

  await t.test('1. Funcionalidade legítima em users/{uid}/...: usuário autenticado lê, grava e remove seus próprios arquivos', async () => {
    const aliceStorage = testEnv.authenticatedContext('uid_alice').storage();

    const receiptRef = aliceStorage.ref('users/uid_alice/receipts/1700000000_nota.txt');
    const avatarRef = aliceStorage.ref('users/uid_alice/avatars/1700000001_avatar.png');
    const productRef = aliceStorage.ref('users/uid_alice/products/1700000002_item.jpg');
    const existingRef = aliceStorage.ref('users/uid_alice/receipts/recibo_existente.txt');

    await assertSucceeds(putAsPromise(receiptRef, SAMPLE_BYTES, 'text/plain'));
    await assertSucceeds(putAsPromise(avatarRef, SAMPLE_BYTES, 'image/png'));
    await assertSucceeds(putAsPromise(productRef, SAMPLE_BYTES, 'image/jpeg'));

    await assertSucceeds(existingRef.getDownloadURL());
    await assertSucceeds(existingRef.getMetadata());
    await assertSucceeds(receiptRef.getDownloadURL());
    await assertSucceeds(receiptRef.delete());
  });

  await t.test('2. Isolamento entre usuários: usuário autenticado não acessa nem altera arquivos de outro usuário', async () => {
    const bobStorage = testEnv.authenticatedContext('uid_bob').storage();

    const aliceExistingRef = bobStorage.ref('users/uid_alice/receipts/recibo_existente.txt');
    const aliceNewRef = bobStorage.ref('users/uid_alice/avatars/invasao.png');
    const aliceFolderRef = bobStorage.ref('users/uid_alice/receipts');

    await assertFails(aliceExistingRef.getDownloadURL());
    await assertFails(aliceExistingRef.getMetadata());
    await assertFails(aliceExistingRef.delete());
    await assertFails(aliceFolderRef.listAll());
    await assertFails(putAsPromise(aliceNewRef, SAMPLE_BYTES, 'image/png'));
  });

  await t.test('3. Bloqueio anônimo: usuário não autenticado não acessa arquivos privados nem prefixo /spaces/', async () => {
    const unauthStorage = testEnv.unauthenticatedContext().storage();

    const alicePrivateRef = unauthStorage.ref('users/uid_alice/receipts/recibo_existente.txt');
    const aliceUploadRef = unauthStorage.ref('users/uid_alice/receipts/anonimo.txt');
    const spaceRef = unauthStorage.ref('spaces/space_1/legado_ou_indevido.txt');
    const spaceUploadRef = unauthStorage.ref('spaces/space_1/anonimo.txt');

    await assertFails(alicePrivateRef.getDownloadURL());
    await assertFails(alicePrivateRef.getMetadata());
    await assertFails(alicePrivateRef.delete());
    await assertFails(putAsPromise(aliceUploadRef, SAMPLE_BYTES, 'text/plain'));

    await assertFails(spaceRef.getDownloadURL());
    await assertFails(spaceRef.getMetadata());
    await assertFails(putAsPromise(spaceUploadRef, SAMPLE_BYTES, 'text/plain'));
  });

  await t.test('4. Negação explícita em /spaces/{spaceId}/...: usuários autenticados não têm acesso indiscriminado', async () => {
    const aliceStorage = testEnv.authenticatedContext('uid_alice').storage();
    const bobStorage = testEnv.authenticatedContext('uid_bob').storage();

    const aliceSpaceExisting = aliceStorage.ref('spaces/space_1/legado_ou_indevido.txt');
    const aliceSpaceUpload = aliceStorage.ref('spaces/space_1/comprovante.txt');
    const bobSpaceExisting = bobStorage.ref('spaces/space_1/legado_ou_indevido.txt');
    const bobSpaceUpload = bobStorage.ref('spaces/space_2/invasao.txt');
    const bobSpaceFolder = bobStorage.ref('spaces/space_1');
    const arbitraryPrefix = aliceStorage.ref('public/qualquer.txt');

    await assertFails(aliceSpaceExisting.getDownloadURL());
    await assertFails(aliceSpaceExisting.getMetadata());
    await assertFails(aliceSpaceExisting.delete());
    await assertFails(putAsPromise(aliceSpaceUpload, SAMPLE_BYTES, 'text/plain'));

    await assertFails(bobSpaceExisting.getDownloadURL());
    await assertFails(putAsPromise(bobSpaceUpload, SAMPLE_BYTES, 'text/plain'));
    await assertFails(bobSpaceFolder.listAll());
    await assertFails(putAsPromise(arbitraryPrefix, SAMPLE_BYTES, 'text/plain'));
  });
});
