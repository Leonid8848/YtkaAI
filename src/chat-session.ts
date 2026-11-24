import type { Env, TelegramMessage, TelegramUpdate } from './env';
import { api, sendPlainText } from './telegram';
import { completeOnce, streamWithTools } from './llm';
import { makeExecutor } from './tools';
import {
  run,
  appendSummary, dueReminders, earliestReminderAt, getSummaryBlock, insertMessage,
  initSchema, lastMessageAt, markOutOfContext, markResponded, getModel, setModel, getEffort, setEffort, oldestInContext, openSession,
  PROFILE_BUDGET, NOTES_BUDGET, reminderAfterFire, rows, sessionMessageCount,
  sessionTranscript, setReminder, SqlLike, storeSize, storeText, tailMessages, todayPlan,
  unresponded, upcomingReminders, currentSessionId, type Reminder,
} from './db';
import { fmtMsk, nowMsk } from './time';

const SESSION_GAP_MS = 5 * 3600_000;     // пауза > 5 ч => новая сессия
const TAIL_LIMIT = 75;                   // потолок хвоста текущей сессии
const KEEP_ON_COMPACT = 15;              // сколько свежих сообщений оставляем при уплотнении
const FLUSH_DELAY_MS = 3000;             // буфер склейки сообщений
const GENERATION_TIMEOUT_MS = 180_000;
const DRAFT_INTERVAL_MS = 1000;
const MAX_DRAFT_CHARS = 4096;

const SUMMARY_INSTRUCTIONS = 'Ты сжимаешь историю переписки ассистента с пользователем. Напиши краткую выжимку до 900 символов: темы, решения, открытые задачи, важные факты и обещания. Без воды, маркированным списком. Пиши на русском.';

