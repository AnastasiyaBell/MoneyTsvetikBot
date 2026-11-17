/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const USERS = {
  419181864: "Tsvetik", // 👈 твой chatId
  344832427: "Koti"     // 👈 мужа
};


export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("request:error", {
        message: error?.message,
        stack: error?.stack,
        hasTelegramToken: Boolean(env.TELEGRAM_TOKEN),
        hasSheetUrl: Boolean(env.SHEET_URL),
        hasKv: Boolean(env.KV)
      });

      return new Response("ok");
    }
  }
};

async function handleRequest(request, env) {
  if (request.method !== "POST") {
    const url = new URL(request.url);

    if (url.searchParams.get("health") === "1") {
      return Response.json({
        ok: true,
        hasTelegramToken: Boolean(env.TELEGRAM_TOKEN),
        hasSheetUrl: Boolean(env.SHEET_URL),
        hasKv: Boolean(env.KV)
      });
    }

    return new Response("OK");
  }

  const data = await request.json();

  console.log("telegram:update", getUpdateLogInfo(data));

  // ===== CALLBACK =====
  if (data.callback_query) {
    await handleCallback(data.callback_query, env);
    return new Response("ok");
  }

  if (!data.message) return new Response("ok");

  const chatId = data.message?.chat?.id || data.callback_query?.message?.chat?.id;
  const text = data.message.text;
  const userName = USERS[chatId] || "Unknown";

  if (!USERS[chatId]) {
    await sendMessage(env, chatId, "⛔ У тебя нет доступа");
    return new Response("ok");
  }

    // ===== ГЛАВНОЕ МЕНЮ =====
    if (text === "/start") {
      await sendMainMenu(env, chatId);
      return new Response("ok");
    }

    if (text === "🧾 Транзакция") {
      await sendTypeMenu(env, chatId);
      return new Response("ok");
    }

    if (text === "📊 Аналитика") {
      await sendAnalyticsMenu(env, chatId);
      return new Response("ok");
    }

    if (text === "📄 Открыть таблицу") {
      await sendMainMenu(env, chatId, "👉 https://docs.google.com/spreadsheets/d/1-X26fVHHG198zWhD-r80uTqpROOZKo86IEDQVPCKFiA/edit");
      return new Response("ok");
    }

    if (text === "🗑 Удалить категорию") {
      const categories = await getCategories(env);

      const custom = categories.filter(c => !DEFAULT_CATEGORIES.includes(c));

      if (custom.length === 0) {
        await sendMessage(env, chatId, "Нет пользовательских категорий");
        return new Response("ok");
      }

      const keyboard = buildTwoColumnKeyboard(
        custom.map(c => ({ text: c, callback_data: `confirmdelcat_${c}` }))
      );

      await sendInlineKeyboard(env, chatId, "Выбери категорию для удаления:", keyboard);

      return new Response("ok");
    }

    if (text === "🔔 Уведомления") {
      const enabled = await isNotifyEnabled(env, chatId);

      await sendInlineKeyboard(env, chatId,
        `Уведомления сейчас: ${enabled ? "ВКЛ" : "ВЫКЛ"}`,
        [[{
          text: enabled ? "Выключить" : "Включить",
          callback_data: "toggle_notify"
        }]]
      );

      return new Response("ok");
    }

    if (text === "❌ Отменить мою последнюю транзакцию") {
      const userName = USERS[chatId];
      const res = await fetch(env.SHEET_URL + "?getLast=" + encodeURIComponent(userName));
      const data = await res.json();

      if (data.status === "not_found") {
        await sendMessage(env, chatId, "Нет транзакций");
        return new Response("ok");
      }

      if (data.status !== "found" || !data.transactionId) {
        await sendMessage(env, chatId, "Не удалось загрузить операцию. Проверь обновление Apps Script.");
        return new Response("ok");
      }
      await sendInlineKeyboard(env, chatId,
        "Удалить эту транзакцию?\n\n" + formatTransaction(data),
        [
          [{ text: "✅ Удалить", callback_data: `undo_${data.transactionId}` }],
          [{ text: "❌ Отмена", callback_data: "cancel" }]
        ]
      );

      return new Response("ok");
    }


    if (typeof text !== "string") return new Response("ok");
    const type = await env.KV.get(`type_${chatId}`);
    if (!TYPE_LABELS[type]) {
      await sendTypeMenu(env, chatId);
      return new Response("ok");
    }
    if (await env.KV.get(`await_${chatId}`)) {
      await addCategory(env, text.trim());
      await env.KV.put(`cat_${chatId}`, text.trim());
      await env.KV.delete(`await_${chatId}`);
      await sendAccountKeyboard(env, chatId);
      return new Response("ok");
    }
    if (await env.KV.get(`await_account_${chatId}`)) {
      await addAccount(env, text.trim());
      await env.KV.delete(`await_account_${chatId}`);
      await selectAccount(env, chatId, text.trim());
      return new Response("ok");
    }
    const category = type === "transfer" ? "" : await env.KV.get(`cat_${chatId}`);
    if (type !== "transfer" && !category) {
      await sendCategoryKeyboard(env, chatId);
      return new Response("ok");
    }
    const account = await env.KV.get(`acc_${chatId}`);
    const toAccount = await env.KV.get(`to_${chatId}`);
    if (!account || (type === "transfer" && !toAccount)) {
      await sendAccountKeyboard(env, chatId);
      return new Response("ok");
    }
    const parsed = parseMessage(text, type);
    if (!parsed) {
      await sendMessage(env, chatId, type === "transfer"
        ? "Введи: 100 / 108дол или 100дол / 9500руб. Одна сумма: 100. Без приписки — евро."
        : "Введи положительную сумму и описание: 25 продукты, 500руб продукты, 20лир автобус, 25дол кафе. Без приписки — евро.");
      return new Response("ok");
    }
    const transaction = {
      ...parsed, category, account, user: userName,
      transactionId: `tg_${data.update_id}`,
      fromAccount: type === "expense" || type === "transfer" ? account : "",
      toAccount: type === "transfer" ? toAccount : type === "income" || type === "refund" ? account : ""
    };
    try {
      await saveToSheet(env, transaction);
    } catch (error) {
      console.error("save:error", error.message);
      await sendMessage(env, chatId, "Не удалось подтвердить сохранение. Проверь таблицу перед повторным вводом.");
      return new Response("ok");
    }
    await sendMessage(env, chatId, "Сохранено ✅\n" + formatTransaction(transaction));
    for (const id of Object.keys(USERS)) {
      if (Number(id) !== chatId && await isNotifyEnabled(env, id)) {
        await sendMessage(env, id, userName + ":\n" + formatTransaction(transaction));
      }
    }

  return new Response("ok");
}

