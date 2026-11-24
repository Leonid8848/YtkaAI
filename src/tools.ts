// Function tools exposed to the model + executor.
// days convention: 1=Пн ... 7=Вс. All times are Europe/Moscow (= user's local).

import * as dbm from './db';
import { run } from './db';

export const TOOLS = [
  {
    type: 'function',
    name: 'memory_save',
    description:
      'Курируемая долговременная память. target=profile — устойчивые факты о пользователе (кто он, предпочтения, окружение, постоянные договорённости). target=notes — рабочие заметки агента, применимые к любому будущему разговору. Формулируй записи как декларативные факты («Пользователь предпочитает краткие ответы»), не как императивы. Не сохраняй всё подряд: события дня, детали текущей задачи и процедуры сюда не относятся. При переполнении бюджета сначала консолидируй: удали (action=remove) устаревшие записи, потом добавь.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['profile', 'notes'] },
        action: { type: 'string', enum: ['add', 'remove', 'replace'] },
        text: { type: 'string', description: 'текст записи для add/replace; для replace — новая формулировка' },
        id: { type: 'integer', description: 'id записи для remove (из текущего списка в промпте)' },
        old_text: { type: 'string', description: 'точный текст записи для remove/replace, если id не известен' },
      },
      required: ['target', 'action'],
    },
  },
  {
    type: 'function',
    name: 'reminder_set',
    description:
      'Поставить напоминание — штатная возможность, ставь по любой просьбе «напомни», не отказывайся. time = "YYYY-MM-DD HH:MM" по МСК (местное время пользователя; сейчас передаётся в промпте). repeat=none — разовое; daily — каждый день в это время; weekly — по дням недели days (1=Пн...7=Вс). until = "YYYY-MM-DD" — дата последнего срабатывания повторяющегося (опционально). kind: text — в назначенное время пользователю уйдёт готовый текст как есть; task — в назначенное время бот выполнит задание (поле text = задание для себя) и пришлёт свежий сгенерированный ответ (пример: ежедневный утренний брифинг).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        time: { type: 'string' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
        days: { type: 'array', items: { type: 'integer' } },
        until: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'task'], description: 'по умолчанию text' },
      },
      required: ['text', 'time', 'repeat'],
    },
  },
  {
    type: 'function',
    name: 'reminder_cancel',
    description: 'Отменить напоминание по id (id видны в блоке НАПОМИНАНИЯ в промпте).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'reminder_update',
    description: 'Изменить напоминание: время, текст, вид повтора или дни. Передавай только изменяемые поля.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        text: { type: 'string' },
        time: { type: 'string', description: 'YYYY-MM-DD HH:MM МСК' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
        days: { type: 'array', items: { type: 'integer' } },
        kind: { type: 'string', enum: ['text', 'task'] },
      },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'plan_update',
    description:
      'План на день. action=add — добавить пункт (day = "YYYY-MM-DD" МСК, по умолчанию сегодня); done/reopen/remove — по id пункта. Для многодневных событий используй day конкретной даты.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'done', 'reopen', 'remove'] },
        text: { type: 'string', description: 'текст пункта для add' },
        day: { type: 'string', description: 'YYYY-MM-DD, по умолчанию сегодня' },
        id: { type: 'integer', description: 'id пункта для done/reopen/remove' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'recall',
    description:
      'Полнотекстовый поиск по ВСЕЙ истории переписки (полн и дословный). Используй, когда пользователь ссылается на прошлое, чего нет в контексте, или спрашивает «о чём мы говорили» — прежде чем говорить, что не помнишь.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'ключевые слова' },
        limit: { type: 'integer', description: 'сколько совпадений, по умолчанию 5' },
      },
      required: ['query'],
    },
  },
];

export interface ToolDeps {
  sql: import('./db').SqlLike;
  rearm: () => Promise<void>;
}

