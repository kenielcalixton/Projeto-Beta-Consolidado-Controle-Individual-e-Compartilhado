import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OFFLINE_DATA_URL_CHARS,
  MAX_OFFLINE_DATA_URL_RAW_BYTES,
  STORAGE_MAX_BYTES_BY_FOLDER,
  uploadFileToFirebaseStorage,
  validateStorageUploadFile,
} from './acquisitionsFirebase';

function createMockFile(name: string, size: number, type: string): File {
  const bytes = new Uint8Array(Math.min(size, 64));
  const file = new File([bytes], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

test('FASE C — Validação de Upload no Storage e Proteção contra Fallback Base64 Excessivo', async (t) => {
  await t.test('1. validateStorageUploadFile aprova arquivos válidos por pasta e rejeita vazios, oversized ou MIME proibido', () => {
    assert.deepEqual(
      validateStorageUploadFile(createMockFile('foto.png', 1024, 'image/png'), 'avatars'),
      { normalizedMime: 'image/png', maxBytes: STORAGE_MAX_BYTES_BY_FOLDER.avatars }
    );
    assert.deepEqual(
      validateStorageUploadFile(createMockFile('nota.pdf', 1024, 'application/pdf'), 'receipts'),
      { normalizedMime: 'application/pdf', maxBytes: STORAGE_MAX_BYTES_BY_FOLDER.receipts }
    );

    assert.throws(
      () => validateStorageUploadFile(createMockFile('vazio.png', 0, 'image/png'), 'avatars'),
      /Arquivo vazio/
    );
    assert.throws(
      () =>
        validateStorageUploadFile(
          createMockFile('gigante.png', STORAGE_MAX_BYTES_BY_FOLDER.avatars + 1, 'image/png'),
          'avatars'
        ),
      /excede o limite máximo/
    );
    assert.throws(
      () => validateStorageUploadFile(createMockFile('nota.pdf', 1024, 'application/pdf'), 'avatars'),
      /Tipo de arquivo não permitido/
    );
    assert.throws(
      () => validateStorageUploadFile(createMockFile('xss.html', 512, 'text/html'), 'receipts'),
      /Tipo de arquivo não permitido/
    );
  });

  await t.test('2. Em sessão autenticada no Firebase, falha de upload no Storage NÃO cai em base64 (falha explicitamente)', async () => {
    const smallImg = createMockFile('avatar.png', 1024, 'image/png');
    let readCalled = false;

    await assert.rejects(
      uploadFileToFirebaseStorage(smallImg, 'avatars', 'uid_alice', {
        hasAuthenticatedSession: () => true,
        uploadToStorage: async () => {
          throw new Error('storage/unauthorized');
        },
        readAsDataUrl: async () => {
          readCalled = true;
          return 'data:image/png;base64,AAAA';
        },
      }),
      /Falha ao enviar arquivo para o Firebase Storage/
    );
    assert.equal(readCalled, false);
  });

  await t.test('3. Em modo offline/demo sem sessão Firebase, fallback base64 é bloqueado acima de 48 KiB, para PDFs ou strings > 70k chars', async () => {
    const bigImg = createMockFile('grande.png', MAX_OFFLINE_DATA_URL_RAW_BYTES + 1, 'image/png');
    const pdfFile = createMockFile('recibo.pdf', 2048, 'application/pdf');
    const tinyImg = createMockFile('mini.png', 2048, 'image/png');

    await assert.rejects(
      uploadFileToFirebaseStorage(bigImg, 'receipts', 'demo_user', {
        hasAuthenticatedSession: () => false,
        uploadToStorage: async () => {
          throw new Error('offline');
        },
      }),
      /fallback local em base64 é bloqueado/
    );

    await assert.rejects(
      uploadFileToFirebaseStorage(pdfFile, 'receipts', 'demo_user', {
        hasAuthenticatedSession: () => false,
        uploadToStorage: async () => {
          throw new Error('offline');
        },
      }),
      /fallback local em base64 é bloqueado/
    );

    await assert.rejects(
      uploadFileToFirebaseStorage(tinyImg, 'avatars', 'demo_user', {
        hasAuthenticatedSession: () => false,
        uploadToStorage: async () => {
          throw new Error('offline');
        },
        readAsDataUrl: async () => `data:image/png;base64,${'A'.repeat(MAX_OFFLINE_DATA_URL_CHARS)}`,
      }),
      /excedeu o limite seguro de tamanho/
    );

    const okUrl = await uploadFileToFirebaseStorage(tinyImg, 'avatars', 'demo_user', {
      hasAuthenticatedSession: () => false,
      uploadToStorage: async () => {
        throw new Error('offline');
      },
      readAsDataUrl: async () => 'data:image/png;base64,iVBORw0KGgo=',
    });
    assert.equal(okUrl, 'data:image/png;base64,iVBORw0KGgo=');
  });

  await t.test('4. Upload bem-sucedido retorna downloadURL sem acionar fallback base64', async () => {
    const file = createMockFile('recibo.pdf', 4096, 'application/pdf');
    let capturedPath = '';
    let capturedMime = '';

    const url = await uploadFileToFirebaseStorage(file, 'receipts', 'uid_alice', {
      hasAuthenticatedSession: () => true,
      uploadToStorage: async (storagePath, _file, contentType) => {
        capturedPath = storagePath;
        capturedMime = contentType;
        return 'https://storage.googleapis.com/bucket/recibo.pdf';
      },
    });

    assert.equal(url, 'https://storage.googleapis.com/bucket/recibo.pdf');
    assert.match(capturedPath, /^users\/uid_alice\/receipts\/\d+_recibo\.pdf$/);
    assert.equal(capturedMime, 'application/pdf');
  });
});
