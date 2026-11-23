# WedPlan server configuration

Copy `.env.example` to `.env` and provide the MongoDB credentials, Stripe test secret key, Stripe webhook signing secret, and client application URLs. Keep `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` only in the server environment; do not prefix them with `NEXT_PUBLIC_` or expose them in browser code.

## Premium payment

Premium is a one-time $29 USD payment. The client sends the displayed amount to the server, and the server accepts only the configured $29 amount before creating Stripe Checkout with inline price data. No Stripe Product or Price ID is required. The Stripe publishable key is not needed for the hosted Checkout redirect.

After Checkout, the success page asks the server to retrieve the Checkout Session from Stripe. The server verifies the completed payment, amount, and vendor ownership before responding. Stripe also sends a signed webhook, which independently verifies the event before updating Premium and transaction status. A success URL alone never grants access.

Configure a Stripe webhook endpoint to send these events to `https://YOUR_SERVER_HOST/stripe/webhook`:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

Set the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET` on the server. For local testing, Stripe CLI can forward events with `stripe listen --forward-to localhost:5000/stripe/webhook`; use the signing secret printed by that CLI command in the server's local environment.

Premium is a one-time lifetime payment, not a recurring subscription, so subscription cancellation and renewal expiration do not apply. Unpaid Checkout sessions are marked expired or failed by webhook events.
