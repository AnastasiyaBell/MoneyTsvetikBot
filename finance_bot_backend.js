export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;
    const OPENAI_KEY = env.OPENAI_KEY;
    const SHEET_URL = env.SHEET_URL;

    const data = await request.json();

    if (!data.message) return new Response("ok");

    const text = data.message.text;
    const chatId = data.message.chat.id;

    const parsed = parseMessage(text);
    if (!parsed) {
      await sendMessage(chatId, "Пример: 25 лидл карта");
      return new Response("ok");
    }

    const category = await getCategory(parsed.description, OPENAI_KEY);

    // 👉 отправка в Google Sheets через Apps Script
    await fetch(SHEET_URL, {
      method: "POST",
      body: JSON.stringify({
        ...parsed,
        category
      })
    });

    await sendMessage(chatId,
      `Сохранено: ${parsed.amount}${parsed.currency} → ${category}`
    );

    return new Response("ok");

    // ===== FUNCTIONS =====

    function parseMessage(text) {
      const parts = text.split(" ");

      let rawAmount = parts[0];
      let type = "expense";

      if (rawAmount.startsWith("+")) {
        type = "income";
        rawAmount = rawAmount.replace("+", "");
      }

      let currency = "€";

      if (rawAmount.includes("₽")) {
        currency = "₽";
        rawAmount = rawAmount.replace("₽", "");
      } else if (rawAmount.includes("₺")) {
        currency = "₺";
        rawAmount = rawAmount.replace("₺", "");
      } else if (rawAmount.includes("€")) {
        currency = "€";
        rawAmount = rawAmount.replace("€", "");
      }

      const amount = parseFloat(rawAmount);
      if (!amount) return null;

      const payment = parts[parts.length - 1];
      const description = parts.slice(1, -1).join(" ");

      return { type, amount, currency, description, payment };
    }

    async function getCategory(text, apiKey) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: `Категория:
              [Еда, Транспорт, Жилье, Строительно-бытовое, Спорт,
              Дети, Здоровье, Подарки, Техника, Развлечения,
              Путешествия, Другое]

              Ответь одним словом.

              Текст: ${text}`
            }
          ]
        })
      });

      const json = await res.json();
      return json.choices[0].message.content.trim();
    }

    async function sendMessage(chatId, text) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text
        })
      });
    }
  }
};
