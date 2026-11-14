import { universalStorage } from '../utils/universalStorage';

export interface EmailJSConfig {
  serviceId: string;
  templateId: string;
  publicKey: string;
}

export interface TransactionalEmailPayload {
  toEmail: string;
  toName: string;
  fromName: string;
  subject: string;
  spaceOrTransactionTitle: string;
  amountFormatted?: string;
  message: string;
  type: 'space_invite' | 'split_notification' | 'dispute_update';
  sentAt: string;
}

export type EmailDeliveryStatus = 'sent' | 'not_configured_local_emulator' | 'failed';

export interface EmailDispatchLog {
  toEmail: string;
  toName: string;
  fromName: string;
  subject: string;
  spaceOrTransactionTitle: string;
  amountFormatted?: string;
  type: 'space_invite' | 'split_notification' | 'dispute_update';
  status: EmailDeliveryStatus;
  sentAt: string;
}

const STORAGE_KEY_CONFIG = 'mpf_emailjs_config_v1';
const STORAGE_KEY_LOG = 'mpf_emailjs_sent_logs_v1';

export function getEmailJSConfig(): EmailJSConfig {
  try {
    const raw = universalStorage.getItem(STORAGE_KEY_CONFIG);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {
    serviceId: '',
    templateId: '',
    publicKey: '',
  };
}

export function saveEmailJSConfig(config: EmailJSConfig): void {
  universalStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
}

export function getSentEmailLogs(): EmailDispatchLog[] {
  try {
    const raw = universalStorage.getItem(STORAGE_KEY_LOG);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function appendEmailAuditLog(entry: EmailDispatchLog): void {
  try {
    const logs = getSentEmailLogs();
    universalStorage.setItem(STORAGE_KEY_LOG, JSON.stringify([entry, ...logs].slice(0, 50)));
  } catch {
    // ignore storage errors
  }
}

/**
 * Dispara e-mail transacional via EmailJS quando configurado.
 * Nunca mascara ausência de provedor como envio bem-sucedido e nunca armazena tokens sensíveis no log local.
 */
export async function sendTransactionalEmail(
  payload: Omit<TransactionalEmailPayload, 'sentAt'>
): Promise<{ ok: boolean; mode: EmailDeliveryStatus; message: string }> {
  const sentAt = new Date().toISOString();
  const baseLog: Omit<EmailDispatchLog, 'status'> = {
    toEmail: payload.toEmail,
    toName: payload.toName,
    fromName: payload.fromName,
    subject: payload.subject,
    spaceOrTransactionTitle: payload.spaceOrTransactionTitle,
    amountFormatted: payload.amountFormatted,
    type: payload.type,
    sentAt,
  };

  const cfg = getEmailJSConfig();
  if (cfg.serviceId && cfg.templateId && cfg.publicKey) {
    try {
      const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: cfg.serviceId,
          template_id: cfg.templateId,
          user_id: cfg.publicKey,
          template_params: {
            to_email: payload.toEmail,
            to_name: payload.toName,
            from_name: payload.fromName,
            subject: payload.subject,
            title: payload.spaceOrTransactionTitle,
            amount: payload.amountFormatted || '—',
            message: payload.message,
          },
        }),
      });

      if (response.ok) {
        appendEmailAuditLog({ ...baseLog, status: 'sent' });
        return {
          ok: true,
          mode: 'sent',
          message: `E-mail enviado via EmailJS para ${payload.toEmail}.`,
        };
      }

      appendEmailAuditLog({ ...baseLog, status: 'failed' });
      return {
        ok: false,
        mode: 'failed',
        message: `Falha HTTP ${response.status} ao enviar e-mail para ${payload.toEmail}.`,
      };
    } catch {
      appendEmailAuditLog({ ...baseLog, status: 'failed' });
      return {
        ok: false,
        mode: 'failed',
        message: `Erro de rede ao tentar enviar e-mail para ${payload.toEmail}.`,
      };
    }
  }

  appendEmailAuditLog({ ...baseLog, status: 'not_configured_local_emulator' });
  return {
    ok: false,
    mode: 'not_configured_local_emulator',
    message:
      'Envio de e-mail externo não configurado no ambiente local / Firebase Emulator. Utilize o token ou a Caixa de Entrada do aplicativo.',
  };
}
