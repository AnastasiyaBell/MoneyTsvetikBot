// ===== Столбцы таблицы =====
// Первые девять столбцов сохраняют прежний порядок.
const BASE_HEADERS = [
  "Date",
  "Type",
  "Amount",
  "Currency",
  "Amount_EUR",
  "Category",
  "Description",
  "Account",
  "User"
];

const EXTRA_HEADERS = [
  "From_Account",
  "To_Account",
  "Transfer_In_Amount",
  "Transfer_In_Currency",
  "Transaction_ID"
];

const HEADERS = BASE_HEADERS.concat(EXTRA_HEADERS);

// ===== Подготовка структуры таблицы =====
// Добавляем столбцы справа, не переписывая исходные столбцы и старые суммы.
function ensureSchema(sheet) {
  if (sheet.getLastRow() === 0) {
    if (sheet.getMaxColumns() < HEADERS.length) {
      sheet.insertColumnsAfter(
        sheet.getMaxColumns(),
        HEADERS.length - sheet.getMaxColumns()
      );
    }

    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return HEADERS.slice();
  }

  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0];

  if (BASE_HEADERS.some((name, i) => headers[i] !== name)) {
    throw new Error("Unexpected column order in " + sheet.getName());
  }

  EXTRA_HEADERS.forEach(name => {
    if (!headers.includes(name)) {
      headers.push(name);

      if (headers.length > sheet.getMaxColumns()) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
      }

      sheet.getRange(1, headers.length).setValue(name);
    }
  });

  return headers;
}

// ===== Добавление столбцов во все ежегодные листы =====
function migrateTransactionColumns() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    getDataSheetsOldestFirst().forEach(ensureSchema);
  } finally {
    lock.releaseLock();
  }
}

// ===== Формирование JSON-ответа =====
function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Сохранение новой операции =====
function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const data = JSON.parse(e.postData.contents);
    const types = ["expense", "income", "transfer", "refund"];
    const currencies = ["€", "₽", "₺", "$"];

    // Проверяем тип, сумму, валюту и обязательные поля.
    if (
      !types.includes(data.type) ||
      !Number.isFinite(data.amount) ||
      data.amount <= 0 ||
      !currencies.includes(data.currency) ||
      !data.account ||
      !data.user
    ) {
      throw new Error("Invalid transaction");
    }

    if (data.type !== "transfer" && !data.category) {
      throw new Error("Category required");
    }

    if (
      data.type === "transfer" &&
      (
        !data.fromAccount ||
        !data.toAccount ||
        !Number.isFinite(data.receivedAmount) ||
        data.receivedAmount <= 0 ||
        !currencies.includes(data.receivedCurrency)
      )
    ) {
      throw new Error("Invalid transfer");
    }

    // Находим лист текущего года и проверяем заголовки всех листов.
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = "Data" + new Date().getFullYear();
    const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    const sheets = getDataSheetsOldestFirst();

    sheets.forEach(ensureSchema);

    // ID обновления Telegram защищает от повторного сохранения.
    // Для клиентов без ID создаём UUID.
    const id = data.transactionId || Utilities.getUuid();

    for (const existing of sheets) {
      const values = existing.getDataRange().getValues();
      const idIndex = values[0].indexOf("Transaction_ID");

      if (values.slice(1).some(row => row[idIndex] === id)) {
        return ContentService.createTextOutput("ok");
      }
    }

    // Собираем значения новой строки по названиям столбцов.
    const headers = ensureSchema(sheet);
    const incoming = data.type === "income" || data.type === "refund";

    const record = {
      Date: new Date(),
      Type: data.type,
      Amount: data.amount,
      Currency: data.currency,
      Amount_EUR: convertToEUR(data.amount, data.currency),
      Category: data.category || "",
      Description: data.description || "",
      Account: data.account,
      User: data.user,
      From_Account: incoming ? "" : data.account,
      To_Account:
        data.type === "transfer"
          ? data.toAccount
          : incoming ? data.account : "",
      Transfer_In_Amount: data.type === "transfer" ? data.receivedAmount : "",
      Transfer_In_Currency: data.type === "transfer" ? data.receivedCurrency : "",
      Transaction_ID: id
    };

    sheet.appendRow(
      headers.map(name => record[name] === undefined ? "" : record[name])
    );

    // Цвет строки зависит от типа операции.
    const colors = {
      income: "#d9f2d9",
      refund: "#fff2cc",
      transfer: "#d9eaf7"
    };

    sheet
      .getRange(sheet.getLastRow(), 1, 1, headers.length)
      .setBackground(colors[data.type] || null);

    return ContentService.createTextOutput("ok");
  } catch (error) {
    return ContentService.createTextOutput("error: " + error.message);
  } finally {
    lock.releaseLock();
  }
}

