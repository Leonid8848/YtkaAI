export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  LLM_MODEL: string;
  ALLOWED_USER_IDS: string;
  SIWC_ACCESS_TOKEN: string;
  SIWC_REFRESH_TOKEN: string;
  SIWC_CLIENT_ID: string;
  CHAT_SESSION: DurableObjectNamespace;
  AUTH: DurableObjectNamespace;
}

export interface CodexAuth {
  access: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  stopped_message_generation?: {
    chat: { id: number };
    message_thread_id?: number;
    draft_id: number;
  };
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
}
