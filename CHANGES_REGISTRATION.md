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

---
## Update 2: repeat-registration guard, old-account recovery, forgot password via Telegram

### Hidden device check (`utils/deviceGuard.js`, `models/DeviceLog.js`)
- Signals: `deviceId` (localStorage), `mpsc_did` httpOnly cookie, IP (weak).
- 3rd registration from the same device/cookie (2 earlier accounts) => **Email OTP AND Telegram both compulsory** (email first, then Telegram; no SMTP-fallback for these users).
- Same IP with 5+ registrations in 24h => same rule (high number because mobile users share IPs).
- Tune with env: `BOTH_VERIFY_AFTER` (default 2), `IP_BOTH_VERIFY_AFTER` (default 5).
- If the device already has an account, the register page shows: "✈️ Telegram: get my User ID" (bot sends the User ID linked to that Telegram) and "📧 Send User ID to Email" (goes ONLY to emails of accounts created from that device; masked in the reply; 3/hour per IP, 10 min per email).
- Passwords are hashed, so the old password is never shown - users are pointed to Forgot Password.

### Forgot password via Telegram (`models/AuthRequest.js`)
- Login page -> Forgot Password -> "Reset via Telegram" -> enter email + new password -> button opens `t.me/<bot>?start=<token>` -> bot sets the new password and logs out old sessions.
- Account already linked to a Telegram: only that Telegram account can finish.
- Account registered by email (no Telegram yet): **email OTP is compulsory first**, then the Telegram account that opens the link gets linked to the account.
- Token prefixes: `r` registration, `p` password reset, `v` recover old account.

### New / changed files
New: models/DeviceLog.js, models/AuthRequest.js, utils/deviceGuard.js
Changed: routes/auth.js, admin_bot.js, utils/registration.js, models/PendingRegistration.js, public/index.html, public/script.js
