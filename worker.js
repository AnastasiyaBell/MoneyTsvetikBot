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
    if (request.method !== "POST") return new Response("OK");

    const data = await request.json();

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
      await sendCategoryKeyboard(env, chatId);
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

      await sendInlineKeyboard(env, chatId,
        `Удалить эту транзакцию?\n\n💸 ${data.amount}${data.currency}\n📂 ${data.category}\n💳 ${data.account}\n📝 ${data.description || "-"}`,
        [
          [{ text: "✅ Удалить", callback_data: "undo_last_confirm" }],
          [{ text: "❌ Отмена", callback_data: "cancel" }]
        ]
      );

      return new Response("ok");
    }

    // ===== ОЖИДАНИЕ НОВОЙ КАТЕГОРИИ =====
    const awaiting = await env.KV.get(`await_${chatId}`);

    if (awaiting) {
      const newCategory = text;

      await addCategory(env, newCategory);
      await env.KV.put(`cat_${chatId}`, newCategory);
      await env.KV.delete(`await_${chatId}`);

      await sendMessage(env, chatId, `Новая категория сохранена: ${newCategory}`);
      await sendAccountKeyboard(env, chatId); // 👈 сразу счёт
      return new Response("ok");
    }

    // ===== ПРОВЕРКА ВЫБРАННОЙ КАТЕГОРИИ =====
    const selectedCategory = await env.KV.get(`cat_${chatId}`);

    if (!selectedCategory) {
      //await sendMessage(env, chatId, "Сначала выбери категорию 👇");
      await sendCategoryKeyboard(env, chatId);
      return new Response("ok");
    }

    const awaitingAccount = await env.KV.get(`await_account_${chatId}`);

    if (awaitingAccount) {
      const newAccount = text;

      await addAccount(env, newAccount);
      await env.KV.put(`acc_${chatId}`, newAccount);
      await env.KV.delete(`await_account_${chatId}`);

      await sendMessage(env, chatId, `Счет сохранен: ${newAccount}`);
      return new Response("ok");
    }

    // ===== проверка выбранного счета =====
    const selectedAccount = await env.KV.get(`acc_${chatId}`);

    const parsed = parseMessage(text);

    if (!parsed) {
      await sendMessage(env, chatId, "Пример: 25 лидл");
      return new Response("ok");
    }

    await saveToSheet(env, {
      ...parsed,
      category: selectedCategory,
      account: selectedAccount,
      user: userName
    });

    await sendMessage(
      env,
      chatId,
      `Сохранено: ${parsed.amount}${parsed.currency} → ${selectedCategory} со счета ${selectedAccount}`
    );

    //const userName = USERS[chatId];
    const userIds = Object.keys(USERS);

    for (const id of userIds) {
      if (parseInt(id) === chatId) continue; // не себе

      const notify = await isNotifyEnabled(env, id);
      if (!notify) continue;

      await sendMessage(env, id,
        `💸 ${userName}: ${parsed.amount}${parsed.currency}\n${selectedCategory} | ${selectedAccount}`);
    }

    return new Response("ok");
  }
};

