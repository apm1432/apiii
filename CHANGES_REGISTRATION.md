# Registration: Gmail + Email OTP / Telegram verification + 1 day free access

## Flow
1. User enters Gmail + own password, chooses **Email OTP** or **Telegram**.
2. Email OTP: 6-digit OTP (hashed, 10 min, 5 attempts, resend after 60s). If SMTP fails -> page auto-switches to Telegram.
3. Telegram: website shows button -> `https://t.me/<bot>?start=<16-char token>` -> bot `/start <token>` verifies, creates the user, sends welcome message (User ID = email; password = the one user chose).
4. Browser polls `/api/auth/register/status/:token` and shows "Registered" automatically.
5. New user gets `isSubscribed=true`, `subscriptionPlan='1_day_trial'`, expiry = now + 24h (existing subscription checks work unchanged).

## Anti-spam
- Only `@gmail.com`; dots and `+alias` ignored for uniqueness (`emailNormalized` unique index).
- `telegramId` unique index -> one Telegram account = one registration.
- Rate limits on register routes, OTP attempts capped, pending registrations auto-expire (15 min TTL).
- Passwords are stored only as bcrypt hashes (also while pending).
- Old `POST /api/auth/register` is disabled (returns 410) so verification can't be bypassed.

## Env (optional)
- `SITE_URL` - used in welcome messages (default https://apiii-apm1432.koyeb.app)
- `TELEGRAM_BOT_USERNAME` - only if `getMe` fails; normally auto-detected.

## Files
New: `utils/gmail.js`, `utils/registration.js`, `models/PendingRegistration.js`
Changed: `routes/auth.js`, `admin_bot.js`, `models/User.js`, `public/index.html`, `public/script.js`