export function makeExecutor(deps: ToolDeps): (name: string, args: any) => string {
  const { sql, rearm } = deps;

  return (name, args): string => {
    try {
      const d = dbm;
      switch (name) {
        case 'memory_save': {
          const target = args.target === 'notes' ? 'notes' : 'profile';
          if (args.action === 'add') return d.storeAdd(sql, target, String(args.text ?? ''));
          const key: number | string = typeof args.id === 'number' ? args.id : String(args.old_text ?? args.text ?? '');
          if (args.action === 'remove') return d.storeRemove(sql, target, key);
          if (args.action === 'replace') {
            const removed = d.storeRemove(sql, target, key);
            if (removed.startsWith('error')) return removed;
            return d.storeAdd(sql, target, String(args.text ?? ''));
          }
          return 'error: unknown action';
        }
        case 'reminder_set': {
          const at = d.parseMskDT(String(args.time ?? ''));
          if (at == null) return 'error: time должен быть "YYYY-MM-DD HH:MM" (МСК)';
          const repeat = ['none', 'daily', 'weekly'].includes(args.repeat) ? args.repeat : 'none';
          const days = Array.isArray(args.days) ? args.days.map(Number).filter((n: number) => n >= 1 && n <= 7) : [];
          if (repeat === 'weekly' && !days.length) return 'error: для weekly нужны days (1=Пн...7=Вс)';
          const until = args.until ? d.parseMskDT(String(args.until)) : null;
          const kind = args.kind === 'task' ? 'task' : 'text';
          if (kind === 'task' && !String(args.text ?? '').trim()) return 'error: для kind=task поле text — это задание, оно обязательно';
          const rem = d.setReminder(sql, String(args.text ?? ''), at, repeat, days, until, kind);
          void rearm();
          return `ok: напоминание id ${rem.id} «${rem.text}» на ${d.fmtMsk(rem.at)}${repeat !== 'none' ? `, повтор: ${repeat}` : ''}${kind === 'task' ? ', вид: задача' : ''}`;
        }
        case 'reminder_cancel': {
          run(sql, 'UPDATE reminders SET active = 0 WHERE id = ?', Number(args.id));
          void rearm();
          return `ok: напоминание id ${args.id} отменено`;
        }
        case 'reminder_update': {
          const id = Number(args.id);
          const r = [...run(sql, 'SELECT * FROM reminders WHERE id = ?', id)];
          if (!r.length) return `error: напоминание id ${id} не найдено`;
          if (args.text != null) run(sql, 'UPDATE reminders SET text = ? WHERE id = ?', String(args.text), id);
          if (args.time != null) {
            const at = d.parseMskDT(String(args.time));
            if (at == null) return 'error: time должен быть "YYYY-MM-DD HH:MM" (МСК)';
            run(sql, 'UPDATE reminders SET at = ? WHERE id = ?', at, id);
          }
          if (args.repeat != null) run(sql, 'UPDATE reminders SET repeat = ? WHERE id = ?', String(args.repeat), id);
          if (args.kind === 'task' || args.kind === 'text') run(sql, 'UPDATE reminders SET kind = ? WHERE id = ?', args.kind, id);
          if (Array.isArray(args.days)) run(sql, 'UPDATE reminders SET days = ? WHERE id = ?', args.days.map(Number).filter((n: number) => n >= 1 && n <= 7).join(','), id);
          void rearm();
          const updated = d.reminderRow([...run(sql, 'SELECT * FROM reminders WHERE id = ?', id)][0]);
          return `ok: id ${id} теперь «${updated.text}» на ${d.fmtMsk(updated.at)}${updated.repeat !== 'none' ? `, повтор: ${updated.repeat}` : ''}`;
        }
        case 'plan_update': {
          const day = args.day ? String(args.day) : d.todayMsk();
          if (args.action === 'add') {
            if (!args.text) return 'error: для add нужен text';
            run(sql, 'INSERT INTO plan_items(day, text) VALUES (?,?)', day, String(args.text));
            return `ok: добавлено в план на ${day}`;
          }
          const id = Number(args.id);
          if (!id) return 'error: нужен id пункта';
          const status = args.action === 'done' ? 'done' : args.action === 'reopen' ? 'todo' : 'removed';
          run(sql, 'UPDATE plan_items SET status = ? WHERE id = ?', status, id);
          return `ok: пункт id ${id} → ${status}`;
        }
        case 'recall': {
          return d.recallSearch(sql, String(args.query ?? ''), Number(args.limit ?? 5));
        }
        default:
          return `error: unknown tool ${name}`;
      }
    } catch (error) {
      return `error: ${String(error).slice(0, 300)}`;
    }
  };
}

