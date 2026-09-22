# MoneyTsvetikBot

A Telegram bot for tracking personal and shared household finances in Google Sheets. Record an expense or income in a chat, choose its category and account, and review spending summaries without opening a spreadsheet each time.

## What is MoneyTsvetikBot?

Small daily purchases are easy to forget, and keeping a shared spreadsheet up to date takes effort. MoneyTsvetikBot makes recording transactions part of a familiar Telegram conversation while keeping the underlying records available in a spreadsheet you control. Each transaction includes the person who recorded it, which helps a household maintain one shared financial history.

The bot's current interface is in Russian. This guide is in English and includes the Russian button labels where needed.

## Features

- Record expenses and income with an amount and an optional description.
- Choose a category and an account using Telegram buttons; add custom categories and accounts.
- Record euros, Russian rubles, and Turkish lira, with an EUR equivalent calculated by the Google Sheets backend.
- View category totals and bar charts for the last 7, 30, or 365 days, separately for expenses and income.
- Notify other configured users when a transaction is recorded. Notifications are enabled by default and can be toggled individually.
- Preview and delete your most recent transaction within 24 hours of its creation.
- Open the shared spreadsheet directly from the bot menu.
- Store transactions in automatically created annual tabs, such as `Data2026`, and include all annual tabs in analytics.

Accounts are labels for manual bookkeeping; the bot does not connect to banks, import payments, or maintain bank balances.

## How it works

```text
Telegram message or button press
            |
            v
Cloudflare Worker <----> Workers KV
            |            selections, categories, accounts, notification settings
            v
Google Apps Script <----> Google Sheets
            |
            v
Worker replies in Telegram; chart images are requested through QuickChart
```

Telegram delivers updates to the Worker's HTTPS webhook. The Worker handles menus, parses transaction text, and sends transaction data to a Google Apps Script web app. The script appends a timestamped row to the current year's sheet and highlights income rows in green.

For rubles and lira, the backend uses `GOOGLEFINANCE` in a helper tab named `Rates` and caches exchange rates for up to six hours. The converted value is stored when the transaction is recorded; existing rows are not automatically revalued.

For analytics, the Worker reads the annual transaction tabs, filters by date and transaction type, groups `Amount_EUR` by category, and sorts totals from largest to smallest. It sends the total and a QuickChart chart to Telegram. Analytics cover all recorded users and accounts together.

| File | Purpose |
| --- | --- |
| `worker.js` | Telegram webhook, menus, parsing, notifications, and analytics |
| `finance_bot_backend_google_sheets.js` | Google Apps Script backend for storage, currency conversion, and deletion |
| `wrangler.toml` | Worker deployment configuration and KV binding |
| `package.json` | Wrangler dependency and development/deployment commands |

## Installation

You will need Telegram, a Google account, a Cloudflare account, and a supported Node.js LTS installation with npm. Run the terminal commands from the project directory. The Telegram API examples below use PowerShell.

### 1. Create a Telegram bot and obtain its token

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts to choose a display name and a bot username.
3. Save the API token returned by BotFather. You will store it as `TELEGRAM_TOKEN` later.
4. Open your new bot's private chat and send `/start`. It will not reply until deployment is complete.

Treat the token as a password and keep it out of source control. See Telegram's [bot creation guide](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).

### 2. Find the private chat IDs of your users

Before registering a webhook, use Telegram's `getUpdates` endpoint to retrieve the messages sent to the bot:

```powershell
$botToken = Read-Host "Paste your bot token"
$updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getUpdates"
$updates.result | ConvertTo-Json -Depth 10
```

Find `message.chat.id` for each person's private chat. Ask every intended user to message the bot first, then repeat the request if necessary. An empty `result` usually means there are no pending updates; send a fresh message and retry.

