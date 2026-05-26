function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const year = new Date().getFullYear();
    const sheetName = "Data" + year;

    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);

      sheet.appendRow([
        "Date",
        "Type",
        "Amount",
        "Currency",
        "Amount_EUR",
        "Category",
        "Description",
        "Account",
        "User"
      ]);
    }

    const amountEUR = convertToEUR(data.amount, data.currency);

    sheet.appendRow([
      new Date(),
      data.type,
      data.amount,
      data.currency,
      amountEUR,
      data.category,
      data.description,
      data.account,
      data.user
    ]);

    const lastRow = sheet.getLastRow();

    // если доход → красим строку
    if (data.type === "income") {
      sheet.getRange(lastRow, 1, 1, 9) // 8 колонок
        .setBackground("#d9f2d9"); // светло-зелёный
    }

    return ContentService.createTextOutput("ok");

  } catch (e) {
    return ContentService.createTextOutput("error: " + e);
  }
}

// ===== курс валют =====
/*function convertToEUR(amount, currency) {
  if (!amount) return "";

  if (currency === "€") return amount;

  try {
    let pair = null;

    if (currency === "₽") pair = "RUB-EUR";
    if (currency === "₺") pair = "TRY-EUR";

    if (!pair) return amount;

    const url = `https://www.google.com/finance/quote/${pair}`;
    const html = UrlFetchApp.fetch(url).getContentText();

    const match = html.match(/data-last-price="([0-9.]+)"/);

    if (match && match[1]) {
      return amount * parseFloat(match[1]);
    }

    return amount;

  } catch (e) {
    return amount;
  }
}*/

function convertToEUR(amount, currency) {
  if (!amount) return "";

  if (currency === "€") return amount;

  try {
    let from = null;

    if (currency === "₽") from = "RUB";
    if (currency === "₺") from = "TRY";

    if (!from) return amount;

    const rate = getRate(from, "EUR");

    return amount * rate;

  } catch (e) {
    return amount;
  }
}

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

// ===== For getting information from the table for a chart =====
function doGet(e) {

  if (e.parameter.getLast) {
    const user = e.parameter.getLast;

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const data = sheet.getDataRange().getValues();

    for (let i = data.length - 1; i > 0; i--) {
      const rowUser = data[i][8]; // User

      if (rowUser.toString().trim() === user.toString().trim()) {
        return ContentService
          .createTextOutput(JSON.stringify({
            status: "found",
            amount: data[i][2],
            currency: data[i][3],
            category: data[i][5],
            description: data[i][6],
            account: data[i][7],
            date: data[i][0]
          }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "not_found" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.deleteLast) {
    const user = e.parameter.deleteLast;

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const data = sheet.getDataRange().getValues();

    for (let i = data.length - 1; i > 0; i--) {
      const rowUser = data[i][8]; // User
      const date = new Date(data[i][0]); // Date

      if (rowUser.toString().trim() === user.toString().trim()) {
        const diff = Date.now() - date.getTime();

        if (diff <= 86400000) {
          const deletedRow = data[i];

          sheet.deleteRow(i + 1);

          return ContentService
            .createTextOutput(JSON.stringify({
              status: "deleted",
              amount: deletedRow[2],
              currency: deletedRow[3],
              category: deletedRow[5],
              description: deletedRow[6],
              account: deletedRow[7]
            }))
            .setMimeType(ContentService.MimeType.JSON);

        } else {
          return ContentService
            .createTextOutput(JSON.stringify({ status: "too_late" }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "not_found" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets().pop(); // последний год

  const data = sheet.getDataRange().getValues();

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);

}
