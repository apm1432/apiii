# Plans & Pricing (admin) + security fixes

## 1. Admin: Plans & Pricing (new)
Dashboard (admin only) -> **💰 Plans & Pricing**
- change the **price** of any plan, add **unlimited new plans** (max 30), change **duration** (days / months / years),
  optional "old price" (strike-through), badge ("Best Value"), display order, hide / show, delete.
- Students see the new prices immediately (payment page re-reads `/api/plans` every time it opens, and live via SSE `plans` event).
- First start after this update creates the two old plans automatically (`1_month` = ₹50 / 30 days, `2_years` = ₹100 / 2 years), so nothing changes until you edit them.
- Safe by design:
  - price + duration are read from the database on the server; the browser only sends the plan id
  - the plan as it was at payment time is stored on the Razorpay order -> a price change / deletion while someone is paying can never leave a paid student without access
  - old orders created before this update still work (fallback)
  - at least one plan must stay active
  - all admin routes: `/api/admin/plans` (login + `isAdmin` checked in the database, rate limited, input validated)

Files: `models/Plan.js`, `routes/plans.js`, `utils/payments.js`, `public/planadmin.js`, `routes/api.js` (`GET /api/plans`, `create-order`), `public/script.js`, `public/index.html`, `public/style.css`.

## 2. Security fixes
| # | Problem | Fix |
|---|---------|-----|
| 1 | `POST /api/admin/clear-cache` had **no login** - anyone could wipe the server cache again and again | needs admin login **or** header `x-admin-secret` = env `ADMIN_API_SECRET` (`add_exam.py` sends it) |
| 2 | JWT secret had a **default written in the code** | no default any more: random secret (+ warning) if `JWT_SECRET` is missing. **Set `JWT_SECRET` (64+ random chars) in Koyeb.** |
| 3 | Login had **no brute-force limit** | 10 wrong tries / 15 min per IP+email (+ 60 / 15 min per IP) |
| 4 | Login / forgot-password accepted objects (`{"$ne":null}`) = **NoSQL injection** | strings only |
| 5 | Email-OTP password reset: unlimited guesses of the 6-digit OTP, `Math.random`, OTP stored in plain text, tells who is registered | 5 guesses then OTP destroyed, `crypto.randomInt`, stored as SHA-256, rate limits, same answer for known / unknown email, 1 OTP per minute |
| 6 | After a password reset old logins stayed valid | all sessions are logged out |
| 7 | Token in URL (`?token=`) accepted on every route | only GET (live stream + images) |
| 8 | No security headers | nosniff, clickjacking protection, HSTS, referrer, permissions |
| 9 | Raw error pages / stack traces for bad JSON | short JSON errors, JSON 404 for `/api/*` |
| 10 | Optional: `CORS_ORIGINS` env to restrict CORS | not set = same as before |

## 3. Bugs fixed
- **Expired login (7 days) returned HTTP 400** -> the browser treated it as "can never succeed" and **deleted the student's unsent answers**. Now 401 `TOKEN_INVALID` (progress is kept, user is sent to login).
- Pricing cards used CSS class `pricing-card` but the stylesheet only had `price-card` -> cards were unstyled. Fixed.
- `verify-payment` / `initiatePayment`: double-click could open two Razorpay orders; button now locks, real server error shown.
- Month / year plans add real calendar time (31 Jan + 1 month = 28/29 Feb, not 3 Mar).
- `requireSubscription` null-expiry guard.
- `add_exam.py` said "cache refreshed" even when the server refused; it now checks the result.

## Environment variables to set
- `JWT_SECRET` (required for stable logins) - e.g. `openssl rand -hex 32`
- `ADMIN_API_SECRET` (if you use `add_exam.py`) - same value in the server and in your local `.env`
- `CORS_ORIGINS` (optional)

## Not changed (your decision)
- A Content-Security-Policy header was **not** added: the site uses inline scripts + Razorpay and a strict CSP would break it.
- `wapi` (Python) was not modified.