`getUpdates` cannot be used while a webhook is active. If you are intentionally reconfiguring an existing bot, remove its webhook first with `deleteWebhook`; this pauses delivery to its existing deployment. See the [Telegram Bot API](https://core.telegram.org/bots/api#getupdates).

Replace the existing entries in `USERS` at the top of `worker.js` with your own IDs and unique display names:

```javascript
const USERS = {
  123456789: "Alice",
  987654321: "Bob"
};
```

Use private chats. The code checks chat IDs, not Telegram usernames. Display names are written to the spreadsheet and used to find a user's last transaction, so keep them unique and stable.

### 3. Create the Google Sheets backend

1. Create a new Google spreadsheet.
2. In that spreadsheet, open **Extensions → Apps Script** to create a script bound to the spreadsheet.
3. Replace the default code in `Code.gs` with the complete contents of `finance_bot_backend_google_sheets.js` and save it.
4. Check the script's time zone in **Project Settings** and the spreadsheet's time zone in its settings; use your intended bookkeeping time zone.
5. Choose **Deploy → New deployment**, select **Web app**, and configure it to execute as **Me** with access for **Anyone**, including callers who are not signed in.
6. Deploy and authorize the script to access your spreadsheet.
7. Copy the deployed web app URL ending in `/exec`. This is your `SHEET_URL`; do not use the editor URL or the testing URL ending in `/dev`.

The Worker needs to call this endpoint without a Google login. If your Google Workspace administrator disables anonymous web apps, this installation requires an account that permits them or changes to the backend's authentication. See Google's [web app deployment documentation](https://developers.google.com/apps-script/guides/web).

Open the `/exec` URL to check it. Before any transactions exist, it should return a JSON array containing the column headers. Do not run `doGet` or `doPost` directly from the Apps Script editor: they expect an HTTP event argument.

You do not need to create data tabs or headers manually. The first saved transaction creates `DataYYYY` with these columns in this exact order:

```text
Date | Type | Amount | Currency | Amount_EUR | Category | Description | Account | User
```

Keep this order and the `DataYYYY` naming convention: the code reads columns by position and discovers annual tabs by name. The `Rates` tab is created when currency conversion needs it.

In `worker.js`, locate the `📄 Открыть таблицу` handler and replace its hardcoded Google Sheets link with your spreadsheet's normal browser URL. Share the spreadsheet with the Google accounts of people who should open it; adding someone to `USERS` does not grant Google Sheets access.

### 4. Install dependencies and configure Cloudflare KV

Download or clone this project, open a terminal in its directory, and run:

```sh
npm install
npx wrangler login
npx wrangler kv namespace create KV
```

Complete Cloudflare login in the browser. Copy the namespace ID printed by the last command into `wrangler.toml`, replacing the repository's existing namespace ID:

```toml
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"
```

Keep the binding name exactly `KV`, because the Worker accesses `env.KV`. You may change the top-level `name` in `wrangler.toml` to your preferred Worker name before deployment. Keep `main = "worker.js"` and the other existing settings. Wrangler commands are documented in the [Cloudflare CLI reference](https://developers.cloudflare.com/workers/wrangler/commands/).

Optionally edit `DEFAULT_CATEGORIES` and `DEFAULT_ACCOUNTS` in `worker.js` before first use. These defaults are copied into KV when first requested; changing the arrays later does not replace lists already stored in KV.

### 5. Deploy and add secrets

Create the Worker deployment:

```sh
npm run deploy
```

Copy the HTTPS Worker URL printed by Wrangler, for example `https://my-finance-bot.my-subdomain.workers.dev`. Then configure the two required secrets, pasting each value at its prompt:

```sh
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put SHEET_URL
```

Use the BotFather token for `TELEGRAM_TOKEN` and the Apps Script `/exec` URL for `SHEET_URL`. Secret commands update the deployed Worker. Do not register the Telegram webhook until both are configured.

Open `https://YOUR_WORKER_URL/?health=1`. Expected response:

```json
{
  "ok": true,
  "hasTelegramToken": true,
  "hasSheetUrl": true,
  "hasKv": true
}
```

This checks whether configuration is present; it does not validate the token or test spreadsheet access.

### 6. Connect Telegram to the Worker

In PowerShell, set the Worker URL and register the webhook. If you opened a new terminal, enter `$botToken = Read-Host "Paste your bot token"` again first.

```powershell
$workerUrl = "https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev"
$webhookBody = @{
  url = $workerUrl
  allowed_updates = @("message", "callback_query")
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
  -ContentType "application/json" `
  -Body $webhookBody

Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getWebhookInfo"
```

Check that registration returns `ok: true` and webhook information shows your Worker URL. Telegram requires an HTTPS webhook; the deployed Worker URL provides one. See [setWebhook](https://core.telegram.org/bots/api#setwebhook).

### 7. Verify the full workflow

1. Send `/start` in an authorized private chat.
2. Tap **🧾 Транзакция** (Transaction), choose a category, and choose an account.
3. Send `1 setup test`.
4. Open your spreadsheet and confirm a row exists in the current year's `DataYYYY` tab.
5. Open **📊 Аналитика** (Analytics), choose **💸 Расходы** (Expenses), and select **7 дней** (7 days).
6. Use **❌ Отменить мою последнюю транзакцию** (Undo my last transaction) and confirm deletion to remove the test row.

If several users are configured, have each start the bot and check that another person's new transaction triggers a notification.

## Daily use

Choose a category and account, then send the amount first, followed by an optional description:

| Message | Result |
| --- | --- |
| `25 groceries` | EUR 25 expense |
| `12.50 coffee and lunch` | EUR 12.50 expense |
| `20€ transport` | EUR 20 expense |
| `500руб groceries` | RUB 500 expense |
| `200лир bus tickets` | TRY 200 expense |
| `+2500 salary` | EUR 2,500 income |
| `+1000руб refund` | RUB 1,000 income |

Use a decimal point, no thousands separators, and attach currency suffixes directly to the number. Use the Cyrillic suffixes `руб` and `лир` exactly as shown. A leading `+` marks income; an amount without it is treated as an expense. Enter positive amounts; zero is rejected. The parser is simple and does not strictly validate malformed amounts, so avoid comma decimals and unsupported currency notation.

Your selected category and account remain active for subsequent messages. Choose **🧾 Транзакция** again to change them. Always finish selecting an account before sending an amount: the current code does not enforce that an account was selected.

- **➕ Новая категория / ➕ Новый счёт**: add a shared category or account. Enter its name within five minutes. Keep names short because they are included in Telegram button callback data.
- **🗑 Удалить категорию**: delete a custom category after confirmation. Default categories are excluded from this menu; existing spreadsheet rows are retained.
- **🔔 Уведомления**: turn notifications about other users' transactions on or off for your chat.
- **❌ Отменить мою последнюю транзакцию**: preview and delete your latest record if it is no more than 24 hours old. Avoid adding another transaction between preview and confirmation: deletion looks up the latest record again.
- **📊 Аналитика**: select income or expenses, then 7 days, month, or year. Month and year mean rolling 30- and 365-day windows.

## Troubleshooting and maintenance

| Symptom | What to check |
| --- | --- |
| No reply | Check `getWebhookInfo`, the deployed Worker URL, and `TELEGRAM_TOKEN`; confirm the user started the bot. |
| `У тебя нет доступа` (Access denied) | Add the private chat's numeric ID to `USERS` and redeploy. |
| Bot says saved, but no spreadsheet row appears | Check the Apps Script execution history, deployment access, and `SHEET_URL`. The Worker currently does not validate the save response before confirming success. |
| Analytics are empty or fail | Open the backend `/exec` URL and check its JSON response, annual tab names, column order, dates, and numeric `Amount_EUR` values. |
| EUR totals look wrong | Inspect the `Rates` tab and stored `Amount_EUR` values. Conversion has limited error handling and can fall back to the original amount when it fails. |
| Edited Apps Script code has no effect | Update the web app deployment to a new script version through **Deploy → Manage deployments**. If its URL changes, update `SHEET_URL`. |

To inspect Worker logs:

```sh
npx wrangler tail
```

Worker failures may still return HTTP `200` to Telegram, so successful webhook delivery alone does not prove that an operation succeeded. Verify spreadsheet records when diagnosing save problems.

After changing `worker.js` or `wrangler.toml`, run `npm run deploy` again. For local development, `npm run dev` starts Wrangler's development server. Local secrets can be supplied in an untracked `.dev.vars` file containing `TELEGRAM_TOKEN` and `SHEET_URL`; add that file to your Git ignore rules before creating it. Local development is not a replacement for the public HTTPS deployment used by Telegram.

## Current implementation limits

The current access checks are incomplete: ordinary messages are checked against `USERS`, but callback handlers do not repeat that check, and the Worker does not verify Telegram's webhook secret header. The Apps Script endpoint also has no application-level authentication: anyone with its URL can read records, submit transactions, or request deletion. These are properties of the current implementation, not access protection provided by storing the URL as a Worker secret.

Chart category names and aggregated amounts are sent to QuickChart for image rendering. The project has no update deduplication or retry queue for failed spreadsheet writes. It is a small manual bookkeeping tool; stronger authentication and delivery guarantees require code changes.
