import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmail,
  validatePassword,
  validateRegistration,
  formatAuthError,
  mapFirebaseUser,
} from './authService';
import { User as FirebaseUser } from 'firebase/auth';

describe('AuthService — Validação de Entradas e Regras de Identidade', () => {
  describe('validateEmail', () => {
    it('deve aceitar endereços de e-mail válidos', () => {
      const validEmails = [
        'usuario@dominio.com',
        'keniel.calixto@empresa.com.br',
        'financeiro+teste@sub.dominio.org',
      ];
      for (const email of validEmails) {
        const result = validateEmail(email);
        assert.equal(result.isValid, true, `Deveria ser válido: ${email}`);
        assert.equal(result.error, undefined);
      }
    });

    it('deve rejeitar e-mails vazios ou apenas com espaços', () => {
      const emptyResult = validateEmail('');
      assert.equal(emptyResult.isValid, false);
      assert.match(emptyResult.error || '', /obrigatório/i);

      const spaceResult = validateEmail('   ');
      assert.equal(spaceResult.isValid, false);
    });

    it('deve rejeitar formatos de e-mail semanticamente inválidos', () => {
      const invalidEmails = [
        'sem-arroba',
        'usuario@',
        '@dominio.com',
        'usuario@dominio',
        'usuario space@dominio.com',
      ];
      for (const email of invalidEmails) {
        const result = validateEmail(email);
        assert.equal(result.isValid, false, `Deveria ser inválido: ${email}`);
        assert.match(result.error || '', /válido/i);
      }
    });
  });

  describe('validatePassword', () => {
    it('deve aprovar senhas com 6 ou mais caracteres', () => {
      assert.equal(validatePassword('123456').isValid, true);
      assert.equal(validatePassword('SenhaForte@2026').isValid, true);
    });

    it('deve rejeitar senhas vazias ou com menos de 6 caracteres', () => {
      const empty = validatePassword('');
      assert.equal(empty.isValid, false);
      assert.match(empty.error || '', /obrigatória/i);

      const short = validatePassword('12345');
      assert.equal(short.isValid, false);
      assert.match(short.error || '', /6 caracteres/i);
    });
  });

  describe('validateRegistration', () => {
    it('deve validar com sucesso cadastro com todos os campos conformes', () => {
      const res = validateRegistration(
        'Keniel Calixto',
        'keniel@exemplo.com',
        'SenhaSegura123',
        'SenhaSegura123'
      );
      assert.equal(res.isValid, true);
      assert.equal(res.error, undefined);
    });

    it('deve exigir nome completo com pelo menos 2 caracteres', () => {
      const emptyName = validateRegistration('', 'user@email.com', '123456', '123456');
      assert.equal(emptyName.isValid, false);
      assert.match(emptyName.error || '', /nome completo/i);

      const shortName = validateRegistration('A', 'user@email.com', '123456', '123456');
      assert.equal(shortName.isValid, false);
      assert.match(shortName.error || '', /pelo menos 2 caracteres/i);
    });

    it('deve rejeitar quando confirmação de senha não confere', () => {
      const mismatch = validateRegistration(
        'Keniel Calixto',
        'user@email.com',
        'SenhaA123',
        'SenhaB456'
      );
      assert.equal(mismatch.isValid, false);
      assert.match(mismatch.error || '', /não confere/i);
    });
  });

  describe('formatAuthError — Mapeamento Amigável de Erros Firebase', () => {
    it('deve traduzir credenciais inválidas para mensagem explicativa', () => {
      const msg = formatAuthError({ code: 'auth/invalid-credential' });
      assert.match(msg, /E-mail ou senha incorretos/i);
    });

    it('deve alertar sobre e-mail já em uso', () => {
      const msg = formatAuthError({ code: 'auth/email-already-in-use' });
      assert.match(msg, /já está cadastrado/i);
    });

    it('deve orientar sobre senha fraca', () => {
      const msg = formatAuthError({ code: 'auth/weak-password' });
      assert.match(msg, /muito fraca/i);
    });

    it('deve alertar sobre bloqueio temporário por muitas tentativas', () => {
      const msg = formatAuthError({ code: 'auth/too-many-requests' });
      assert.match(msg, /Muitas tentativas/i);
    });

    it('deve reportar cancelamento de popup do Google com elegância', () => {
      const msg = formatAuthError({ code: 'auth/popup-closed-by-user' });
      assert.match(msg, /fechada antes da conclusão/i);
    });

    it('deve repassar mensagem genérica ou fallback se código desconhecido', () => {
      const msg = formatAuthError({ message: 'Erro de infraestrutura simulado' });
      assert.equal(msg, 'Erro de infraestrutura simulado');
    });
  });

  describe('mapFirebaseUser — Normalização de Identidade Canônica', () => {
    it('deve extrair UID canônico, e-mail normalizado e flags de identidade', () => {
      const fakeFirebaseUser = {
        uid: 'FIREBASE_CANONICAL_UID_999',
        displayName: 'Keniel Calixto',
        email: 'KenielCalixto@Exemplo.COM',
        emailVerified: true,
        isAnonymous: false,
        photoURL: 'https://exemplo.com/foto.jpg',
      } as unknown as FirebaseUser;

      const canonical = mapFirebaseUser(fakeFirebaseUser, false);

      assert.equal(canonical.uid, 'FIREBASE_CANONICAL_UID_999');
      assert.equal(canonical.displayName, 'Keniel Calixto');
      assert.equal(canonical.email, 'kenielcalixto@exemplo.com');
      assert.equal(canonical.emailVerified, true);
      assert.equal(canonical.isAnonymous, false);
      assert.equal(canonical.photoURL, 'https://exemplo.com/foto.jpg');
      assert.equal(canonical.isDemo, false);
    });

    it('deve usar fallback de displayName baseado no prefixo do e-mail se ausente', () => {
      const userWithoutName = {
        uid: 'UID_123',
        displayName: null,
        email: 'mariana.costa@teste.com',
        emailVerified: false,
        isAnonymous: false,
        photoURL: null,
      } as unknown as FirebaseUser;

      const canonical = mapFirebaseUser(userWithoutName);
      assert.equal(canonical.displayName, 'mariana.costa');
    });
  });
});
