# WedPlan API

Express and MongoDB API for the WedPlan wedding-services marketplace. The client application is maintained separately at https://github.com/srutinokrak/wedora-client.

## Requirements

- Node.js and npm
- MongoDB connection string
- Stripe test-mode secret key for Premium Checkout
- The Better Auth client URL for validating user sessions

## Run locally

```bash
npm install
```

Copy `.env.example` to `.env` and set the values locally. Never commit `.env`.

```bash
npm run dev
```

The API listens on `http://localhost:5000` by default.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string for the `wedora` database |
| `DB_USER`, `DB_PASSWORD` | Legacy local connection fallback; prefer `MONGODB_URI` |
| `PORT` | Optional API port; defaults to `5000` |
| `STRIPE_SECRET_KEY` | Stripe test-mode secret key; server only |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret; server only |
| `APP_URL` | Client origin used for Checkout success/cancel URLs |
| `BETTER_AUTH_URL` | Client origin used to validate Better Auth sessions |

The client also needs `BETTER_AUTH_DB_URI`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_IMGBB_API_KEYS`, `WEDORA_API_URL`, and `NEXT_PUBLIC_WEDORA_API_URL`. See the client README for local setup.

## Premium subscription and webhooks

Premium costs $29 USD per month. The API creates a Stripe Checkout subscription only for the authenticated vendor. It saves a pending transaction before returning the Checkout URL. **The success page can't activate Premium**; only a verified webhook can mark the transaction paid and enable the vendor subscription.

The API verifies Stripe's `stripe-signature` against the raw request body before processing events. Configure these events at `https://wedora-server-nine.vercel.app/`:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

For local development, run this command in another terminal and set the printed signing secret as `STRIPE_WEBHOOK_SECRET` in the server `.env`:

```powershell
stripe listen --events "checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed" --forward-to http://localhost:5000/stripe/webhook
```

The vendor can cancel Premium from the subscription dashboard. Cancellation takes effect at the end of the current billing period; deletion or failed renewal events remove Premium access. Use a real Checkout flow initiated from WedPlan when testing because webhook events must match an existing server transaction.

## Repositories and deployment

- Client: https://github.com/srutinokrak/wedora-client
- Server: https://github.com/srutinokrak/wedora-server
- Live website: https://wedora-client-five.vercel.app/
- Live API: https://wedora-server-nine.vercel.app/

Deploy the API and client separately. Set production environment variables in each host's secret settings, and register the production webhook endpoint in Stripe.