async function sendMainMenu(env, chatId, text = "Выбери действие:") {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    })
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
  const data = callback.data;
  const chatId = callback.message.chat.id;

  if (data === "new_category") {
    await env.KV.put(`await_${chatId}`, "1", { expirationTtl: 300 });
    await sendMessage(env, chatId, "Введи новую категорию:");
    return;
  }

  if (data === "new_account") {
    await env.KV.put(`await_account_${chatId}`, "1", { expirationTtl: 300 });
    await sendMessage(env, chatId, "Введи название счета:");
    return;
  }

  if (data.startsWith("cat_")) {
    const category = data.replace("cat_", "");

    await env.KV.put(`cat_${chatId}`, category);

    await sendMessage(
      env,
      chatId,
      `Выбрана категория: ${category}\nТеперь выбери счет:`
    );

    await sendAccountKeyboard(env, chatId);
    return;
  }

  if (data.startsWith("acc_")) {
    const account = data.replace("acc_", "");

    await env.KV.put(`acc_${chatId}`, account);

    await sendMessage(env, chatId, `Счет: ${account}\nТеперь введи сумму и описание`);
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

    await sendChart(env, chatId, result.labels, result.values, "Аналитика");

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

  if (data === "undo_last_confirm") {
    const userName = USERS[chatId];
    const res = await fetch(env.SHEET_URL + "?deleteLast=" + encodeURIComponent(userName));
    const result = await res.json();

    if (result.status === "deleted") {
      await sendMessage(env, chatId,
        `Удалено ✅\n\n💸 ${result.amount}${result.currency}\n📂 ${result.category}\n💳 ${result.account}`
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
async function sendCategoryKeyboard(env, chatId) {
  const categories = await getCategories(env);

  const keyboard = buildTwoColumnKeyboard(categories.map(c => ({
    text: c,
    callback_data: `cat_${c}`
  })));

  keyboard.push([{ text: "➕ Новая категория", callback_data: "new_category" }]);

  keyboard.push([{ text: "📊 Аналитика", callback_data: "go_analytics" }]);

  await sendInlineKeyboard(env, chatId, "Выбери категорию:", keyboard);
}

async function sendAccountKeyboard(env, chatId) {
  const accounts = await getAccounts(env);

  const keyboard = buildTwoColumnKeyboard(
    accounts.map(a => ({ text: a, callback_data: `acc_${a}` }))
  );

  keyboard.push([{ text: "➕ Новый счет", callback_data: "new_account" }]);

  await sendInlineKeyboard(env, chatId, "Выбери счет:", keyboard);
}

// ===== ПАРСЕР =====
function parseMessage(text) {
  const parts = text.split(" ");

  let rawAmount = parts[0];
  let type = "expense";

  if (rawAmount.startsWith("+")) {
    type = "income";
    rawAmount = rawAmount.replace("+", "");
  }

  let currency = "€";

  if (rawAmount.includes("р")) {
    currency = "₽";
    rawAmount = rawAmount.replace("р", "");
  } else if (rawAmount.includes("лир")) {
    currency = "₺";
    rawAmount = rawAmount.replace("лир", "");
  } else if (rawAmount.includes("€")) {
    currency = "€";
    rawAmount = rawAmount.replace("€", "");
  }

  const amount = parseFloat(rawAmount);
  if (!amount) return null;

  const description = parts.slice(1).join(" "); // 💥 ВСЁ — описание

  return { type, amount, currency, description };
}

// ===== СОХРАНЕНИЕ =====
async function saveToSheet(env, data) {
  await fetch(env.SHEET_URL, {
    method: "POST",
    headers: {
    "Content-Type": "application/json"
  },
    body: JSON.stringify(data)
  });
}

// ===== TELEGRAM =====
async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    })
  });
}
// ===== Menu constant =====
async function sendInlineKeyboard(env, chatId, text, keyboard) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: keyboard
      }
    })
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
          formatter: (value) => value + " €"
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

  const url = "https://quickchart.io/chart?c=" +
    encodeURIComponent(JSON.stringify(chartConfig));

  await sendMessage(env, chatId, `Всего: €${values.reduce((a,b)=>a+b,0).toFixed(2)}`);

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: url
    })
  });
}

async function getAnalytics(env, days, type) {
  const res = await fetch(env.SHEET_URL);
  const rows = await res.json();

  const now = Date.now();
  const filtered = rows.slice(1).filter(r => {
    const date = new Date(r[0]).getTime();
    return (now - date) <= days * 86400000 && r[1] === type;
  });

  const map = {};

  filtered.forEach(r => {
    const category = r[5];
    const amount = r[4]; // Amount_EUR

    map[category] = (map[category] || 0) + amount;
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