// ===== Пересчёт суммы в евро =====
function convertToEUR(amount, currency) {
  if (!amount) return "";
  if (currency === "€") return amount;

  try {
    let from = null;

    if (currency === "₽") from = "RUB";
    if (currency === "₺") from = "TRY";
    if (currency === "$") from = "USD";

    if (!from) return amount;

    const rate = getRate(from, "EUR");

    return amount * rate;
  } catch (e) {
    return amount;
  }
}

// ===== Получение и кеширование курса валют =====
function getRate(from, to) {
  const cache = CacheService.getScriptCache();
  const key = `${from}_${to}`;

  const cached = cache.get(key);
  if (cached) return parseFloat(cached);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Rates") || ss.insertSheet("Rates");
  const cell = sheet.getRange("A1");

  cell.setFormula(`=GOOGLEFINANCE("CURRENCY:${from}${to}")`);
  Utilities.sleep(1000);

  const rate = cell.getValue();

  cache.put(key, rate, 21600); // 6 часов

  return rate || 1;
}

// ===== Преобразование строки таблицы в операцию =====
function rowTransaction(row, headers) {
  const field = name => row[headers.indexOf(name)] || "";

  return {
    type: row[1],
    amount: row[2],
    currency: row[3],
    category: row[5],
    description: row[6],
    account: row[7],
    date: row[0],
    fromAccount: field("From_Account"),
    toAccount: field("To_Account"),
    receivedAmount: field("Transfer_In_Amount"),
    receivedCurrency: field("Transfer_In_Currency"),
    transactionId: field("Transaction_ID")
  };
}

// ===== Чтение операций и удаление по ID =====
function doGet(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const sheets = getDataSheetsOldestFirst();
    sheets.forEach(ensureSchema);

    const params = e.parameter || {};

    // Ищем запись пользователя: для просмотра последней или удаления по ID.
    if (params.getLast || params.deleteLast) {
      const user = String(params.getLast || params.deleteLast).trim();

      for (const sheet of sheets.slice().reverse()) {
        const values = sheet.getDataRange().getValues();
        const headers = values[0];

        for (let i = values.length - 1; i > 0; i--) {
          if (String(values[i][8]).trim() !== user) continue;

          const idIndex = headers.indexOf("Transaction_ID");

          if (
            params.transactionId &&
            values[i][idIndex] !== params.transactionId
          ) {
            continue;
          }

          // Старой записи присваиваем ID при первом просмотре.
          if (!values[i][idIndex]) {
            values[i][idIndex] = Utilities.getUuid();
            sheet.getRange(i + 1, idIndex + 1).setValue(values[i][idIndex]);
          }

          const transaction = rowTransaction(values[i], headers);

          if (params.deleteLast) {
            if (!params.transactionId) {
              return jsonOutput({ status: "id_required" });
            }

            const age = Date.now() - new Date(values[i][0]).getTime();

            if (!Number.isFinite(age) || age < 0 || age > 86400000) {
              return jsonOutput({ status: "too_late" });
            }

            sheet.deleteRow(i + 1);

            return jsonOutput({ ...transaction, status: "deleted" });
          }

          return jsonOutput({ ...transaction, status: "found" });
        }
      }

      return jsonOutput({ status: "not_found" });
    }

    // Объединяем ежегодные листы для аналитики.
    const rows = [HEADERS];

    sheets.forEach(sheet => {
      const values = sheet.getDataRange().getValues();
      const headers = values[0];

      values.slice(1).forEach(row => rows.push(
        HEADERS.map(name => row[headers.indexOf(name)] ?? "")
      ));
    });

    return jsonOutput(rows);
  } catch (error) {
    return jsonOutput({ status: "error", message: error.message });
  } finally {
    lock.releaseLock();
  }
}

// ===== Ежегодные листы, от старых к новым =====
function getDataSheetsOldestFirst() {
  return SpreadsheetApp.getActiveSpreadsheet()
    .getSheets()
    .filter(sheet => /^Data\d{4}$/.test(sheet.getName()))
    .sort((a, b) => a.getName().localeCompare(b.getName()));
}