export class ChatSessionV5 {
  private ctx: DurableObjectState;
  private env: Env;
  private sql: SqlLike;
  private abort: AbortController | null = null;
  private activeDraftId = 0;
  private stoppedDraftId = 0;
  private generating = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = (ctx.storage as any).sql;
    initSchema(this.sql);
  }

  // ---------- routing ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/stop') {
      const { draftId } = (await request.json()) as { draftId: number };
      if (draftId && draftId === this.activeDraftId) {
        this.stoppedDraftId = draftId;
        this.abort?.abort();
      }
      return new Response('ok');
    }

    if (url.pathname === '/sweep' || url.pathname === '/debug/sweep') {
      try {
        await this.deliverDue();
        await this.rearm();
        return new Response('ok');
      } catch (error) {
        return new Response(`sweep error: ${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`, { status: 500 });
      }
    }

    if (url.pathname === '/debug/remind') {
      const text = url.searchParams.get('text') ?? 'Тест напоминаний ✅';
      const mins = Number(url.searchParams.get('mins') ?? '0');
      const at = Date.now() + mins * 60_000;
      const rem = setReminder(this.sql, text, at, 'none', [], null, url.searchParams.get('kind') === 'task' ? 'task' : 'text');
      await this.rearm();
      return Response.json({ id: rem.id, at: fmtMsk(rem.at) });
    }

    if (url.pathname === '/debug/say') {
      const text = url.searchParams.get('text') ?? 'Тест';
      await this.enqueue(text);
      return Response.json({ queued: true });
    }

    if (url.pathname === '/debug/deactivate') {
      const id = Number(url.searchParams.get('id') ?? '0');
      run(this.sql, 'UPDATE reminders SET active = 0 WHERE id = ?', id);
      const after = rows(this.sql, 'SELECT * FROM reminders WHERE id = ?', id);
      return Response.json({ id, after: after.map((r) => ({ id: Number(r.id), active: Number(r.active) })) });
    }

    if (url.pathname === '/debug/state') {
      const c = (q: string) => Number(rows(this.sql, q)[0]?.n ?? 0);
      const rawReminders = rows(this.sql, 'SELECT * FROM reminders').map((r) => ({
        id: Number(r.id), text: String(r.text), at: Number(r.at), repeat: String(r.repeat), active: Number(r.active),
      }));
      return Response.json({
        now: nowMsk(),
        nowEpoch: Date.now(),
        model: getModel(this.sql),
        effort: getEffort(this.sql),
        sessions: c('SELECT COUNT(*) AS n FROM sessions'),
        messages: c('SELECT COUNT(*) AS n FROM messages'),
        unresponded: c('SELECT COUNT(*) AS n FROM messages WHERE responded = 0'),
        reminders: c('SELECT COUNT(*) AS n FROM reminders WHERE active = 1'),
        profile: c('SELECT COUNT(*) AS n FROM profile'),
        notes: c('SELECT COUNT(*) AS n FROM notes'),
        plan: c("SELECT COUNT(*) AS n FROM plan_items WHERE status = 'todo'"),
        alarmAt: await this.ctx.storage.getAlarm(),
        generating: this.generating,
        profileText: storeText(this.sql, 'profile'),
        notesText: storeText(this.sql, 'notes'),
        lastMessages: rows(this.sql, 'SELECT role, text FROM messages ORDER BY id DESC LIMIT 4').reverse(),
        chatId: await this.ctx.storage.get('chat_id'),
        rawReminders,
      });
    }

    // ---- telegram update ----
    const update = (await request.json()) as TelegramUpdate;
    const seen = (await this.ctx.storage.get<number[]>('seen')) ?? [];
    if (seen.includes(update.update_id)) return new Response('duplicate');
    await this.ctx.storage.put('seen', [...seen.slice(-20), update.update_id]);

    const message = update.message;
    if (message?.text && message.chat.type === 'private' && !message.from?.is_bot) {
      const allowed = this.env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean);
      if (allowed.length === 0 || allowed.includes(String(message.from?.id))) {
        await this.ctx.storage.put('chat_id', message.chat.id);
        if (message.text.startsWith('/model')) {
          await this.handleModelCommand(message.text, message.chat.id);
          return new Response('ok');
        }
        if (message.text.startsWith('/effort')) {
          await this.handleEffortCommand(message.text, message.chat.id);
          return new Response('ok');
        }
        await this.enqueue(message.text);
      }
    }
    return new Response('ok');
  }

  private static readonly MODELS = [
    'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol',
    'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra',
  ];

  private static readonly EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  // модели, у которых верх шкалы — max (ultra не поддерживается)
  private static readonly EFFORT_CAP_MAX = ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-terra'];

  private effectiveEffort(): string | null {
    const e = getEffort(this.sql);
    if (!e) return null;
    const m = getModel(this.sql) || this.env.LLM_MODEL;
    return ChatSessionV5.EFFORT_CAP_MAX.includes(m) && e === 'ultra' ? 'max' : e;
  }

  private async handleEffortCommand(text: string, chatId: number): Promise<void> {
    const arg = text.replace(/^\s*\/effort\s*/i, '').trim().toLowerCase();
    const current = getEffort(this.sql);
    const model = getModel(this.sql) || this.env.LLM_MODEL;
    const cap = ChatSessionV5.EFFORT_CAP_MAX.includes(model) ? ' (у этой модели верх — max)' : '';
    if (!arg) {
      const list = ChatSessionV5.EFFORTS.map((e) => `${e === current ? '●' : '○'} ${e}`).join('\n');
      await sendPlainText(this.env, chatId, undefined, `Эффорт (модель ${model}):\n${list}\n\nСейчас: ${current ?? 'дефолт маршрута'}. Переключить: /effort <имя>, сбросить: /effort reset.${cap}`);
      return;
    }
    if (arg === 'reset') {
      setEffort(this.sql, null);
      await sendPlainText(this.env, chatId, undefined, `Эффорт сброшен на дефолт маршрута.`);
      return;
    }
    if (!ChatSessionV5.EFFORTS.includes(arg)) {
      await sendPlainText(this.env, chatId, undefined, `Не знаю эффорт «${arg}». Доступны:\n${ChatSessionV5.EFFORTS.join(', ')}\n(или /effort reset)`);
      return;
    }
    if (arg === 'ultra' && ChatSessionV5.EFFORT_CAP_MAX.includes(model)) {
      await sendPlainText(this.env, chatId, undefined, `У модели ${model} верх — max, ultra недоступен. Ставлю max.`);
      setEffort(this.sql, 'max');
      return;
    }
    setEffort(this.sql, arg);
    await sendPlainText(this.env, chatId, undefined, `Эффорт: ${arg}. Чем выше — тем дольше думает.`);
  }

  private async handleModelCommand(text: string, chatId: number): Promise<void> {
    const arg = text.replace(/^\s*\/model\s*/i, '').trim().toLowerCase();
    const current = getModel(this.sql);
    const active = current || this.env.LLM_MODEL;
    if (!arg) {
      const list = ChatSessionV5.MODELS.map((m) => `${m === active ? '●' : '○'} ${m}${m === this.env.LLM_MODEL ? ' (дефолт)' : ''}`).join('\n');
      await sendPlainText(this.env, chatId, undefined, `Модели (сейчас: ${active}):\n${list}\n\nПереключить: /model <имя>, сбросить: /model reset`);
      return;
    }
    if (arg === 'reset') {
      setModel(this.sql, null);
      await sendPlainText(this.env, chatId, undefined, `Сброшено на дефолт: ${this.env.LLM_MODEL}`);
      return;
    }
    if (!ChatSessionV5.MODELS.includes(arg)) {
      await sendPlainText(this.env, chatId, undefined, `Не знаю модель «${arg}». Доступны:\n${ChatSessionV5.MODELS.join(', ')}\n(или /model reset)`);
      return;
    }
    setModel(this.sql, arg);
    await sendPlainText(this.env, chatId, undefined, `Переключено на ${arg}. Действует на чат, напоминания и сводки; переживает перезапуски.`);
  }

  // ---------- alarm ----------

  async alarm(): Promise<void> {
    await this.deliverDue();
    if (!this.generating && unresponded(this.sql).length) {
      await this.runGeneration();
    }
    await this.rearm();
  }

  private async rearm(): Promise<void> {
    let next: number | null = earliestReminderAt(this.sql);
    const now = Date.now();
    // overdue: retry on a slow cadence so a failing delivery can never hot-loop
    if (next != null && next <= now) next = now + 30_000;
    if (!this.generating && unresponded(this.sql).length) {
      const t = now + FLUSH_DELAY_MS;
      next = next == null ? t : Math.min(next, t);
    }
    const cur = await this.ctx.storage.getAlarm();
    if (next != null && (cur == null || Math.abs(cur - next) > 1000)) {
      await this.ctx.storage.setAlarm(next);
    } else if (next == null && cur != null) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async chatId(): Promise<number | null> {
    const stored = await this.ctx.storage.get<number>('chat_id');
    if (stored) return stored;
    const first = Number(this.env.ALLOWED_USER_IDS.split(',')[0]);
    if (Number.isFinite(first) && first > 0) {
      await this.ctx.storage.put('chat_id', first);
      return first;
    }
    return null;
  }

  private async deliverDue(): Promise<void> {
    const chatId = await this.chatId();
    if (!chatId) return;
    const due = dueReminders(this.sql, Date.now());
    for (const rem of due) {
      const overdue = Date.now() - rem.at > 60_000;
      let sent = false;
      if (rem.kind === 'task') {
        // "живое" напоминание: бот в момент срабатывания выполняет задание и шлёт свежий ответ
        sent = await this.runTaskReminder(chatId, rem, overdue);
      } else {
        sent = await sendPlainText(
          this.env,
          chatId,
          undefined,
          overdue ? `${rem.text}\n(напоминание с опозданием, было на ${fmtMsk(rem.at)})` : rem.text,
        );
      }
      // keep the reminder for a retry when delivery failed (e.g. Telegram flood-wait)
      if (sent) reminderAfterFire(this.sql, rem, Date.now());
    }
  }

  private async runTaskReminder(chatId: number, rem: Reminder, overdue: boolean): Promise<boolean> {
    const draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
    const prevDraftId = this.activeDraftId;
    this.activeDraftId = draftId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let text = '';
    let lastDraftAt = 0;
    const pushDraft = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastDraftAt < DRAFT_INTERVAL_MS) return;
      if (this.stoppedDraftId === draftId) return;
      lastDraftAt = now;
      await api(this.env, 'sendMessageDraft', {
        chat_id: chatId, draft_id: draftId, text: text.slice(0, MAX_DRAFT_CHARS), can_stop: true,
      });
    };
    try {
      await pushDraft(true);
      for await (const delta of streamWithTools(this.env, this.systemPrompt(), [{ role: 'user', content: rem.text }], null, controller.signal, getModel(this.sql), this.effectiveEffort())) {
        if (this.stoppedDraftId === draftId) break;
        text += delta;
        await pushDraft();
      }
    } catch (error) {
      console.error('task reminder failed', String(error));
      if (!text) text = 'Не получилось выполнить задание напоминания. Попробую в следующий раз.';
    } finally {
      clearTimeout(timer);
      this.activeDraftId = prevDraftId;
    }
    const finalText = (text.trim() || (this.stoppedDraftId === draftId ? 'Остановлено.' : 'Задание напоминания не дало результата.'))
      + (overdue ? '\n(выполнено с опозданием, время было ' + fmtMsk(rem.at) + ')' : '');
    return await sendPlainText(this.env, chatId, undefined, finalText);
  }

  // ---------- message intake & sessions ----------

  private async enqueue(text: string): Promise<void> {
    if (text.startsWith('/model')) {
      const chatId = await this.chatId();
      if (chatId) await this.handleModelCommand(text, chatId);
      return;
    }
    if (text.startsWith('/effort')) {
      const chatId = await this.chatId();
      if (chatId) await this.handleEffortCommand(text, chatId);
      return;
    }
    await this.closeSessionIfNeeded();
    const sid = currentSessionId(this.sql) ?? openSession(this.sql);
    insertMessage(this.sql, sid, 'user', text, 0);
    await this.rearm();
  }

  private async closeSessionIfNeeded(): Promise<void> {
    const last = lastMessageAt(this.sql);
    const sid = currentSessionId(this.sql);
    if (sid == null) return;
    if (last != null && Date.now() - last < SESSION_GAP_MS) return;

    // close: summarize this session + prior summary block
    const prior = getSummaryBlock(this.sql);
    const transcript = sessionTranscript(this.sql, sid);
    if (transcript) {
      let summary: string | null = null;
      try {
        summary = await completeOnce(this.env, SUMMARY_INSTRUCTIONS,
          `Сводка прежних разговоров (для контекста):\n${prior}\n\nЗавершающийся диалог:\n${transcript.slice(-12000)}`,
          new AbortController().signal, getModel(this.sql), this.effectiveEffort());
      } catch { /* network hiccup — fallback below */ }
      const chunk = summary?.trim() || transcript.slice(-800);
      await appendSummary(this.sql, chunk);
      run(this.sql, 'UPDATE sessions SET closed_at = ?, summary = ? WHERE id = ?', Date.now(), chunk, sid);
    } else {
      run(this.sql, 'UPDATE sessions SET closed_at = ? WHERE id = ?', Date.now(), sid);
    }
  }

  // ---------- generation ----------

  private async runGeneration(): Promise<void> {
    const chatId = await this.chatId();
    if (!chatId) { markResponded(this.sql, unresponded(this.sql).map((m) => m.id)); return; }

    this.generating = true;
    this.stoppedDraftId = 0;
    const draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
    this.activeDraftId = draftId;

    const controller = new AbortController();
    this.abort = controller;
    const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

    let lastDraftAt = 0;
    let draftText = '';
    const pushDraft = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastDraftAt < DRAFT_INTERVAL_MS) return;
      if (this.stoppedDraftId === draftId) return;
      lastDraftAt = now;
      await api(this.env, 'sendMessageDraft', {
        chat_id: chatId, draft_id: draftId, text: draftText.slice(0, MAX_DRAFT_CHARS), can_stop: true,
      });
    };

    let text = '';
    try {
      const batch = unresponded(this.sql);
      if (!batch.length) return;
      markResponded(this.sql, batch.map((m) => m.id));

      const sid = currentSessionId(this.sql) ?? openSession(this.sql);
      const history = tailMessages(this.sql, sid, TAIL_LIMIT).map((m) => ({ role: m.role, content: m.text }));
      const userText = batch.map((m) => m.text).join('\n');
      const input = [...history, { role: 'user', content: userText }];

      draftText = '';
      await pushDraft(true);

      const execTool = makeExecutor({ sql: this.sql, rearm: () => this.rearm(), env: this.env });
      for await (const delta of streamWithTools(this.env, this.systemPrompt(), input, execTool, controller.signal, getModel(this.sql), this.effectiveEffort())) {
        if (this.stoppedDraftId === draftId) break;
        text += delta;
        draftText = text;
        await pushDraft();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('generation failed', String(error));
        if (!text) text = 'Не получилось получить ответ. Попробуй ещё раз.';
      }
    } finally {
      clearTimeout(timer);
      this.abort = null;
    }

    try {
      const finalText = text.trim() || (this.stoppedDraftId === draftId ? 'Остановлено.' : 'Пустой ответ.');
      const sid = currentSessionId(this.sql);
      if (sid != null) insertMessage(this.sql, sid, 'assistant', finalText, 1);
      await sendPlainText(this.env, chatId, undefined, finalText);
      await this.compactIfNeeded(sid);
    } catch (error) {
      console.error('finalize failed', String(error));
    } finally {
      this.generating = false;
      this.activeDraftId = 0;
    }
  }

  private async compactIfNeeded(sid: number | null): Promise<void> {
    if (sid == null) return;
    const count = sessionMessageCount(this.sql, sid);
    if (count <= TAIL_LIMIT) return;
    const take = count - KEEP_ON_COMPACT;
    const old = oldestInContext(this.sql, sid, take);
    if (!old.length) return;
    const prior = getSummaryBlock(this.sql);
    const transcript = old.map((m) => `${m.role === 'user' ? 'П' : 'Б'}: ${m.text}`).join('\n');
    let summary: string | null = null;
    try {
      summary = await completeOnce(this.env, SUMMARY_INSTRUCTIONS,
        `Сводка прежних разговоров:\n${prior}\n\nУплотняемый кусок текущего диалога:\n${transcript.slice(-12000)}`,
        new AbortController().signal, getModel(this.sql), this.effectiveEffort());
    } catch { /* keep raw fallback */ }
    const chunk = summary?.trim() || transcript.slice(-800);
    await appendSummary(this.sql, chunk);
    markOutOfContext(this.sql, old.map((m) => m.id));
  }

  // ---------- prompt ----------

  private systemPrompt(): string {
    const profile = storeText(this.sql, 'profile');
    const notes = storeText(this.sql, 'notes');
    const summary = getSummaryBlock(this.sql);
    const plan = todayPlan(this.sql);
    const reminders = upcomingReminders(this.sql, 6)
      .map((r) => {
        const rep = r.repeat === 'weekly' ? `, повтор по дням [${r.days.join(',')}] (1=Пн..7=Вс)` : r.repeat === 'daily' ? ', ежедневно' : '';
        const kind = r.kind === 'task' ? ' [задача: выполню в момент срабатывания]' : '';
        return `${r.id}. ${fmtMsk(r.at)}${rep}${kind} — ${r.text}`;
      })
      .join('\n');

    return [
      'Ты — YtkaAI, личный ассистент одного пользователя в Telegram. Отвечай кратко, по делу, на языке пользователя.',
      `Сейчас: ${nowMsk()}. Все времена пользователь указывает в МСК (это его местное время).`,
      '',
      `ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (факты; бюджет ${PROFILE_BUDGET} симв.):\n${profile || '(пусто)'}`,
      '',
      `ЗАМЕТКИ (бюджет ${NOTES_BUDGET} симв.):\n${notes || '(пусто)'}`,
      '',
      `СВОДКА ПРЕЖНИХ РАЗГОВОРОВ (старые диалоги, сжатые автоматически):\n${summary || '(пусто)'}`,
      '',
      `ПЛАН НА СЕГОДНЯ:\n${plan}`,
      '',
      `АКТИВНЫЕ НАПОМИНАНИЯ (ближайшие):\n${reminders || '(нет)'}`,
      '',
      'Правила работы с памятью: устойчивые факты о пользователе и постоянные договорённости сохраняй через memory_save (формулировка — декларативный факт, не императив; не сохраняй события дня и детали текущей задачи). При переполнении бюджета сначала удали/консолидируй устаревшее.',
      'У тебя есть два поиска в интернете: web_search (DuckDuckGo, бесплатный) и web_search_exa (Exa, платный по кредитам — бери его, когда DuckDuckGo не помог или пользователь попросил). web_read читает страницу по ссылке. Для новостей, цен, курсов, релизов и вообще всего, что могло измениться после твоих знаний — сначала поиск, при нехватке деталей web_read 1–2 страницы. В ответе всегда приводи ссылки на источники. Ошибку поиска сообщай коротко, не притворяйся, что нашёл.',
      'Просьбы «напомни», повторяющиеся события (уроки, встречи по дням недели) — reminder_set (для повтора по конкретным дням: repeat=weekly + days). Отмена/перенос — reminder_cancel/reminder_update по id из списка выше. Никогда не отказывайся ставить напоминания — это твоя штатная возможность: разовые, повторяющиеся и задачи (kind=task — в момент срабатывания ты выполняешь задание и присылаешь свежий ответ, например утренний брифинг).',
      'План дня веди через plan_update: добавляй пункты, отмечай сделанное.',
      'Если пользователь ссылается на что-то из прошлого, чего нет в контексте, — сначала recall по ключевым словам, потом отвечай; не выдумывай.',
      'Не сообщай пользователю служебные детали (id, бюджеты), если он прямо не спросил. Отвечай обычным текстом, без markdown-заголовков.',
    ].join('\n');
  }
}