function getUpdateLogInfo(data) {
  if (data.callback_query) {
    return {
      kind: "callback",
      data: data.callback_query.data,
      knownUser: Boolean(USERS[data.callback_query.message?.chat?.id])
    };
  }

  if (data.message) {
    const text = data.message.text;
    const menuCommands = new Set([
      "/start",
      "🧾 Транзакция",
      "📊 Аналитика",
      "📄 Открыть таблицу",
      "🗑 Удалить категорию",
      "🔔 Уведомления",
      "❌ Отменить мою последнюю транзакцию"
    ]);

    return {
      kind: "message",
      text: menuCommands.has(text) ? text : "user_input",
      knownUser: Boolean(USERS[data.message.chat?.id])
    };
  }

  return { kind: "other" };
}

async function sendMainMenu(env, chatId, text = "Выбери действие:") {
  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [
        ["🧾 Транзакция", "📊 Аналитика"],
        ["📄 Открыть таблицу", "🗑 Удалить категорию"],
        ["🔔 Уведомления", "❌ Отменить мою последнюю транзакцию"]
      ],
      resize_keyboard: true
    }
  });
}

// ===== КАТЕГОРИИ =====
const DEFAULT_CATEGORIES = [
  "Еда","Транспорт","Жилье","Строительно-бытовое","Спорт",
  "Дети","Здоровье","Подарки","Техника","Развлечения",
  "Путешествия","Другое"
];

