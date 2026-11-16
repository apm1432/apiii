# Main bot: name in the logs + "server restarted" message on Telegram

Only `admin_bot.js` changed. "Main bot" = the first token in `TELEGRAM_BOT_TOKENS` (the admin bot; the other tokens only store/mirror images).

## Logs
At startup (Koyeb / container logs):
```
🤖 Main bot: <Bot name> (@username) · id 123 · 3 bot token(s) configured (#1 = main bot)
✅ Main bot <Bot name> (@username) is online (polling started)
📨 Restart message sent to admin <ADMIN_TG_ID> via <Bot name> (@username)
```
If `getMe` fails the log says the main bot name is unknown and to check the first token.

## Telegram message
When this instance gets the polling lock (i.e. it really serves the bot - during a redeploy that is the moment the old
instance has stopped) the admin (`ADMIN_TG_ID`) receives:
```
♻️ Server restarted
🤖 Bot: <Bot name> (@username)
🕒 16 Nov 2026, 11:29:06 am IST
🖥 Instance: <hostname>
✅ Admin bot is online. Send /menu to open the dashboard.
```
Sent once per process start (not again if the lock is lost and regained). `BOT_RESTART_NOTICE=0` turns it off.
The admin must have pressed /start on the bot at least once (Telegram rule), otherwise the log shows the reason.
