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
const SAMPLE_IMAGE_BYTES = new Uint8Array(Buffer.from('PNG_SAMPLE_PAYLOAD_RC1'));
const SAMPLE_PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.4\n%Sample Receipt'));

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
        adminStorage.ref('users/uid_alice/receipts/recibo_existente.pdf'),
        SAMPLE_PDF_BYTES,
        'application/pdf'
      );
      await putAsPromise(
        adminStorage.ref('users/uid_alice/avatars/avatar_existente.png'),
        SAMPLE_IMAGE_BYTES,
        'image/png'
      );
      await putAsPromise(
        adminStorage.ref('spaces/space_1/legado_ou_indevido.txt'),
        SAMPLE_IMAGE_BYTES,
        'text/plain'
      );
    });
  });

  await t.test('1. Funcionalidade legítima em users/{uid}/...: titular cria, atualiza, lê e remove arquivos conformes', async () => {
    const aliceStorage = testEnv.authenticatedContext('uid_alice').storage();

    const receiptPdfRef = aliceStorage.ref('users/uid_alice/receipts/1700000000_nota.pdf');
    const receiptImgRef = aliceStorage.ref('users/uid_alice/receipts/1700000001_nota.webp');
    const avatarRef = aliceStorage.ref('users/uid_alice/avatars/1700000001_avatar.png');
    const productRef = aliceStorage.ref('users/uid_alice/products/1700000002_item.jpg');
    const existingReceiptRef = aliceStorage.ref('users/uid_alice/receipts/recibo_existente.pdf');
    const existingAvatarRef = aliceStorage.ref('users/uid_alice/avatars/avatar_existente.png');

    await assertSucceeds(putAsPromise(receiptPdfRef, SAMPLE_PDF_BYTES, 'application/pdf'));
    await assertSucceeds(putAsPromise(receiptImgRef, SAMPLE_IMAGE_BYTES, 'image/webp'));
    await assertSucceeds(putAsPromise(avatarRef, SAMPLE_IMAGE_BYTES, 'image/png'));
    await assertSucceeds(putAsPromise(productRef, SAMPLE_IMAGE_BYTES, 'image/jpeg'));

    // Atualização (sobrescrita) legítima com MIME e tamanho válidos
    await assertSucceeds(putAsPromise(existingAvatarRef, SAMPLE_IMAGE_BYTES, 'image/jpeg'));

    await assertSucceeds(existingReceiptRef.getDownloadURL());
    await assertSucceeds(existingReceiptRef.getMetadata());
    await assertSucceeds(receiptPdfRef.getDownloadURL());
    await assertSucceeds(receiptPdfRef.delete());
  });

  await t.test('2. Isolamento entre usuários: usuário autenticado não lê, altera, cria ou exclui arquivos de outro UID', async () => {
    const bobStorage = testEnv.authenticatedContext('uid_bob').storage();

    const aliceExistingRef = bobStorage.ref('users/uid_alice/receipts/recibo_existente.pdf');
    const aliceNewRef = bobStorage.ref('users/uid_alice/avatars/invasao.png');
    const aliceFolderRef = bobStorage.ref('users/uid_alice/receipts');

    await assertFails(aliceExistingRef.getDownloadURL());
    await assertFails(aliceExistingRef.getMetadata());
    await assertFails(aliceExistingRef.delete());
    await assertFails(aliceFolderRef.listAll());
    await assertFails(putAsPromise(aliceNewRef, SAMPLE_IMAGE_BYTES, 'image/png'));
  });

  await t.test('3. Bloqueio anônimo: usuário não autenticado não acessa arquivos privados nem prefixo /spaces/', async () => {
    const unauthStorage = testEnv.unauthenticatedContext().storage();

    const alicePrivateRef = unauthStorage.ref('users/uid_alice/receipts/recibo_existente.pdf');
    const aliceUploadRef = unauthStorage.ref('users/uid_alice/receipts/anonimo.pdf');
    const spaceRef = unauthStorage.ref('spaces/space_1/legado_ou_indevido.txt');
    const spaceUploadRef = unauthStorage.ref('spaces/space_1/anonimo.pdf');

    await assertFails(alicePrivateRef.getDownloadURL());
    await assertFails(alicePrivateRef.getMetadata());
    await assertFails(alicePrivateRef.delete());
    await assertFails(putAsPromise(aliceUploadRef, SAMPLE_PDF_BYTES, 'application/pdf'));

    await assertFails(spaceRef.getDownloadURL());
    await assertFails(spaceRef.getMetadata());
    await assertFails(putAsPromise(spaceUploadRef, SAMPLE_PDF_BYTES, 'application/pdf'));
  });

  await t.test('4. Negação explícita em /spaces/{spaceId}/... e pastas não autorizadas fora de avatars/products/receipts', async () => {
    const aliceStorage = testEnv.authenticatedContext('uid_alice').storage();
    const bobStorage = testEnv.authenticatedContext('uid_bob').storage();

    const aliceSpaceExisting = aliceStorage.ref('spaces/space_1/legado_ou_indevido.txt');
    const aliceSpaceUpload = aliceStorage.ref('spaces/space_1/comprovante.pdf');
    const bobSpaceExisting = bobStorage.ref('spaces/space_1/legado_ou_indevido.txt');
    const bobSpaceUpload = bobStorage.ref('spaces/space_2/invasao.pdf');
    const bobSpaceFolder = bobStorage.ref('spaces/space_1');
    const arbitraryPrefix = aliceStorage.ref('public/qualquer.png');
    const unauthorizedUserSubfolder = aliceStorage.ref('users/uid_alice/executaveis/payload.png');

    await assertFails(aliceSpaceExisting.getDownloadURL());
    await assertFails(aliceSpaceExisting.getMetadata());
    await assertFails(aliceSpaceExisting.delete());
    await assertFails(putAsPromise(aliceSpaceUpload, SAMPLE_PDF_BYTES, 'application/pdf'));

    await assertFails(bobSpaceExisting.getDownloadURL());
    await assertFails(putAsPromise(bobSpaceUpload, SAMPLE_PDF_BYTES, 'application/pdf'));
    await assertFails(bobSpaceFolder.listAll());
    await assertFails(putAsPromise(arbitraryPrefix, SAMPLE_IMAGE_BYTES, 'image/png'));
    await assertFails(putAsPromise(unauthorizedUserSubfolder, SAMPLE_IMAGE_BYTES, 'image/png'));
  });

  await t.test('5. Limites de tamanho e validação estrita de MIME type (inclusive em update/sobrescrita)', async () => {
    const aliceStorage = testEnv.authenticatedContext('uid_alice').storage();

    const emptyBytes = new Uint8Array(0);
    const over2MiB = new Uint8Array(2 * 1024 * 1024 + 1);
    const over5MiB = new Uint8Array(5 * 1024 * 1024 + 1);

    // Arquivo vazio (0 bytes) rejeitado
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/avatars/vazio.png'), emptyBytes, 'image/png')
    );

    // Excesso de tamanho: > 2 MiB para avatars e > 5 MiB para products/receipts
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/avatars/grande.png'), over2MiB, 'image/png')
    );
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/products/grande.jpg'), over5MiB, 'image/jpeg')
    );
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/receipts/grande.pdf'), over5MiB, 'application/pdf')
    );

    // MIME types perigosos / não permitidos rejeitados na criação e na atualização
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/receipts/xss.html'), SAMPLE_IMAGE_BYTES, 'text/html')
    );
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/receipts/script.js'), SAMPLE_IMAGE_BYTES, 'application/javascript')
    );
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/receipts/texto.txt'), SAMPLE_IMAGE_BYTES, 'text/plain')
    );
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/avatars/doc.pdf'), SAMPLE_PDF_BYTES, 'application/pdf')
    );
    await assertFails(
      putAsPromise(aliceStorage.ref('users/uid_alice/products/doc.pdf'), SAMPLE_PDF_BYTES, 'application/pdf')
    );
    await assertFails(
      putAsPromise(
        aliceStorage.ref('users/uid_alice/avatars/avatar_existente.png'),
        SAMPLE_IMAGE_BYTES,
        'text/html'
      )
    );
  });
});