// получить список категорий
async function getCategories(env) {
  const stored = await env.KV.get("categories");

  if (!stored) {
    await env.KV.put("categories", JSON.stringify(DEFAULT_CATEGORIES));
    return DEFAULT_CATEGORIES;
  }

  return JSON.parse(stored);
}

// добавить новую категорию
async function addCategory(env, category) {
  const categories = await getCategories(env);

  if (!categories.includes(category)) {
    categories.push(category);
    await env.KV.put("categories", JSON.stringify(categories));
  }
}

// добавление и получение счетов
const DEFAULT_ACCOUNTS = [
  "sparkasse",
  "sparkasse-mc",
  "cash",
  "OTPrus"
];

async function getAccounts(env) {
  const stored = await env.KV.get("accounts");

  if (!stored) {
    await env.KV.put("accounts", JSON.stringify(DEFAULT_ACCOUNTS));
    return DEFAULT_ACCOUNTS;
  }

  return JSON.parse(stored);
}

async function addAccount(env, account) {
  const accounts = await getAccounts(env);

  if (!accounts.includes(account)) {
    accounts.push(account);
    await env.KV.put("accounts", JSON.stringify(accounts));
  }
}

function buildTwoColumnKeyboard(items) {
  const keyboard = [];

  for (let i = 0; i < items.length; i += 2) {
    const row = [];

    row.push(items[i]);

    if (items[i + 1]) {
      row.push(items[i + 1]);
    }

    keyboard.push(row);
  }

  return keyboard;
}

// ===== CALLBACK =====
async function handleCallback(callback, env) {
  const callbackId = callback.id;

  // 👇 ЭТО ОБЯЗАТЕЛЬНО
  await callTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackId
  });

  const data = callback.data;
  const chatId = callback.message.chat.id;

  if (!USERS[chatId]) return;
  if (data.startsWith("type_")) {
    const type = data.slice(5);
    if (!TYPE_LABELS[type]) return;
    await env.KV.put(`type_${chatId}`, type);
    for (const key of ["cat", "acc", "to", "await", "await_account"]) await env.KV.delete(`${key}_${chatId}`);
    if (type === "transfer") await sendAccountKeyboard(env, chatId);
    else await sendCategoryKeyboard(env, chatId);
    return;
  }
  if (data === "new_category") {
    const type = await env.KV.get(`type_${chatId}`);
    if (type !== "expense" && type !== "refund") return;
    await env.KV.put(`await_${chatId}`, "1", { expirationTtl: 300 });
    await sendMessage(env, chatId, "Введи новую категорию расходов:");
    return;
  }
  if (data === "new_account") {
    await env.KV.put(`await_account_${chatId}`, "1", { expirationTtl: 300 });
    await sendMessage(env, chatId, "Введи название счета:");
    return;
  }
  if (data.startsWith("cat_")) {
    const type = await env.KV.get(`type_${chatId}`);
    const categories = type === "income" ? INCOME_CATEGORIES : await getCategories(env);
    const category = data.slice(4);
    if (!TYPE_LABELS[type] || type === "transfer" || !categories.includes(category)) return;
    await env.KV.put(`cat_${chatId}`, category);
    await env.KV.delete(`acc_${chatId}`);
    await sendAccountKeyboard(env, chatId);
    return;
  }
  if (data.startsWith("acc_")) {
    const account = data.slice(4);
    if ((await getAccounts(env)).includes(account)) await selectAccount(env, chatId, account);
    return;
  }

  if (data === "go_analytics") {
    await sendAnalyticsMenu(env, chatId);
    return;
  }

  if (data === "an_expense") {
    await sendPeriodMenu(env, chatId, "expense");
    return;
    }

  if (data === "an_income") {
    await sendPeriodMenu(env, chatId, "income");
    return;
  }

  if (data.startsWith("period_")) {
    const [, type, days] = data.split("_");

    const result = await getAnalytics(env, parseInt(days), type);

    await sendChart(env, chatId, result.labels, result.values, type === "expense" ? "Расходы за вычетом возвратов" : "Доходы");

    return;
  }

  if (data.startsWith("confirmdelcat_")) {
    const category = data.replace("confirmdelcat_", "");

    await sendInlineKeyboard(env, chatId,
      `Удалить "${category}"?`,
      [
        [{ text: "✅ Да", callback_data: `delcat_${category}` }],
        [{ text: "❌ Нет", callback_data: `cancelcat_${category}` }]
      ]
    );
  }

  if (data.startsWith("delcat_")) {
    const category = data.replace("delcat_", "");

    let categories = await getCategories(env);

    categories = categories.filter(c => c !== category);

    await env.KV.put("categories", JSON.stringify(categories));

    await sendMessage(env, chatId, `Удалено: ${category}`);

    return;
  }

  if (data.startsWith("cancelcat_")) {
    const category = data.replace("cancelcat_", "");

    await sendMessage(env, chatId, `Отмена удаления категории ${category}`);

    return;
  }

  if (data === "toggle_notify") {
    const newState = await toggleNotify(env, chatId);

    await sendMessage(env, chatId,
      `Теперь уведомления: ${newState ? "ВКЛ" : "ВЫКЛ"}`
    );

    return;
  }

  if (data.startsWith("undo_")) {
    const userName = USERS[chatId];
    const transactionId = data.slice(5);
    if (transactionId === "last_confirm") { await sendMessage(env, chatId, "Выбери удаление заново."); return; }
    const res = await fetch(env.SHEET_URL + "?deleteLast=" + encodeURIComponent(userName) + "&transactionId=" + encodeURIComponent(transactionId));
    const result = await res.json();

    if (result.status === "deleted") {
      await sendMessage(env, chatId,
        "Удалено ✅\n\n" + formatTransaction(result)
      );
    } else if (result.status === "too_late") {
      await sendMessage(env, chatId, "Можно удалить только в течение 24 часов");
    } else {
      await sendMessage(env, chatId, "Не найдено записей");
    }

    return;
  }

  if (data === "cancel") {
    await sendMessage(env, chatId, "Ок, не удаляем 👍");
    return;
  }
}

// ===== КНОПКИ =====
const TYPE_LABELS = { expense: "💸 Расход", income: "💰 Доход", transfer: "🔄 Между своими", refund: "↩️ Мне вернули" };
const INCOME_CATEGORIES = ["Зарплата", "Подработка", "Сдача квартиры", "Подарки", "Социальное", "Возврат налогов", "Другое"];

async function sendTypeMenu(env, chatId) {
  for (const key of ["type", "cat", "acc", "to", "await", "await_account"]) await env.KV.delete(`${key}_${chatId}`);
  await sendInlineKeyboard(env, chatId, "Выбери тип операции:", buildTwoColumnKeyboard(
    Object.entries(TYPE_LABELS).map(([type, text]) => ({ text, callback_data: "type_" + type }))
  ));
}

async function sendCategoryKeyboard(env, chatId) {
  const type = await env.KV.get(`type_${chatId}`);
  if (!TYPE_LABELS[type]) return sendTypeMenu(env, chatId);
  const categories = type === "income" ? INCOME_CATEGORIES : await getCategories(env);
  const keyboard = buildTwoColumnKeyboard(categories.map(c => ({ text: c, callback_data: "cat_" + c })));
  if (type !== "income") keyboard.push([{ text: "➕ Новая категория", callback_data: "new_category" }]);
  await sendInlineKeyboard(env, chatId, TYPE_LABELS[type] + " — выбери категорию:", keyboard);
}

async function sendAccountKeyboard(env, chatId) {
  const type = await env.KV.get(`type_${chatId}`);
  const from = await env.KV.get(`acc_${chatId}`);
  const keyboard = buildTwoColumnKeyboard((await getAccounts(env)).map(a => ({ text: a, callback_data: "acc_" + a })));
  keyboard.push([{ text: "➕ Новый счет", callback_data: "new_account" }]);
  const prompt = type === "transfer" ? from ? "Куда? Выбери счет поступления:" : "Откуда? Выбери счет списания:"
    : type === "expense" ? "Выбери счет списания:" : "Выбери счет поступления:";
  await sendInlineKeyboard(env, chatId, prompt, keyboard);
}

async function selectAccount(env, chatId, account) {
  const type = await env.KV.get(`type_${chatId}`);
  if (!TYPE_LABELS[type]) return sendTypeMenu(env, chatId);
  const from = await env.KV.get(`acc_${chatId}`);
  if (type === "transfer" && from) {
    await env.KV.put(`to_${chatId}`, account);
    await sendMessage(env, chatId, from + " → " + account + "\nВведи: 100 / 108дол или 100дол / 9500руб. Одна сумма: 100. Можно добавить описание после суммы. Без приписки — евро.");
  } else {
    await env.KV.put(`acc_${chatId}`, account);
    if (type === "transfer") await sendAccountKeyboard(env, chatId);
    else await sendMessage(env, chatId, TYPE_LABELS[type] + " | " + account + "\nВведи сумму и описание: 25 продукты, 500руб продукты, 20лир автобус, 25дол кафе. Без приписки — евро. Плюс не нужен.");
  }
}

// ===== ПАРСЕР =====
function parseMessage(text, type = "expense") {
  if (typeof text !== "string") return null;
  const token = "([0-9]+(?:[.,][0-9]+)?)(руб|лир|дол|€)?";
  const currencies = { руб: "₽", лир: "₺", дол: "$", "€": "€" };
  const pattern = type === "transfer"
    ? new RegExp("^" + token + "(?:\\s*/\\s*" + token + ")?(?:\\s+(.+))?$", "i")
    : new RegExp("^\\+?" + token + "(?:\\s+(.+))?$", "i");
  const match = text.trim().match(pattern);
  if (!match || (type === "transfer" && text.includes("/") && !match[3])) return null;
  const amount = Number(match[1].replace(",", "."));
  const currency = currencies[(match[2] || "").toLowerCase()] || "€";
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const result = { type, amount, currency, description: match[type === "transfer" ? 5 : 3] || "" };
  if (type === "transfer") {
    result.receivedAmount = match[3] ? Number(match[3].replace(",", ".")) : amount;
    result.receivedCurrency = match[3] ? currencies[(match[4] || "").toLowerCase()] || "€" : currency;
    if (!Number.isFinite(result.receivedAmount) || result.receivedAmount <= 0) return null;
  }
  return result;
}

async function saveToSheet(env, data) {
  const response = await fetch(env.SHEET_URL, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
  const body = await response.text();
  if (!response.ok || body.trim() !== "ok") throw new Error("Backend rejected transaction");
}

function formatTransaction(t) {
  if (t.type === "transfer") return TYPE_LABELS.transfer + ": " + t.fromAccount + " → " + t.toAccount +
    "\nСписано: " + t.amount + t.currency + "\nПоступило: " + t.receivedAmount + t.receivedCurrency +
    (t.description ? "\n" + t.description : "");
  return (TYPE_LABELS[t.type] || t.type || "Операция") + ": " + t.amount + t.currency +
    "\n" + t.category + " | " + t.account + (t.description ? "\n" + t.description : "");
}

// ===== TELEGRAM =====
async function sendMessage(env, chatId, text) {
  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [
        ["🧾 Транзакция", "📊 Аналитика"],
        ["📄 Открыть таблицу", "🗑 Удалить категорию"],
        ["🔔 Уведомления", "❌ Отменить мою последнюю транзакцию"]
      ],
      resize_keyboard: true
    }
  });
}

async function callTelegram(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    let body = "";

    try {
      body = await res.text();
    } catch (error) {
      body = error?.message || "could not read response";
    }

    console.error("telegram:api_error", {
      method,
      status: res.status,
      body: body.slice(0, 500)
    });
  }

  return res;
}

// ===== Menu constant =====
async function sendInlineKeyboard(env, chatId, text, keyboard) {
  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

async function sendAnalyticsMenu(env, chatId) {
  await sendInlineKeyboard(env, chatId, "Что показать?", [
    [
      { text: "💸 Расходы", callback_data: "an_expense" },
      { text: "💰 Доходы", callback_data: "an_income" }
    ]
  ]);
}

async function sendPeriodMenu(env, chatId, type) {
  await sendInlineKeyboard(env, chatId, "Период:", [
    [
      { text: "7 дней", callback_data: `period_${type}_7` },
      { text: "Месяц", callback_data: `period_${type}_30` },
      { text: "Год", callback_data: `period_${type}_365` }
    ]
  ]);
}

function generateColors(n) {
  const colors = [];

  for (let i = 0; i < n; i++) {
    const hue = Math.round((360 / n) * i);
    colors.push(`hsl(${hue}, 70%, 60%)`);
  }

  return colors;
}

async function sendChart(env, chatId, labels, values, title) {
  if (values.length === 0) {
    await sendMessage(env, chatId, "Нет данных за выбранный период");
    return;
  }

  const colors = generateColors(values.length);

  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Сумма (€)",
        data: values,
        backgroundColor: colors
      }]
    },
    options: {
      indexAxis: "y",
      plugins: {
        title: {
          display: true,
          text: title
        },
        legend: {
          display: false
        },
        datalabels: {
          anchor: "end",
          align: "center",
          formatter: "__AMOUNT_FORMATTER__"
        }
      },
      scales: {
        xAxes: [{
          scaleLabel: {
            display: true,
            labelString: 'Категории'
          }
        }],
        yAxes: [{
          scaleLabel: {
            display: true,
            labelString: 'Сумма (в евро)'
          }
        }]
      }
    }
  };

  // QuickChart needs executable formatter code; JSON.stringify drops functions.
  const chartString = JSON.stringify(chartConfig).replace(
    '"formatter":"__AMOUNT_FORMATTER__"',
    '"formatter":function(value) { return Number(value).toFixed(0); }'
  );
  const url = "https://quickchart.io/chart?c=" +
    encodeURIComponent(chartString);

  await sendMessage(env, chatId, `Всего: €${values.reduce((a,b)=>a+b,0).toFixed(2)}`);

  await callTelegram(env, "sendPhoto", {
    chat_id: chatId,
    photo: url
  });
}

async function getAnalytics(env, days, type) {
  const res = await fetch(env.SHEET_URL);
  const rows = await res.json();

  console.log("analytics:loaded", {
    days,
    type,
    rows: Array.isArray(rows) ? rows.length : 0
  });

  if (!Array.isArray(rows)) {
    console.log("analytics:invalid_response");
    return { labels: [], values: [] };
  }

  const now = Date.now();
  const filtered = rows.slice(1).filter(r => {
    const date = new Date(r[0]).getTime();
    return Number.isFinite(date) && (now - date) <= days * 86400000 && date <= now && (r[1] === type || (type === "expense" && r[1] === "refund"));
  });

  console.log("analytics:filtered", {
    days,
    type,
    rows: filtered.length
  });

  const map = Object.create(null);

  filtered.forEach(r => {
    const category = r[5];
    const amount = Number(r[4]); // Amount_EUR

    if (!category || !Number.isFinite(amount)) return;

    map[category] = (map[category] || 0) + (r[1] === "refund" ? -amount : amount);
  });

  const sorted = Object.entries(map)
    .sort((a, b) => b[1] - a[1]);

  return {
    labels: sorted.map(x => x[0]),
    values: sorted.map(x => x[1])
  };
}
// ===== PUSH про каждую транзакцию (вкл или выкл) =====
async function isNotifyEnabled(env, userId) {
  const val = await env.KV.get(`notify_${userId}`);
  return val !== "off"; // по умолчанию включено
}

async function toggleNotify(env, userId) {
  const current = await isNotifyEnabled(env, userId);
  await env.KV.put(`notify_${userId}`, current ? "off" : "on");
  return !current;
}
